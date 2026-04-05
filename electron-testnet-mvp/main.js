/**
 * Synorix Testnet MVP — ana süreç
 *
 * - Yeni başlatmada wipeMvpDatadirOrThrow() (tüm datadir + synorix.conf)
 * - synorix.conf her başlatmada zorla yazılır; -conf/-testnet/-datadir ile spawn; waitForRPCReady (40s + 120s tavan) → rpcReady
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Sabitler
// ---------------------------------------------------------------------------

const SYNORIX_RELEASES_URL = 'https://github.com/Synorixz/synorix/releases';
const CONFIG_NAME = 'synorix-testnet-mvp-config.json';
const SYNORIX_CONF_NAME = 'synorix.conf';

/** Yerel testnet — düğüm ve CLI aynı kimlik (synorix.conf ile de eşlenir). */
const FIXED_RPC_USER = 'synorix';
const FIXED_RPC_PASSWORD = 'SynorixTest2026!';

const HEALTH_POLL_INTERVAL_MS = 3000;

/** waitForRPCReady: önce sabit bekleme, sonra yoklama; toplam üst süre (başlangıçtan itibaren, uyku dahil). */
const RPC_READY_INITIAL_SLEEP_MS = 40000;
const RPC_READY_POLL_MS = 2000;
/** 40 sn uyku sonrası kalan süre de dahil: toplam ~4 dk */
const RPC_READY_MAX_WAIT_MS = 240000;

const MSG_RPC_PREPARING_RETRY = 'RPC hazırlanıyor, lütfen 10 saniye daha bekleyin.';
const MSG_RPC_CONN_FAILED =
  'RPC bağlantısı kurulamadı. Node\'u durdurup tekrar başlatın.';
/** IPC/Win konsolda bozulmayi onlemek icin ASCII (Turkce UI renderer'da ayri gosterilebilir). */
const MSG_RPC_TIMED_OUT =
  'RPC timed out. Close synorixd in Task Manager if needed, then click Start node again.';

const ERR_BINARIES_NOT_FOUND =
  "synorix-cli ve synorixd bulunamadı. build/bin klasörünü seçin veya binary'leri uygulama yanına koyun.";
const ERR_WSL_NOT_AVAILABLE =
  'WSL kullanılamıyor veya dağıtım kapalı. `wsl -l -v` ile kontrol edin; Ubuntu kurulu ve çalışır olmalı.';
const ERR_WSL_BINARIES_NOT_FOUND =
  'WSL içinde synorixd / synorix-cli bulunamadı veya çalıştırılamıyor. Yolları synorix-testnet-mvp-config.json içinde (wslSynorixdPath, wslSynorixCliPath) düzenleyin.';

const WSL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');

const DEFAULT_WSL_DISTRO = 'Ubuntu';
const DEFAULT_WSL_SYNORIXD = '/home/synorix/synorix/build/bin/synorixd';
const DEFAULT_WSL_SYNORIX_CLI = '/home/synorix/synorix/build/bin/synorix-cli';
const DEFAULT_WSL_DATADIR = '/home/synorix/SynorixTestnetData';

const MSG_NODE_NOT_READY =
  'Node henüz hazır değil. Lütfen 30 saniye daha bekleyin veya “Testnet node’u başlat” ile yeniden deneyin.';
const MSG_WARMUP_RPC = 'RPC henüz hazırlanıyor; kısa süre sonra tekrar deneyin.';
const MSG_RPC_OFFLINE = 'Düğüme bağlanılamıyor. Node çalışıyor mu kontrol edin; gerekirse node’u durdurup uygulamadan yeniden başlatın.';

const possibleNames = ['synorix-cli.exe', 'synorix-cli', 'synorixd.exe', 'synorixd'];
const POSSIBLE_CLI_NAMES = possibleNames.slice(0, 2);
const POSSIBLE_DAEMON_NAMES = possibleNames.slice(2, 4);

// ---------------------------------------------------------------------------
// Global durum
// ---------------------------------------------------------------------------

let mainWindow = null;
let nodeProcess = null;
let nodeHealthTimer = null;

// ---------------------------------------------------------------------------
// Kullanıcıya gösterilecek mesaj (stack / uzun stderr yok)
// ---------------------------------------------------------------------------

function toUserMessage(err) {
  const raw = String(err?.message || err || '');
  const first = raw.split('\n')[0].trim();
  const t = first.toLowerCase();

  if (
    t.includes('could not connect') ||
    t.includes('connection refused') ||
    t.includes('econnrefused') ||
    t.includes('eof') ||
    t.includes('timeout on transient') ||
    t.includes('could not locate rpc credentials') ||
    t.includes('rpc credentials') ||
    t.includes('incorrect rpcuser') ||
    t.includes('authorization failed')
  ) {
    return MSG_RPC_OFFLINE;
  }
  if (t.includes('verifying block') || t.includes('error code: -28') || t.includes('in warmup')) {
    return MSG_WARMUP_RPC;
  }
  if (t.includes('synorixd zaten') || t.includes('zaten calisiyor')) {
    return 'synorixd zaten çalışıyor. Önce “Node’u durdur” deyin veya Görev Yöneticisi’nden kapatın.';
  }
  if (t.includes('pid') && t.includes('alamadi')) {
    return 'synorixd başlatılamadı. Visual C++ runtime, antivirüs veya datadir izinlerini kontrol edin.';
  }
  if (t.includes('stop rpc')) {
    return 'Düğüm durdurulamadı. Görev Yöneticisi’nden synorixd’i kapatmayı deneyin.';
  }
  if (t.includes('not recognized as an internal or external command')) {
    return 'synorix-cli çalıştırılamadı. Windows’ta tam yol `...\\synorix-cli.exe` olmalı; build\\bin\\Release içinde derleyin veya Binary klasörünü seçin.';
  }
  if (first.length > 200) {
    if (first.includes('çıkış kodu') || first.includes('Ayrıntı')) {
      return first.length > 900 ? `${first.slice(0, 897)}…` : first;
    }
    return `${first.slice(0, 197)}…`;
  }
  if (first) return first;
  return 'Beklenmeyen bir hata oluştu.';
}

function ipcThrowUser(err) {
  throw new Error(toUserMessage(err));
}

// ---------------------------------------------------------------------------
// Config / datadir / synorix.conf
// ---------------------------------------------------------------------------

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_NAME);
}

function mergeConfigDefaults(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    synorixdPath: c.synorixdPath || '',
    synorixCliPath: c.synorixCliPath || '',
    synorixBinDir: c.synorixBinDir || '',
    useWsl: c.useWsl !== false,
    wslDistro: (c.wslDistro && String(c.wslDistro).trim()) || DEFAULT_WSL_DISTRO,
    wslSynorixdPath: (c.wslSynorixdPath && String(c.wslSynorixdPath).trim()) || DEFAULT_WSL_SYNORIXD,
    wslSynorixCliPath: (c.wslSynorixCliPath && String(c.wslSynorixCliPath).trim()) || DEFAULT_WSL_SYNORIX_CLI,
    wslDatadir: (c.wslDatadir && String(c.wslDatadir).trim()) || DEFAULT_WSL_DATADIR,
  };
}

function loadConfig() {
  try {
    return mergeConfigDefaults(JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch {
    return mergeConfigDefaults({});
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(mergeConfigDefaults(cfg), null, 2), 'utf8');
}

function getDatadir() {
  if (useWslNodeMode()) {
    return loadConfig().wslDatadir || DEFAULT_WSL_DATADIR;
  }
  if (process.platform === 'win32') {
    const drive = process.env.SystemDrive || 'C:';
    return path.join(drive, 'SynorixTestnetData');
  }
  return path.join(os.homedir(), 'SynorixTestnetData');
}

function ensureDatadir() {
  const d = getDatadir();
  if (useWslNodeMode()) {
    try {
      execFileSync(WSL_EXE, ['-d', getWslDistroName(), '-e', 'mkdir', '-p', d], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      throw new Error('WSL veri klasörü oluşturulamadı. Dağıtım adını ve wslDatadir yolunu kontrol edin.');
    }
    return d;
  }
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function getMvpConfPath() {
  if (useWslNodeMode()) {
    return linuxPathJoin(getDatadir(), SYNORIX_CONF_NAME);
  }
  return path.normalize(path.join(getDatadir(), SYNORIX_CONF_NAME));
}

/**
 * synorix.conf — her başlatmada zorla yeniden yazılır.
 * RPC ayarları [test] altında (-testnet ile eşleşir; üst seviye rpc* bazı çekirdeklerde testnette yok sayılır).
 * Windows: daemon=1 yok (ön planda süreç + PID takibi).
 * Unix: sonda daemon=1.
 */
function ensureSynorixConf() {
  ensureDatadir();
  const confPath = getMvpConfPath();
  const head = ['server=1', 'txindex=1'];
  if (!isWin() || useWslNodeMode()) {
    head.push('daemon=1');
  }
  const body = [
    ...head,
    '',
    '[test]',
    `rpcuser=${FIXED_RPC_USER}`,
    `rpcpassword=${FIXED_RPC_PASSWORD}`,
    'rpcallowip=127.0.0.1',
    'rpcbind=127.0.0.1',
    'rpcport=18332',
    '',
  ].join('\n');
  if (useWslNodeMode()) {
    const distro = getWslDistroName();
    const winTmp = path.join(os.tmpdir(), `synorix-mvp-${Date.now()}-${Math.random().toString(16).slice(2)}.conf`);
    fs.writeFileSync(winTmp, body, 'utf8');
    const wslTmp = windowsPathToWslPath(winTmp);
    const sh = `mkdir -p ${wslShSingleQuote(getDatadir())} && cp ${wslShSingleQuote(wslTmp)} ${wslShSingleQuote(confPath)}`;
    try {
      execFileSync(WSL_EXE, ['-d', distro, '-e', 'sh', '-c', sh], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      try {
        fs.unlinkSync(winTmp);
      } catch {
        /* yoksay */
      }
      throw new Error('synorix.conf WSL tarafına yazılamadı.');
    }
    try {
      fs.unlinkSync(winTmp);
    } catch {
      /* yoksay */
    }
    return;
  }
  fs.writeFileSync(confPath, body, 'utf8');
}

function ensureRpcEnvironment() {
  ensureDatadir();
  ensureSynorixConf();
}

/** MVP veri kökünü (SynorixTestnetData) tamamen sil, yeniden oluştur, synorix.conf yaz. */
function wipeMvpDatadirOrThrow() {
  if (useWslNodeMode()) {
    const root = String(getDatadir()).replace(/\/+$/, '') || DEFAULT_WSL_DATADIR;
    const distro = getWslDistroName();
    try {
      execFileSync(WSL_EXE, ['-d', distro, '-e', 'rm', '-rf', root], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      throw new Error('Synorix veri klasörü (WSL) tamamen temizlenemedi.');
    }
    execFileSync(WSL_EXE, ['-d', distro, '-e', 'mkdir', '-p', root], {
      windowsHide: true,
      stdio: 'ignore',
    });
    ensureSynorixConf();
    return;
  }
  const root = path.normalize(getDatadir());
  try {
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } catch {
    throw new Error('Synorix veri klasörü tamamen temizlenemedi.');
  }
  fs.mkdirSync(root, { recursive: true });
  ensureSynorixConf();
}

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

function isWin() {
  return process.platform === 'win32';
}

/** Windows’ta WSL içindeki Linux binary’leri + Linux datadir kullan. */
function useWslNodeMode() {
  return isWin() && loadConfig().useWsl !== false;
}

function getWslDistroName() {
  return loadConfig().wslDistro || DEFAULT_WSL_DISTRO;
}

function linuxPathJoin(dir, name) {
  const d = String(dir || '').replace(/\/+$/, '');
  const n = String(name || '').replace(/^\/+/, '');
  return `${d}/${n}`;
}

/** Örn. \\wsl$\Ubuntu\home\synorix\foo */
function linuxPathToWslUnc(distro, linuxPath) {
  const rel = String(linuxPath || '').replace(/^\/+/, '').replace(/\//g, '\\');
  return `\\\\wsl$\\${distro}\\${rel}`;
}

/** C:\Users\a\b -> /mnt/c/Users/a/b */
function windowsPathToWslPath(winPath) {
  const n = path.normalize(winPath);
  const m = n.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!m) return n.replace(/\\/g, '/');
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

function wslShSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** wsl.exe argv parçaları: -d Distro -e /bin/synorix-cli …synorixArgs */
function wslSpawnArgs(linuxExecutable, synorixArgs) {
  return ['-d', getWslDistroName(), '-e', linuxExecutable, ...synorixArgs];
}

function wslAvailableAsync() {
  return new Promise((resolve) => {
    if (!fs.existsSync(WSL_EXE)) {
      resolve(false);
      return;
    }
    execFile(
      WSL_EXE,
      ['-d', getWslDistroName(), '-e', 'true'],
      { windowsHide: true, timeout: 20000 },
      (err) => resolve(!err),
    );
  });
}

function wslTestExecutableAsync(linuxPath) {
  return new Promise((resolve) => {
    execFile(
      WSL_EXE,
      ['-d', getWslDistroName(), '-e', 'test', '-x', linuxPath],
      { windowsHide: true, timeout: 20000 },
      (err) => resolve(!err),
    );
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fileExistsExecutable(p) {
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return false;
    if (process.platform !== 'win32') {
      try {
        fs.accessSync(p, fs.constants.X_OK);
      } catch {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Windows: yol .exe ile bitmiyorsa ve synorix-cli.exe varsa onu kullan (CreateProcess / spawn icin). */
function ensureWindowsExeExtension(p) {
  if (!isWin() || !p || typeof p !== 'string') return p;
  const s = path.normalize(path.resolve(p.trim()));
  if (s.toLowerCase().endsWith('.exe')) {
    return s;
  }
  const withExe = `${s}.exe`;
  if (fileExistsExecutable(withExe)) {
    return withExe;
  }
  return s;
}

function getPossibleSearchPaths(hintDir) {
  const roots = [];
  const add = (p) => {
    if (!p || typeof p !== 'string') return;
    let resolved;
    try {
      resolved = path.resolve(p);
    } catch {
      return;
    }
    if (!roots.includes(resolved)) roots.push(resolved);
  };

  if (hintDir) {
    try {
      if (fs.existsSync(hintDir) && fs.statSync(hintDir).isDirectory()) add(hintDir);
    } catch {
      /* yok say */
    }
  }

  if (isWin()) {
    add(path.join(__dirname, '..', 'build', 'bin', 'Release'));
    add(path.join(__dirname, '..', 'build', 'bin', 'Debug'));
    add(path.join(__dirname, '..', '..', 'build', 'bin', 'Release'));
    add(path.join(__dirname, '..', '..', 'build', 'bin', 'Debug'));
  }
  add(path.join(__dirname, '../build/bin'));
  add(path.join(__dirname, '../../build/bin'));
  add(path.join(__dirname, '../../../build/bin'));

  const cfg = loadConfig();
  if (cfg.synorixBinDir) {
    try {
      if (fs.existsSync(cfg.synorixBinDir) && fs.statSync(cfg.synorixBinDir).isDirectory()) {
        add(cfg.synorixBinDir);
      }
    } catch {
      /* yok say */
    }
  }

  add(__dirname);
  add(path.join(__dirname, 'bin'));

  if (app.isPackaged) {
    add(path.dirname(process.execPath));
    if (process.resourcesPath) {
      add(path.join(process.resourcesPath, 'bin'));
      add(process.resourcesPath);
    }
  } else {
    const exeDir = path.dirname(process.execPath);
    const base = path.basename(process.execPath).toLowerCase();
    if (!base.includes('electron')) {
      add(exeDir);
      add(path.join(exeDir, 'bin'));
    }
  }

  return roots;
}

function findFirstInDirectory(dir, names) {
  if (!dir) return null;
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  for (const name of names) {
    const p = path.join(dir, name);
    if (fileExistsExecutable(p)) return path.resolve(p);
  }
  return null;
}

function findFirstByPathsAndNames(roots, names) {
  for (const root of roots) {
    const hit = findFirstInDirectory(root, names);
    if (hit) return hit;
  }
  return null;
}

function resolveSynorixCli(hintPath) {
  if (useWslNodeMode()) {
    const cfg = loadConfig();
    const fromHint = hintPath && typeof hintPath === 'string' ? hintPath.trim() : '';
    const p = fromHint || cfg.synorixCliPath || cfg.wslSynorixCliPath || '';
    return p ? p : null;
  }
  const hintRaw = hintPath && typeof hintPath === 'string' ? path.resolve(hintPath.trim()) : '';
  const hint = hintRaw ? ensureWindowsExeExtension(hintRaw) : '';
  if (hint && fileExistsExecutable(hint)) return hint;
  const hintDir = hintRaw ? path.dirname(hintRaw) : '';
  const found = findFirstByPathsAndNames(getPossibleSearchPaths(hintDir), POSSIBLE_CLI_NAMES);
  return found ? ensureWindowsExeExtension(found) : null;
}

function resolveSynorixd(hintPath) {
  if (useWslNodeMode()) {
    const cfg = loadConfig();
    const fromHint = hintPath && typeof hintPath === 'string' ? hintPath.trim() : '';
    const p = fromHint || cfg.synorixdPath || cfg.wslSynorixdPath || '';
    return p ? p : null;
  }
  const hintRaw = hintPath && typeof hintPath === 'string' ? path.resolve(hintPath.trim()) : '';
  const hint = hintRaw ? ensureWindowsExeExtension(hintRaw) : '';
  if (hint && fileExistsExecutable(hint)) return hint;
  const hintDir = hintRaw ? path.dirname(hintRaw) : '';
  const found = findFirstByPathsAndNames(getPossibleSearchPaths(hintDir), POSSIBLE_DAEMON_NAMES);
  return found ? ensureWindowsExeExtension(found) : null;
}

function findSynorixPairInSearchRoots(roots) {
  for (const root of roots) {
    const cliPath = findFirstInDirectory(root, POSSIBLE_CLI_NAMES);
    const dPath = findFirstInDirectory(root, POSSIBLE_DAEMON_NAMES);
    if (cliPath && dPath) {
      return {
        synorixdPath: ensureWindowsExeExtension(dPath),
        synorixCliPath: ensureWindowsExeExtension(cliPath),
      };
    }
  }
  return null;
}

function getSearchedRootsForUi() {
  return getPossibleSearchPaths('');
}

function taskkillExe() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
}

function checkSynorixdProcessExists() {
  return new Promise((resolve) => {
    if (useWslNodeMode()) {
      execFile(
        WSL_EXE,
        ['-d', getWslDistroName(), '-e', 'pgrep', '-x', 'synorixd'],
        { windowsHide: true, encoding: 'utf8' },
        (err, stdout) => {
          resolve(!err && String(stdout || '').trim().length > 0);
        },
      );
      return;
    }
    if (isWin()) {
      const tl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
      const tryWmic = () => {
        const wmic = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wbem', 'wmic.exe');
        if (!fs.existsSync(wmic)) {
          resolve(false);
          return;
        }
        execFile(
          wmic,
          ['process', 'where', "name='synorixd.exe'", 'get', 'ProcessId'],
          { windowsHide: true, encoding: 'utf8' },
          (err2, stdout2) => {
            resolve(!err2 && /\d+/.test(String(stdout2 || '')));
          },
        );
      };
      if (!fs.existsSync(tl)) {
        tryWmic();
        return;
      }
      execFile(
        tl,
        ['/FI', 'IMAGENAME eq synorixd.exe', '/NH'],
        { windowsHide: true, encoding: 'utf8' },
        (err, stdout) => {
          if (!err && /\bsynorixd\.exe\b/i.test(String(stdout || ''))) {
            resolve(true);
            return;
          }
          tryWmic();
        },
      );
      return;
    }
    execFile('pgrep', ['-x', 'synorixd'], { windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve(!err && String(stdout || '').trim().length > 0);
    });
  });
}

function taskkillSynorixdWindows() {
  return new Promise((resolve) => {
    const tk = taskkillExe();
    if (!fs.existsSync(tk)) {
      resolve();
      return;
    }
    execFile(tk, ['/IM', 'synorixd.exe', '/F', '/T'], { windowsHide: true }, () => resolve());
  });
}

// ---------------------------------------------------------------------------
// RPC warmup (-28 / Verifying blocks)
// ---------------------------------------------------------------------------

class RpcWarmupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RpcWarmupError';
  }
}

function isRpcWarmupCliError(err) {
  if (!err) return false;
  const c = err.code;
  if (c === 28 || c === '28') return true;
  const m = String(err.message || '');
  return /\(cikis:\s*28\)|\bcikis:\s*28\b|error code:\s*-28\b/i.test(m);
}

function isRpcWarmupDetail(detail) {
  const d = String(detail || '').toLowerCase();
  return (
    /error code:\s*-28\b/.test(d) ||
    /"code"\s*:\s*-28\b/.test(d) ||
    d.includes('verifying block') ||
    (d.includes('still in initial') && d.includes('download')) ||
    d.includes('in warmup')
  );
}

function isRpcWarmupError(e) {
  return Boolean(e && e.name === 'RpcWarmupError');
}

function isRpcConnectionLikeError(msg) {
  const m = String(msg || '').toLowerCase();
  return (
    m.includes('could not connect') ||
    m.includes('eof reached') ||
    m.includes('eof') ||
    m.includes('timeout on transient') ||
    m.includes('connection refused') ||
    m.includes('econnrefused') ||
    m.includes('could not locate rpc credentials') ||
    m.includes('incorrect rpcuser') ||
    m.includes('authorization failed')
  );
}

function rpcWarmupLogDetail(combinedStderrStdout) {
  const s = String(combinedStderrStdout || '');
  const line = s.match(/error message:\s*([^\n\r]+)/i);
  if (line) {
    return line[1]
      .trim()
      .replace(/\u2026/g, '...')
      .replace(/…/g, '...')
      .replace(/[^\x20-\x7E]/g, '');
  }
  return 'block verification';
}

// ---------------------------------------------------------------------------
// CLI / düğüm argümanları
// ---------------------------------------------------------------------------

function buildSynorixCliBaseArgs() {
  ensureRpcEnvironment();
  const datadir = path.normalize(getDatadir());
  const conf = getMvpConfPath();
  return [
    `-conf=${conf}`,
    '-testnet',
    `-datadir=${datadir}`,
    `-rpcuser=${FIXED_RPC_USER}`,
    `-rpcpassword=${FIXED_RPC_PASSWORD}`,
  ];
}

function buildSynorixdBaseArgs() {
  ensureRpcEnvironment();
  const datadir = path.normalize(getDatadir());
  const conf = getMvpConfPath();
  return [
    `-conf=${conf}`,
    '-testnet',
    `-datadir=${datadir}`,
    `-rpcuser=${FIXED_RPC_USER}`,
    `-rpcpassword=${FIXED_RPC_PASSWORD}`,
  ];
}

/**
 * Windows’ta execFile + shell:true cmd.exe’ye düşer ve "is not recognized" üretebilir.
 * spawn + tam .exe yolu WSL dışı native Windows için güvenilir.
 * WSL modunda: wsl.exe -d Distro -e /path/synorix-cli …
 */
function runCliOnce(cliAbs, extraArgs) {
  if (useWslNodeMode()) {
    const linuxCli = String(cliAbs || '').trim();
    if (!linuxCli.startsWith('/')) {
      return Promise.reject(new Error(ERR_WSL_BINARIES_NOT_FOUND));
    }
    const args = wslSpawnArgs(linuxCli, [...buildSynorixCliBaseArgs(), ...extraArgs]);
    return new Promise((resolve, reject) => {
      const child = spawn(WSL_EXE, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => {
        stdout += c;
      });
      child.stderr.on('data', (c) => {
        stderr += c;
      });
      child.on('error', (err) => {
        reject(err);
      });
      child.on('close', (code) => {
        const se = stderr.trim();
        const so = stdout.trim();
        const detail = [se, so].filter(Boolean).join('\n');
        if (code !== 0) {
          const head = `exit code ${code}`;
          const msg = detail ? `${detail}\n---\n${head}` : head;
          const fakeErr = { message: detail, code };
          if (isRpcWarmupCliError(fakeErr) || isRpcWarmupDetail(detail)) {
            reject(new RpcWarmupError(rpcWarmupLogDetail(detail)));
            return;
          }
          reject(new Error(msg));
          return;
        }
        resolve(so);
      });
    });
  }

  const file = ensureWindowsExeExtension(path.normalize(path.resolve(cliAbs)));
  if (!fileExistsExecutable(file)) {
    return Promise.reject(new Error(ERR_BINARIES_NOT_FOUND));
  }
  const args = [...buildSynorixCliBaseArgs(), ...extraArgs];

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (code) => {
      const se = stderr.trim();
      const so = stdout.trim();
      const detail = [se, so].filter(Boolean).join('\n');
      if (code !== 0) {
        const head = `exit code ${code}`;
        const msg = detail ? `${detail}\n---\n${head}` : head;
        const fakeErr = { message: detail, code };
        if (isRpcWarmupCliError(fakeErr) || isRpcWarmupDetail(detail)) {
          reject(new RpcWarmupError(rpcWarmupLogDetail(detail)));
          return;
        }
        reject(new Error(msg));
        return;
      }
      resolve(so);
    });
  });
}

async function runCli(cliPath, extraArgs) {
  const cli = resolveSynorixCli(cliPath || '');
  if (!cli) {
    throw new Error(useWslNodeMode() ? ERR_WSL_BINARIES_NOT_FOUND : ERR_BINARIES_NOT_FOUND);
  }
  if (!useWslNodeMode() && !fileExistsExecutable(cli)) {
    throw new Error(ERR_BINARIES_NOT_FOUND);
  }
  const cliAbs = useWslNodeMode() ? cli : path.normalize(path.resolve(cli));
  return runCliOnce(cliAbs, extraArgs);
}

async function jsonCli(cliPath, extraArgs) {
  try {
    const out = await runCli(cliPath, extraArgs);
    try {
      return JSON.parse(out);
    } catch {
      return out;
    }
  } catch (e) {
    if (isRpcWarmupError(e)) {
      return { _warmup: true, _warmupMessage: MSG_WARMUP_RPC };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Node hazırlık (genesis / verificationprogress kontrolü yok)
// ---------------------------------------------------------------------------

/**
 * getblockchaininfo gecerli JSON ve blocks sayisal ise RPC hazir (headers/chainwork sarti yok;
 * bazi surumlerde genesis asamasinda headers 0 kalabiliyordu ve sonsuz beklemeye yol aciyordu).
 */
function isBlockchainInfoRpcReady(j) {
  if (!j || typeof j !== 'object') return false;
  if (!('blocks' in j)) return false;
  const b = Number(j.blocks);
  return Number.isFinite(b) && b >= 0;
}

/**
 * Önce RPC_READY_INITIAL_SLEEP_MS sabit bekleme, sonra 2 sn aralıkla getblockchaininfo.
 * Toplam RPC_READY_MAX_WAIT_MS aşılırsa MSG_RPC_TIMED_OUT.
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
async function waitForRPCReady(cliPath) {
  const cli = resolveSynorixCli(cliPath || '');
  if (!cli || (!useWslNodeMode() && !fileExistsExecutable(cli))) {
    return { ok: false, message: useWslNodeMode() ? ERR_WSL_BINARIES_NOT_FOUND : ERR_BINARIES_NOT_FOUND };
  }
  const cliAbs = useWslNodeMode() ? cli : path.normalize(path.resolve(cli));
  const started = Date.now();
  const deadline = started + RPC_READY_MAX_WAIT_MS;
  await sleep(RPC_READY_INITIAL_SLEEP_MS);
  while (Date.now() < deadline) {
    try {
      const raw = await runCliOnce(cliAbs, ['getblockchaininfo']);
      let j;
      try {
        j = JSON.parse(raw);
      } catch {
        j = null;
      }
      if (isBlockchainInfoRpcReady(j)) {
        return { ok: true };
      }
    } catch (e) {
      if (
        isRpcWarmupError(e) ||
        isRpcWarmupDetail(String(e && e.message)) ||
        isRpcConnectionLikeError(String(e && e.message))
      ) {
        /* yoklamaya devam */
      } else {
        return { ok: false, message: toUserMessage(e) };
      }
    }
    await sleep(RPC_READY_POLL_MS);
  }
  return { ok: false, message: MSG_RPC_TIMED_OUT };
}

/** Tek atımlık kontrol (anket); uzun bekleme yok. */
async function checkNodeReadyForWallet(cliPath) {
  const cli = resolveSynorixCli(cliPath || '');
  if (!cli || (!useWslNodeMode() && !fileExistsExecutable(cli))) {
    return { ready: false, message: useWslNodeMode() ? ERR_WSL_BINARIES_NOT_FOUND : ERR_BINARIES_NOT_FOUND };
  }
  const cliAbs = useWslNodeMode() ? cli : path.normalize(path.resolve(cli));
  try {
    const raw = await runCliOnce(cliAbs, ['getblockchaininfo']);
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      return { ready: false, message: MSG_WARMUP_RPC };
    }
    if (isBlockchainInfoRpcReady(j)) {
      return { ready: true, message: '' };
    }
    return { ready: false, message: MSG_WARMUP_RPC };
  } catch (e) {
    if (isRpcWarmupError(e) || isRpcWarmupDetail(String(e && e.message))) {
      return { ready: false, message: MSG_WARMUP_RPC };
    }
    if (isRpcConnectionLikeError(String(e && e.message))) {
      return { ready: false, message: MSG_RPC_OFFLINE };
    }
    return { ready: false, message: toUserMessage(e) };
  }
}

function verifySynorixdBinary(resolvedD, datadir) {
  if (useWslNodeMode()) {
    const linuxD = String(resolvedD || '').trim();
    if (!linuxD.startsWith('/')) {
      return Promise.reject(new Error(ERR_WSL_BINARIES_NOT_FOUND));
    }
    const args = wslSpawnArgs(linuxD, [
      `-conf=${getMvpConfPath()}`,
      '-testnet',
      `-datadir=${datadir}`,
      '-version',
    ]);
    return new Promise((resolve, reject) => {
      execFile(WSL_EXE, args, { windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 25000 }, (err) => {
        if (err) {
          reject(new Error('synorixd (WSL) çalıştırılamadı veya sürüm alınamadı.'));
          return;
        }
        resolve();
      });
    });
  }
  const exe = ensureWindowsExeExtension(path.normalize(path.resolve(resolvedD)));
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      [`-conf=${getMvpConfPath()}`, '-testnet', `-datadir=${datadir}`, '-version'],
      { windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 25000 },
      (err) => {
        if (err) {
          reject(new Error('synorixd çalıştırılamadı veya sürüm alınamadı. Binary ve datadir yolunu kontrol edin.'));
          return;
        }
        resolve();
      },
    );
  });
}

async function assertPidAliveAfterSpawn(pid, msWait = 1500) {
  if (pid == null || pid <= 0) {
    throw new Error('synorixd başlatılamadı (PID yok).');
  }
  await sleep(msWait);
  try {
    process.kill(pid, 0);
    return;
  } catch {
    /* devam */
  }
  if (isWin() && (await checkSynorixdProcessExists())) {
    return;
  }
  throw new Error(
    'synorixd hemen kapandı. Visual C++ runtime, antivirüs veya synorix.conf / datadir izinlerini kontrol edin.',
  );
}

/**
 * Windows: detached=false ile başlat; stderr yakala. Çıkış kodu veya süreç yoksa gerçek sebebi mesaja ekle.
 */
async function startSynorixdWindowsAttached(resolvedD, wargs) {
  let stderrAcc = '';
  let exitCode = null;
  const child = spawn(resolvedD, wargs, {
    detached: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (buf) => {
    stderrAcc = (stderrAcc + buf).slice(-8000);
  };
  child.stderr.on('data', (c) => append(String(c)));
  child.stdout.on('data', (c) => append(String(c)));
  child.on('exit', (code) => {
    exitCode = code;
  });
  child.on('error', (e) => {
    console.error('synorixd spawn error:', e);
  });

  await sleep(2800);

  if (exitCode !== null) {
    const tail = stderrAcc.trim().replace(/\s+/g, ' ').slice(-700);
    const extra = tail ? ` Ayrıntı: ${tail}` : '';
    throw new Error(`synorixd hemen kapandı (çıkış kodu: ${exitCode}).${extra}`);
  }

  let pidOk = false;
  try {
    process.kill(child.pid, 0);
    pidOk = true;
  } catch {
    /* yoksay */
  }
  if (!pidOk && (await checkSynorixdProcessExists())) {
    pidOk = true;
  }
  if (!pidOk) {
    const tail = stderrAcc.trim().replace(/\s+/g, ' ').slice(-700);
    const extra = tail ? ` Ayrıntı: ${tail}` : '';
    throw new Error(
      `synorixd süreç bulunamadı (PID geçersiz).${extra} Visual C++ runtime, antivirüs veya synorix.conf / datadir izinlerini kontrol edin.`,
    );
  }

  return child;
}

// ---------------------------------------------------------------------------
// Sağlık monitörü
// ---------------------------------------------------------------------------

function stopNodeHealthMonitor() {
  if (nodeHealthTimer) {
    clearInterval(nodeHealthTimer);
    nodeHealthTimer = null;
  }
}

function startNodeHealthMonitor(synorixCliPath) {
  stopNodeHealthMonitor();
  const cli = resolveSynorixCli(synorixCliPath || '');
  if (!cli || (!useWslNodeMode() && !fileExistsExecutable(cli))) return;
  const cliAbs = useWslNodeMode() ? cli : path.normalize(path.resolve(cli));
  const tick = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const raw = await runCliOnce(cliAbs, ['getblockchaininfo']);
      let j;
      try {
        j = JSON.parse(raw);
      } catch {
        j = null;
      }
      if (j) {
        mainWindow.webContents.send('node:health', { ok: true, blocks: j.blocks });
        return;
      }
      mainWindow.webContents.send('node:health', { ok: true, blocks: undefined });
    } catch (e) {
      if (isRpcWarmupError(e) || isRpcWarmupDetail(String(e && e.message))) {
        mainWindow.webContents.send('node:health', { ok: true, blocks: undefined });
        return;
      }
      mainWindow.webContents.send('node:health', {
        ok: false,
        error: isRpcConnectionLikeError(String(e.message)) ? MSG_RPC_OFFLINE : toUserMessage(e),
      });
    }
  };
  nodeHealthTimer = setInterval(() => {
    tick().catch(() => {});
  }, HEALTH_POLL_INTERVAL_MS);
  tick().catch(() => {});
}

// ---------------------------------------------------------------------------
// Binary çözümleme (UI)
// ---------------------------------------------------------------------------

async function resolveSynorixBinaries() {
  if (useWslNodeMode()) {
    const cfg = loadConfig();
    const d = (cfg.wslSynorixdPath || '').trim();
    const c = (cfg.wslSynorixCliPath || '').trim();
    const searched = [`WSL distro: ${getWslDistroName()}`, d, c];
    const okWsl = await wslAvailableAsync();
    if (!okWsl) {
      return {
        ok: false,
        synorixdPath: d,
        synorixCliPath: c,
        source: 'wsl',
        searchedRoots: searched,
        useWsl: true,
        hint: ERR_WSL_NOT_AVAILABLE,
      };
    }
    const okD = d && (await wslTestExecutableAsync(d));
    const okC = c && (await wslTestExecutableAsync(c));
    if (okD && okC) {
      saveConfig({ ...cfg, synorixdPath: d, synorixCliPath: c });
      return {
        ok: true,
        synorixdPath: d,
        synorixCliPath: c,
        source: 'wsl',
        searchedRoots: searched,
        useWsl: true,
      };
    }
    return {
      ok: false,
      synorixdPath: d,
      synorixCliPath: c,
      source: 'wsl',
      searchedRoots: searched,
      useWsl: true,
      hint: `${ERR_WSL_BINARIES_NOT_FOUND}\nDağıtım: ${getWslDistroName()}\n${d}\n${c}`,
    };
  }

  const searched = getSearchedRootsForUi();
  const pairAuto = findSynorixPairInSearchRoots(searched);
  if (pairAuto) {
    const cfg = loadConfig();
    saveConfig({ ...cfg, synorixdPath: pairAuto.synorixdPath, synorixCliPath: pairAuto.synorixCliPath });
    return { ok: true, ...pairAuto, source: 'auto', searchedRoots: searched, useWsl: false };
  }
  const cfg = loadConfig();
  const cliPath = resolveSynorixCli(cfg.synorixCliPath || '');
  const dPath = resolveSynorixd(cfg.synorixdPath || '');
  if (cliPath && dPath && fileExistsExecutable(cliPath) && fileExistsExecutable(dPath)) {
    saveConfig({ ...cfg, synorixdPath: dPath, synorixCliPath: cliPath });
    return {
      ok: true,
      synorixdPath: dPath,
      synorixCliPath: cliPath,
      source: 'config',
      searchedRoots: searched,
      useWsl: false,
    };
  }
  return {
    ok: false,
    synorixdPath: '',
    synorixCliPath: '',
    source: 'none',
    searchedRoots: searched,
    useWsl: false,
    hint: `${ERR_BINARIES_NOT_FOUND}\nDenenen klasörler:\n${searched.join('\n')}`,
  };
}

// ---------------------------------------------------------------------------
// Pencere
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Synorix Testnet (SNRX) — MVP',
  });
  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
}

app.whenReady().then(() => {
  try {
    ensureRpcEnvironment();
  } catch {
    /* ilk açılışta datadir yazılamazsa sonraki adımda tekrar denenir */
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopNodeHealthMonitor();
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:set', (_e, cfg) => {
  saveConfig(cfg);
  return loadConfig();
});

ipcMain.handle('binaries:resolve', async () => resolveSynorixBinaries());

ipcMain.handle('dialog:pickBinary', async (_e, title) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Synorix binary seç',
    properties: ['openFile'],
    filters: isWin()
      ? [
          { name: 'Tümü', extensions: ['*'] },
          { name: 'Executable', extensions: ['exe'] },
        ]
      : [{ name: 'All', extensions: ['*'] }],
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

ipcMain.handle('dialog:pickBinDirectory', async (_e, title) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: title || 'build/bin içeren klasörü seçin',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

ipcMain.handle('paths:get', () => {
  ensureRpcEnvironment();
  const wsl = useWslNodeMode();
  const distro = wsl ? getWslDistroName() : '';
  const datadir = getDatadir();
  return {
    datadir,
    userData: app.getPath('userData'),
    releasesUrl: SYNORIX_RELEASES_URL,
    useWsl: wsl,
    wslDistro: distro,
    datadirUnc: wsl ? linuxPathToWslUnc(distro, datadir) : '',
  };
});

ipcMain.handle('shell:openReleases', async () => {
  await shell.openExternal(SYNORIX_RELEASES_URL);
});

ipcMain.handle('node:start', async (_e, { synorixdPath, synorixCliPath }) => {
  try {
    const cfg = loadConfig();
    const cliHint = synorixCliPath || cfg.synorixCliPath || '';

    if (useWslNodeMode()) {
      const resolvedWslD = resolveSynorixd(synorixdPath || cfg.synorixdPath || '');
      if (!resolvedWslD || !resolvedWslD.startsWith('/')) {
        ipcThrowUser(new Error(ERR_WSL_BINARIES_NOT_FOUND));
      }

      ensureRpcEnvironment();
      ensureSynorixConf();

      if (await checkSynorixdProcessExists()) {
        stopNodeHealthMonitor();
        try {
          const wrAttach = await waitForRPCReady(cliHint);
          if (!wrAttach.ok) {
            throw new Error(wrAttach.message || MSG_RPC_TIMED_OUT);
          }
          startNodeHealthMonitor(cliHint);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('node:health', { ok: true, started: true, attached: true });
          }
          return {
            ok: true,
            mode: 'attached-existing',
            rpcReady: true,
            skipVerification: true,
            wsl: true,
          };
        } catch (e) {
          ipcThrowUser(e);
        }
      }

      stopNodeHealthMonitor();
      wipeMvpDatadirOrThrow();

      const wslData = getDatadir();
      await verifySynorixdBinary(resolvedWslD, wslData);
      const dargsWsl = [...buildSynorixdBaseArgs()];
      await new Promise((resolve, reject) => {
        execFile(WSL_EXE, wslSpawnArgs(resolvedWslD, dargsWsl), { maxBuffer: 1024 * 1024, windowsHide: true }, (err) => {
          if (err) {
            reject(new Error('synorixd (WSL) arka planda başlatılamadı.'));
            return;
          }
          resolve();
        });
      });
      nodeProcess = { killed: false, detached: true, wsl: true };
      const wrWsl = await waitForRPCReady(cliHint);
      if (!wrWsl.ok) {
        throw new Error(wrWsl.message || MSG_RPC_TIMED_OUT);
      }
      startNodeHealthMonitor(cliHint);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('node:health', { ok: true, started: true });
      }
      return {
        ok: true,
        mode: 'wsl-daemon',
        rpcReady: true,
        datadirCleared: true,
        skipVerification: true,
        wsl: true,
      };
    }

    const resolvedD = path.normalize(path.resolve(resolveSynorixd(synorixdPath || cfg.synorixdPath || '')));

    if (!resolvedD || !fileExistsExecutable(resolvedD)) {
      ipcThrowUser(new Error(ERR_BINARIES_NOT_FOUND));
    }

    ensureRpcEnvironment();
    ensureSynorixConf();

    if (await checkSynorixdProcessExists()) {
      stopNodeHealthMonitor();
      try {
        const wrAttach = await waitForRPCReady(cliHint);
        if (!wrAttach.ok) {
          throw new Error(wrAttach.message || MSG_RPC_TIMED_OUT);
        }
        startNodeHealthMonitor(cliHint);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('node:health', { ok: true, started: true, attached: true });
        }
        return { ok: true, mode: 'attached-existing', rpcReady: true, skipVerification: true, wsl: false };
      } catch (e) {
        ipcThrowUser(e);
      }
    }

    stopNodeHealthMonitor();

    wipeMvpDatadirOrThrow();

    if (process.platform !== 'win32') {
      await verifySynorixdBinary(resolvedD, path.normalize(getDatadir()));
      const dargs = [...buildSynorixdBaseArgs()];
      await new Promise((resolve, reject) => {
        execFile(resolvedD, dargs, { maxBuffer: 1024 * 1024, windowsHide: true }, (err) => {
          if (err) {
            reject(new Error('synorixd arka plan modunda başlatılamadı.'));
            return;
          }
          resolve();
        });
      });
      nodeProcess = { killed: false, detached: true };
      const wrUnix = await waitForRPCReady(cliHint);
      if (!wrUnix.ok) {
        throw new Error(wrUnix.message || MSG_RPC_TIMED_OUT);
      }
      startNodeHealthMonitor(cliHint);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('node:health', { ok: true, started: true });
      }
      return {
        ok: true,
        mode: 'daemon',
        rpcReady: true,
        datadirCleared: true,
        skipVerification: true,
        wsl: false,
      };
    }

    await verifySynorixdBinary(resolvedD, path.normalize(getDatadir()));
    const wargs = [...buildSynorixdBaseArgs()];
    let child;
    try {
      child = await startSynorixdWindowsAttached(resolvedD, wargs);
    } catch (e) {
      ipcThrowUser(e);
    }

    child.on('exit', () => {
      if (nodeProcess === child) nodeProcess = null;
      stopNodeHealthMonitor();
    });

    try {
      child.unref();
      nodeProcess = child;
      const wrWin = await waitForRPCReady(cliHint);
      if (!wrWin.ok) {
        throw new Error(wrWin.message || MSG_RPC_TIMED_OUT);
      }
      startNodeHealthMonitor(cliHint);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('node:health', { ok: true, started: true, pid: child.pid });
      }
      return {
        ok: true,
        mode: 'detached-spawn',
        rpcReady: true,
        pid: child.pid,
        datadirCleared: true,
        skipVerification: true,
        wsl: false,
      };
    } catch (e) {
      try {
        child.kill();
      } catch {
        /* yoksay */
      }
      nodeProcess = null;
      throw e;
    }
  } catch (e) {
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('node:stop', async (_e, { synorixCliPath }) => {
  try {
    const cfg = loadConfig();
    const resolvedCli = resolveSynorixCli(synorixCliPath || cfg.synorixCliPath || '');
    if (!resolvedCli) {
      throw new Error(useWslNodeMode() ? ERR_WSL_BINARIES_NOT_FOUND : ERR_BINARIES_NOT_FOUND);
    }
    if (!useWslNodeMode() && !fileExistsExecutable(resolvedCli)) {
      throw new Error(ERR_BINARIES_NOT_FOUND);
    }

    stopNodeHealthMonitor();

    let stopErr = '';
    try {
      await runCli(resolvedCli, ['stop']);
    } catch (e) {
      stopErr = toUserMessage(e);
    }

    await sleep(2500);

    if (useWslNodeMode()) {
      if (await checkSynorixdProcessExists()) {
        await new Promise((r) => {
          execFile(
            WSL_EXE,
            ['-d', getWslDistroName(), '-e', 'pkill', '-x', 'synorixd'],
            { windowsHide: true },
            () => r(),
          );
        });
        await sleep(500);
      }
    } else if (isWin() && (await checkSynorixdProcessExists())) {
      await taskkillSynorixdWindows();
      await sleep(500);
    }

    nodeProcess = null;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('node:health', { ok: false, stopped: true });
    }

    if (stopErr && (await checkSynorixdProcessExists())) {
      throw new Error(
        useWslNodeMode()
          ? 'Düğüm durdurulamadı. WSL içinde `pkill synorixd` deneyin.'
          : 'Düğüm durdurulamadı. Görev Yöneticisi’nden synorixd’i kapatın.',
      );
    }

    return { ok: true, stopWarning: stopErr || undefined };
  } catch (e) {
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('rpc:getblockchaininfo', async (_e, { synorixCliPath }) => {
  try {
    return await jsonCli(synorixCliPath, ['getblockchaininfo']);
  } catch (e) {
    if (isRpcConnectionLikeError(String(e && e.message))) {
      return { _offline: true, message: MSG_RPC_OFFLINE };
    }
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('rpc:checkNodeReady', async (_e, { synorixCliPath }) => {
  try {
    return await checkNodeReadyForWallet(synorixCliPath);
  } catch (e) {
    return { ready: false, message: toUserMessage(e) };
  }
});

ipcMain.handle('rpc:waitForRPCReady', async (_e, { synorixCliPath }) => {
  return waitForRPCReady(synorixCliPath);
});

ipcMain.handle('rpc:getnetworkinfo', async (_e, { synorixCliPath }) => {
  try {
    return await jsonCli(synorixCliPath, ['getnetworkinfo']);
  } catch (e) {
    if (isRpcWarmupError(e)) {
      return { _warmup: true, message: MSG_WARMUP_RPC };
    }
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('rpc:getconnectioncount', async (_e, { synorixCliPath }) => {
  try {
    const n = await runCli(synorixCliPath, ['getconnectioncount']);
    return parseInt(n, 10);
  } catch (e) {
    if (isRpcWarmupError(e) || isRpcConnectionLikeError(String(e && e.message))) return null;
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('wallet:create', async (_e, { synorixCliPath }) => {
  try {
    const wr = await waitForRPCReady(synorixCliPath);
    if (!wr.ok) {
      throw new Error(wr.message || MSG_RPC_TIMED_OUT);
    }
    await runCli(synorixCliPath, ['createwallet', 'default']);
    return { ok: true };
  } catch (e) {
    if (isRpcConnectionLikeError(String(e && e.message))) {
      throw new Error(MSG_RPC_OFFLINE);
    }
    if (isRpcWarmupError(e) || isRpcWarmupDetail(String(e && e.message))) {
      return { ok: false, warmup: true };
    }
    const m = String(e.message || '');
    if (/already exists|duplicate/i.test(m)) {
      return { ok: true };
    }
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('wallet:newaddress', async (_e, { synorixCliPath }) => {
  try {
    const wr = await waitForRPCReady(synorixCliPath);
    if (!wr.ok) {
      throw new Error(wr.message || MSG_RPC_TIMED_OUT);
    }
    return await runCli(synorixCliPath, ['-rpcwallet=default', 'getnewaddress']);
  } catch (e) {
    if (isRpcConnectionLikeError(String(e && e.message))) {
      throw new Error(MSG_RPC_OFFLINE);
    }
    if (isRpcWarmupError(e) || isRpcWarmupDetail(String(e && e.message))) {
      throw new Error(MSG_WARMUP_RPC);
    }
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('wallet:balance', async (_e, { synorixCliPath }) => {
  try {
    const bal = await runCli(synorixCliPath, ['-rpcwallet=default', 'getbalance']);
    return parseFloat(bal);
  } catch (e) {
    if (isRpcConnectionLikeError(String(e && e.message))) return null;
    if (isRpcWarmupError(e) || isRpcWarmupDetail(String(e && e.message))) return null;
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('mining:generatetoaddress', async (_e, { synorixCliPath, nblocks, address }) => {
  try {
    const wr = await waitForRPCReady(synorixCliPath);
    if (!wr.ok) {
      throw new Error(wr.message || MSG_RPC_TIMED_OUT);
    }
    const n = Math.min(Math.max(1, parseInt(nblocks, 10) || 1), 100);
    let out;
    try {
      out = await runCli(synorixCliPath, ['generatetoaddress', String(n), address]);
    } catch (e) {
      if (isRpcConnectionLikeError(String(e && e.message))) {
        throw new Error(MSG_RPC_OFFLINE);
      }
      if (isRpcWarmupError(e) || isRpcWarmupDetail(String(e && e.message))) {
        throw new Error(MSG_WARMUP_RPC);
      }
      throw e;
    }
    const parsed = JSON.parse(out);
    return { count: Array.isArray(parsed) ? parsed.length : 0, hashes: parsed };
  } catch (e) {
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('shell:openDatadir', async () => {
  ensureRpcEnvironment();
  if (useWslNodeMode()) {
    const unc = linuxPathToWslUnc(getWslDistroName(), getDatadir());
    await shell.openPath(unc);
    return;
  }
  await shell.openPath(getDatadir());
});
