/**
 * Synorix Testnet MVP — yalnızca WSL (Ubuntu)
 *
 * Windows’ta Electron; tüm synorix komutları wsl.exe -d <distro> -e … ile çalışır.
 * Varsayılan yollar: /home/synorix/synorix/build/bin/, datadir: /home/synorix/SynorixTestnetData
 */

const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { BIP32Factory } = require('bip32');
const bip32 = BIP32Factory(ecc);
const si = require('systeminformation');
const QRCode = require('qrcode');
const { synorixMainnet, synorixTestnet } = require('./synorixNetwork');

/** Varsayılan hazine adresi (config’te treasuryAddress ile geçersiz kılınabilir) */
const DEFAULT_TREASURY_ADDRESS = 'tsnrx1q6rz28mcfaxtmd6v789l9rrlrusdprr9p8vw7kg';

/** C:\\Users\\a\\b → /mnt/c/Users/a/b */
function windowsPathToWsl(winPath) {
  const n = path.normalize(winPath);
  const m = n.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!m) return n.replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

// ---------------------------------------------------------------------------
// Sabitler
// ---------------------------------------------------------------------------

const CONFIG_NAME = 'synorix-wsl-mvp-config.json';
const SYNORIX_CONF_NAME = 'synorix.conf';

/** Ortam değişkeniyle VPS / elle kurulumla eşleştirilebilir (conf her başta yeniden yazılır). */
const FIXED_RPC_USER = process.env.SYNORIX_RPC_USER || 'synorix';
const FIXED_RPC_PASSWORD = process.env.SYNORIX_RPC_PASSWORD || 'SynorixTest2026!';

const DEFAULT_DISTRO = 'Ubuntu';
/** Config yokken yedek; gerçek yollar WSL $HOME ile otomatik bulunur */
const DEFAULT_SYNORIXD = '/home/USER/synorix/build/bin/synorixd';
const DEFAULT_SYNORIX_CLI = '/home/USER/synorix/build/bin/synorix-cli';
const DEFAULT_DATADIR = '/home/USER/SynorixTestnetData';

const WSL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');

const RPC_BOOT_GRACE_MS = 2500;
const RPC_POLL_MS = 1500;
const RPC_MAX_WAIT_MS = 300000;

const HEALTH_POLL_MS = 3000;
const AUTO_MINING_INTERVAL_MS = 150000; // 2.5 minutes (taban; iş parçacığı sayısıyla bölünür)
const MIN_MINING_INTERVAL_MS = 20000;
const HD_SEED_FILE = 'hd-seed.enc';
const HD_META_FILE = 'hd-wallet-meta.json';

const MSG_WSL_MISSING =
  'WSL (wsl.exe) bulunamadı. Yönetici PowerShell veya CMD: wsl --install  (ardından bilgisayarı yeniden başlatın).';
/** wsl --list --verbose sonrası WSL2 + Ubuntu ailesi dağıtımı yoksa */
const MSG_WSL_UBUNTU_SETUP =
  "WSL2 ve Ubuntu dağıtımı kurulu değil. Lütfen PowerShell'de 'wsl --install -d Ubuntu' komutunu çalıştırın.";
const MSG_BINARIES_MISSING =
  'WSL içinde synorixd / synorix-cli bulunamadı. Ubuntu’da projeyi derleyin (cmake + make), sonra WSL terminalinde şunu deneyin:\nls ~/Synorix_Kopya/build/bin/synorixd\nYolları şu JSON dosyasında elle yazabilirsiniz:';
const MSG_RPC_TIMEOUT =
  'RPC zaman aşımı. WSL’de `pkill synorixd` deneyip uygulamadan tekrar «Başlat» deyin.';
const MSG_RPC_WARMUP =
  'Düğüm henüz hazırlanıyor (blok doğrulama). Kısa süre sonra tekrar deneyin.';
const MSG_RPC_OFFLINE = 'Düğüme bağlanılamıyor. Node çalışıyor mu kontrol edin.';
const MSG_RPC_NOT_READY =
  'Node henüz hazır değil. Lütfen biraz bekleyin veya node’u yeniden başlatın.';

// ---------------------------------------------------------------------------
// Global
// ---------------------------------------------------------------------------

let mainWindow = null;
let nodeHealthTimer = null;
let miningInterval = null;
let isMiningActive = false;
let miningAddress = '';
let miningTickInProgress = false;
/** Son mining olayları (yerel blok/saat tahmini için) */
const miningTickTimes = [];
const MAX_MINING_TICK_HISTORY = 200;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_NAME);
}

function mergeDefaults(c) {
  const x = c && typeof c === 'object' ? c : {};
  const oldActive = String(x.activeWalletName || '').trim();
  const activeWallet = String(x.activeWallet || oldActive || 'default').trim() || 'default';
  const walletsRaw = Array.isArray(x.wallets) ? x.wallets : [];
  const wallets = walletsRaw
    .map((w) => String(w || '').trim())
    .filter(Boolean);
  if (!wallets.includes(activeWallet)) wallets.unshift(activeWallet);
  if (wallets.length === 0) wallets.push('default');
  const mt = parseInt(x.miningThreads, 10);
  const miningThreads = Number.isFinite(mt) ? Math.min(16, Math.max(1, mt)) : 1;
  const treasuryRaw = String(x.treasuryAddress || '').trim();
  const treasuryAddress = treasuryRaw || DEFAULT_TREASURY_ADDRESS;
  return {
    wslDistro: String(x.wslDistro || DEFAULT_DISTRO).trim() || DEFAULT_DISTRO,
    synorixdPath: String(x.synorixdPath || '').trim(),
    synorixCliPath: String(x.synorixCliPath || '').trim(),
    datadir: String(x.datadir || '').trim(),
    wallets,
    activeWallet,
    miningThreads,
    hdWalletSkipped: Boolean(x.hdWalletSkipped),
    treasuryAddress,
  };
}

/** Config’te yol boşsa geçici varsayılan (env check öncesi doldurulur) */
function configWithResolvedPlaceholders(cfg) {
  const c = mergeDefaults(cfg);
  if (!c.synorixdPath) c.synorixdPath = DEFAULT_SYNORIXD.replace(/USER/g, 'synorix');
  if (!c.synorixCliPath) c.synorixCliPath = DEFAULT_SYNORIX_CLI.replace(/USER/g, 'synorix');
  if (!c.datadir) c.datadir = DEFAULT_DATADIR.replace(/USER/g, 'synorix');
  return c;
}

function loadConfig() {
  try {
    return configWithResolvedPlaceholders(JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch {
    return configWithResolvedPlaceholders({});
  }
}

/** Mevcut JSON ile birleştirir (yalnızca verilen alanları günceller). */
function saveConfig(partial) {
  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    /* ilk kayıt */
  }
  const next = { ...base, ...partial };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function confLinuxPath(cfg) {
  const d = String(cfg.datadir || '').replace(/\/+$/, '');
  return `${d}/${SYNORIX_CONF_NAME}`;
}

function getWalletList(cfgLike) {
  const raw = cfgLike && Array.isArray(cfgLike.wallets) ? cfgLike.wallets : [];
  const cleaned = raw.map((w) => String(w || '').trim()).filter(Boolean);
  if (cleaned.length === 0) cleaned.push('default');
  return [...new Set(cleaned)];
}

function nextAutoWalletName(existingWallets) {
  const set = new Set(existingWallets.map((w) => String(w || '').trim()).filter(Boolean));
  let i = 1;
  while (set.has(`Cüzdan ${i}`)) i += 1;
  return `Cüzdan ${i}`;
}

function getActiveWalletName(cfgLike) {
  const list = getWalletList(cfgLike);
  const active = String((cfgLike && cfgLike.activeWallet) || '').trim();
  if (active && list.includes(active)) return active;
  return list[0] || 'default';
}

function toUserMessage(err) {
  const raw = String(err?.message || err || '').split('\n')[0].trim();
  const t = raw.toLowerCase();
  if (
    t.includes('could not connect') ||
    t.includes('connection refused') ||
    t.includes('eof') ||
    t.includes('timeout on transient') ||
    t.includes('could not locate rpc credentials') ||
    t.includes('incorrect rpcuser') ||
    t.includes('authorization failed')
  ) {
    return MSG_RPC_OFFLINE;
  }
  if (t.includes('verifying block') || t.includes('error code: -28') || t.includes('in warmup')) {
    return MSG_RPC_WARMUP;
  }
  if (raw.length > 200) return `${raw.slice(0, 197)}…`;
  return raw || 'Beklenmeyen bir sorun oluştu.';
}

function isWalletNotLoadedMessage(msg) {
  const m = String(msg || '').toLowerCase();
  return (
    m.includes('requested wallet does not exist or is not loaded') ||
    m.includes('wallet file not specified') ||
    (m.includes('wallet') && m.includes('not loaded'))
  );
}

class RpcWarmupError extends Error {
  constructor(m) {
    super(m);
    this.name = 'RpcWarmupError';
  }
}

function isWarmupDetail(text) {
  const d = String(text || '').toLowerCase();
  return (
    /error code:\s*-28\b/.test(d) ||
    d.includes('verifying block') ||
    (d.includes('still in initial') && d.includes('download')) ||
    d.includes('in warmup')
  );
}

function isWarmupCliError(err) {
  if (!err) return false;
  const c = err.code;
  if (c === 28 || c === '28') return true;
  return isWarmupDetail(String(err.message || ''));
}

// ---------------------------------------------------------------------------
// WSL ortam kontrolü
// ---------------------------------------------------------------------------

function wslExecutableExists() {
  try {
    return fs.existsSync(WSL_EXE);
  } catch {
    return false;
  }
}

function wslDistroResponds(distro) {
  return new Promise((resolve) => {
    const name = String(distro || '').trim();
    if (!name) {
      resolve(false);
      return;
    }
    execFile(
      WSL_EXE,
      ['-d', name, '-e', 'true'],
      { windowsHide: true, timeout: 25000 },
      (err) => resolve(!err),
    );
  });
}

/** wsl -l -v çıktısı genelde UTF-16 LE; bazen UTF-8 */
function decodeWslStdout(stdout) {
  if (stdout == null) return '';
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
  if (buf.length === 0) return '';
  const asUtf16 = buf.toString('utf16le').replace(/\0/g, '').trim();
  if (/ubuntu|NAME|VERSION|Running|Stopped|Installing/i.test(asUtf16)) {
    return asUtf16;
  }
  return buf.toString('utf8').replace(/\0/g, '').trim();
}

function isUbuntuFamilyDistroName(name) {
  return /^ubuntu/i.test(String(name || '').trim());
}

/**
 * `wsl --list --verbose` satırlarını ayrıştırır.
 * @returns {{ name: string, state: string, version: number, defaultMarker: boolean }[]}
 */
function parseWslListVerbose(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    if (/^NAME\s+/i.test(raw) && /\bVERSION\b/i.test(raw)) continue;
    if (/^Windows Subsystem for Linux/i.test(raw)) continue;
    if (/^[\s\-=*]+$/i.test(raw)) continue;
    const defaultMarker = /^\*\s+/.test(line) || raw.startsWith('*');
    const noStar = raw.replace(/^\*\s*/, '').trim();
    const m = noStar.match(/^(.+?)\s+(Running|Stopped|Installing|Unknown)\s+(\d+)\s*$/i);
    if (m) {
      const ver = parseInt(m[3], 10);
      if (Number.isFinite(ver)) {
        out.push({
          name: m[1].trim(),
          state: m[2],
          version: ver,
          defaultMarker,
        });
      }
      continue;
    }
    const parts = noStar.split(/\s{2,}/).filter((p) => p.length > 0);
    if (parts.length >= 3) {
      const ver = parseInt(parts[parts.length - 1], 10);
      const state = parts[parts.length - 2];
      if (Number.isFinite(ver) && /^(Running|Stopped|Installing|Unknown)$/i.test(state)) {
        const name = parts.slice(0, -2).join(' ').trim();
        if (name) {
          out.push({ name, state, version: ver, defaultMarker });
        }
      }
    }
  }
  return out;
}

function wslListVerboseParsed() {
  return new Promise((resolve) => {
    execFile(
      WSL_EXE,
      ['--list', '--verbose'],
      { windowsHide: true, timeout: 25000 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(parseWslListVerbose(decodeWslStdout(stdout)));
      },
    );
  });
}

/** Yalnızca dağıtım adları (satır başına bir); ayrıştırma başarısız olunca yedek */
function wslListQuietNames() {
  return new Promise((resolve) => {
    execFile(WSL_EXE, ['--list', '--quiet'], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      const text = decodeWslStdout(stdout);
      const names = text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      resolve(names);
    });
  });
}

/**
 * WSL2 + Ubuntu ailesi için uygun dağıtım adını seçer; gerekirse config’e yazar.
 * @returns {Promise<{ distro: string|null, changed?: boolean, errorMessage?: string }>}
 */
async function resolveWslUbuntuDistro(cfg) {
  const preferred = String(cfg.wslDistro || DEFAULT_DISTRO).trim() || DEFAULT_DISTRO;
  const entries = await wslListVerboseParsed();

  if (entries.length > 0) {
    const wsl2Ubuntu = entries.filter((e) => e.version === 2 && isUbuntuFamilyDistroName(e.name));
    if (wsl2Ubuntu.length === 0) {
      const wsl1Ubuntu = entries.filter((e) => e.version === 1 && isUbuntuFamilyDistroName(e.name));
      if (wsl1Ubuntu.length > 0) {
        return {
          distro: null,
          errorMessage:
            "Yalnızca WSL1 üzerinde Ubuntu görünüyor; bu uygulama WSL2 gerektirir. PowerShell (Yönetici): wsl --set-version <DağıtımAdı> 2  veya  wsl --install -d Ubuntu",
        };
      }
      return { distro: null };
    }

    const pickFromList = () => {
      const pref = preferred;
      const exact = wsl2Ubuntu.find(
        (e) => e.name === pref || e.name.toLowerCase() === pref.toLowerCase(),
      );
      if (exact) return exact.name;
      const def = wsl2Ubuntu.find((e) => e.defaultMarker);
      const run = wsl2Ubuntu.find((e) => /^running$/i.test(e.state));
      return (def || run || wsl2Ubuntu[0]).name;
    };

    let picked = pickFromList();
    if (!(await wslDistroResponds(picked))) {
      let fallback = null;
      for (const e of wsl2Ubuntu) {
        if (e.name === picked) continue;
        if (await wslDistroResponds(e.name)) {
          fallback = e.name;
          break;
        }
      }
      if (!fallback) {
        return { distro: null };
      }
      picked = fallback;
    }
    const changed = picked !== preferred;
    if (changed) {
      saveConfig({ wslDistro: picked });
    }
    return { distro: picked, changed };
  }

  /* Liste ayrıştırılamadı: --quiet ile Ubuntu adlarını dene */
  const quietNames = await wslListQuietNames();
  const ubuntuCandidates = quietNames.filter(isUbuntuFamilyDistroName);
  for (const name of ubuntuCandidates) {
    if (await wslDistroResponds(name)) {
      const changed = name !== preferred;
      if (changed) {
        saveConfig({ wslDistro: name });
      }
      return { distro: name, changed };
    }
  }
  if (await wslDistroResponds(preferred)) {
    return { distro: preferred, changed: false };
  }
  return { distro: null };
}

function wslTestBinary(distro, linuxPath) {
  return new Promise((resolve) => {
    if (!linuxPath || !linuxPath.startsWith('/')) {
      resolve(false);
      return;
    }
    execFile(
      WSL_EXE,
      ['-d', distro, '-e', 'test', '-x', linuxPath],
      { windowsHide: true, timeout: 15000 },
      (err) => resolve(!err),
    );
  });
}

/** WSL içindeki Linux kullanıcısının $HOME değeri (örn. /home/hasim) */
function wslGetHome(distro) {
  return new Promise((resolve) => {
    execFile(
      WSL_EXE,
      ['-d', distro, '-e', 'printenv', 'HOME'],
      { windowsHide: true, encoding: 'utf8', timeout: 15000 },
      (err, stdout) => {
        if (err) {
          resolve('');
          return;
        }
        const line = String(stdout || '')
          .trim()
          .split(/\r?\n/)[0]
          .trim();
        resolve(line.startsWith('/') ? line : '');
      },
    );
  });
}

function normalizeLinuxDir(p) {
  return String(p || '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
}

/** Yaygın klon / derleme konumları ($HOME’a göre) */
function candidateBinRoots(home) {
  const h = normalizeLinuxDir(home);
  const roots = [];
  const add = (p) => {
    const n = normalizeLinuxDir(p);
    if (n && !roots.includes(n)) roots.push(n);
  };
  if (h) {
    add(`${h}/synorix/build/bin`);
    add(`${h}/Synorix_Kopya/build/bin`);
    add(`${h}/synorix_kopya/build/bin`);
    add(`${h}/Desktop/Synorix_Kopya/build/bin`);
    add(`${h}/Desktop/Synorix_Kopya/synorix/build/bin`);
    add(`${h}/Desktop/synorix/build/bin`);
    add(`${h}/projects/synorix/build/bin`);
    add(`${h}/dev/synorix/build/bin`);
    add(`${h}/src/synorix/build/bin`);
    add(`${h}/kod/Synorix_Kopya/build/bin`);
  }
  /* Repo Windows masaüstündeyse WSL genelde /mnt/c/Users/<WinKullanıcı>/Desktop/... görür */
  const winUser = process.env.USERNAME || process.env.USER || '';
  if (winUser && /^[a-zA-Z0-9._-]+$/.test(winUser)) {
    add(`/mnt/c/Users/${winUser}/Desktop/Synorix_Kopya/build/bin`);
    add(`/mnt/c/Users/${winUser}/Desktop/Synorix_Kopya/synorix/build/bin`);
    add(`/mnt/c/Users/${winUser}/Documents/Synorix_Kopya/build/bin`);
  }
  return roots;
}

/**
 * $HOME altında synorixd + synorix-cli ara; bulunursa config’e yazar.
 * @returns {Promise<boolean>} kayıt yapıldı mı
 */
async function tryAutoDiscoverBinaries(distro) {
  const home = await wslGetHome(distro);
  if (!home) {
    return false;
  }
  const datadir = `${normalizeLinuxDir(home)}/SynorixTestnetData`;
  for (const root of candidateBinRoots(home)) {
    const pairs = [
      [`${root}/synorixd`, `${root}/synorix-cli`],
      [`${root}/Release/synorixd`, `${root}/Release/synorix-cli`],
    ];
    for (const [dPath, cPath] of pairs) {
      if ((await wslTestBinary(distro, dPath)) && (await wslTestBinary(distro, cPath))) {
        saveConfig({
          synorixdPath: dPath,
          synorixCliPath: cPath,
          datadir,
        });
        return true;
      }
    }
  }
  return false;
}

/**
 * İlk açılış / her envCheck: WSL + dağıtım + binary varlığı
 */
async function checkWslEnvironment() {
  if (!wslExecutableExists()) {
    return { ok: false, message: MSG_WSL_MISSING };
  }
  let cfg = loadConfig();
  const resolved = await resolveWslUbuntuDistro(cfg);
  if (!resolved.distro) {
    return {
      ok: false,
      message: resolved.errorMessage || MSG_WSL_UBUNTU_SETUP,
    };
  }
  cfg = loadConfig();
  const distro = resolved.distro;
  let okD = await wslTestBinary(distro, cfg.synorixdPath);
  let okC = await wslTestBinary(distro, cfg.synorixCliPath);
  if (!okD || !okC) {
    const discovered = await tryAutoDiscoverBinaries(distro);
    if (discovered) {
      cfg = loadConfig();
      okD = await wslTestBinary(distro, cfg.synorixdPath);
      okC = await wslTestBinary(distro, cfg.synorixCliPath);
    }
  }
  if (!okD || !okC) {
    const homeHint = await wslGetHome(distro);
    const cfgFile = configPath();
    return {
      ok: false,
      message: `${MSG_BINARIES_MISSING}\n${cfgFile}\n\nŞu an denenen yollar:\nsynorixd: ${cfg.synorixdPath}\nsynorix-cli: ${cfg.synorixCliPath}\n\nWSL’de kontrol (Ubuntu terminali):\n  ls -la ${homeHint || '$HOME'}/Synorix_Kopya/build/bin/synorixd\n  ls -la ~/synorix/build/bin/synorixd\nÇalıştırılabilir değilse: chmod +x …/synorixd …/synorix-cli`,
    };
  }
  return { ok: true, message: '', wslDistro: distro };
}

// ---------------------------------------------------------------------------
// synorix.conf (WSL içine yaz)
// ---------------------------------------------------------------------------

function buildConfBody() {
  return [
    'server=1',
    'txindex=1',
    'daemon=1',
    '',
    '[test]',
    `rpcuser=${FIXED_RPC_USER}`,
    `rpcpassword=${FIXED_RPC_PASSWORD}`,
    'rpcallowip=127.0.0.1',
    'rpcbind=127.0.0.1',
    'rpcport=18332',
    'fallbackfee=0.0002',
    'printtoconsole=0',
    '',
  ].join('\n');
}

function ensureSynorixConfWsl(cfg) {
  const distro = cfg.wslDistro;
  const datadir = String(cfg.datadir).replace(/\/+$/, '') || DEFAULT_DATADIR;
  const confPath = confLinuxPath(cfg);
  const winTmp = path.join(os.tmpdir(), `synorix-wsl-mvp-${Date.now()}-${Math.random().toString(16).slice(2)}.conf`);
  fs.writeFileSync(winTmp, buildConfBody(), 'utf8');
  const wslTmp = windowsPathToWsl(winTmp);
  const sh = `mkdir -p ${shQuote(datadir)} && cp ${shQuote(wslTmp)} ${shQuote(confPath)}`;
  return new Promise((resolve, reject) => {
    execFile(WSL_EXE, ['-d', distro, '-e', 'sh', '-c', sh], { windowsHide: true, timeout: 60000 }, (err) => {
      try {
        fs.unlinkSync(winTmp);
      } catch {
        /* yok say */
      }
      if (err) {
        reject(new Error('synorix.conf WSL içine yazılamadı. Klasör izinlerini kontrol edin.'));
        return;
      }
      resolve();
    });
  });
}

function ensureDatadirWsl(cfg) {
  const distro = cfg.wslDistro;
  const root = String(cfg.datadir).replace(/\/+$/, '') || DEFAULT_DATADIR;
  return new Promise((resolve, reject) => {
    execFile(WSL_EXE, ['-d', distro, '-e', 'mkdir', '-p', root], { windowsHide: true, timeout: 30000 }, (err) => {
      if (err) {
        reject(new Error('Veri klasörü oluşturulamadı. WSL içinde izinleri kontrol edin.'));
        return;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// CLI argümanları
// ---------------------------------------------------------------------------

function buildCliBaseArgs(cfg) {
  const conf = confLinuxPath(cfg);
  const datadir = String(cfg.datadir).replace(/\/+$/, '') || DEFAULT_DATADIR;
  return [
    `-conf=${conf}`,
    '-testnet',
    `-datadir=${datadir}`,
    `-rpcuser=${FIXED_RPC_USER}`,
    `-rpcpassword=${FIXED_RPC_PASSWORD}`,
  ];
}

function wslExecArgs(cfg, linuxExe, synorixArgs) {
  return ['-d', cfg.wslDistro, '-e', linuxExe, ...synorixArgs];
}

function runCliOnce(cfg, extraArgs) {
  const cli = cfg.synorixCliPath;
  const args = wslExecArgs(cfg, cli, [...buildCliBaseArgs(cfg), ...extraArgs]);
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
    child.on('error', reject);
    child.on('close', (code) => {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
      if (code !== 0) {
        const fake = { message: detail, code };
        if (isWarmupCliError(fake) || isWarmupDetail(detail)) {
          reject(new RpcWarmupError(MSG_RPC_WARMUP));
          return;
        }
        reject(new Error(detail || `Çıkış kodu: ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function ensureWalletLoaded(cfg, walletName) {
  const name = String(walletName || '').trim();
  if (!name) return;
  try {
    await runCliOnce(cfg, ['loadwallet', name]);
  } catch (e) {
    const m = String(e.message || '');
    if (/already loaded|duplicate|wallet.*loaded/i.test(m)) {
      return;
    }
    throw e;
  }
}

async function runWalletCliOnce(cfg, walletName, rpcArgs) {
  const name = String(walletName || '').trim() || 'default';
  try {
    return await runCliOnce(cfg, ['-rpcwallet=' + name, ...rpcArgs]);
  } catch (e) {
    if (isWalletNotLoadedMessage(String(e.message || ''))) {
      await ensureWalletLoaded(cfg, name);
      return runCliOnce(cfg, ['-rpcwallet=' + name, ...rpcArgs]);
    }
    throw e;
  }
}

async function autoLoadOrCreateActiveWallet(cfg) {
  const activeW = getActiveWalletName(cfg);
  try {
    await runCliOnce(cfg, ['loadwallet', activeW]);
    console.log('[wallet] Aktif cüzdan yüklendi:', activeW);
  } catch (e) {
    const m = String(e.message || '');
    if (/already loaded|duplicate|wallet.*loaded/i.test(m)) {
      console.log('[wallet] Aktif cüzdan zaten yüklü:', activeW);
    } else {
      console.log('[wallet] Cüzdan bulunamadı, oluşturuluyor:', activeW);
      try {
        await runCliOnce(cfg, ['createwallet', activeW]);
        console.log('[wallet] Cüzdan oluşturuldu:', activeW);
      } catch (ce) {
        const cm = String(ce.message || '');
        if (/already exists|duplicate/i.test(cm)) {
          try { await runCliOnce(cfg, ['loadwallet', activeW]); } catch { /* son deneme */ }
        } else {
          console.error('[wallet] Cüzdan oluşturulamadı:', cm);
        }
      }
    }
  }
}

async function jsonCli(cfg, extraArgs) {
  try {
    const out = await runCliOnce(cfg, extraArgs);
    try {
      return JSON.parse(out);
    } catch {
      return out;
    }
  } catch (e) {
    if (e instanceof RpcWarmupError) {
      return { _warmup: true };
    }
    throw e;
  }
}

function isBlockchainReady(j) {
  if (!j || typeof j !== 'object' || j._warmup) return false;
  if (!('blocks' in j)) return false;
  const b = Number(j.blocks);
  return Number.isFinite(b) && b >= 0;
}

async function waitForRPCReady(cfg, options = {}) {
  const maxWaitMsRaw = Number(options && options.maxWaitMs);
  const maxWaitMs =
    Number.isFinite(maxWaitMsRaw) && maxWaitMsRaw > 0 ? Math.min(maxWaitMsRaw, RPC_MAX_WAIT_MS) : RPC_MAX_WAIT_MS;
  const timeoutMessage =
    String((options && options.timeoutMessage) || '').trim() || MSG_RPC_TIMEOUT;
  const started = Date.now();
  const deadline = started + maxWaitMs;
  await sleep(Math.min(RPC_BOOT_GRACE_MS, maxWaitMs));
  while (Date.now() < deadline) {
    try {
      const raw = await runCliOnce(cfg, ['getblockchaininfo']);
      let j;
      try {
        j = JSON.parse(raw);
      } catch {
        j = null;
      }
      if (isBlockchainReady(j)) {
        return { ok: true };
      }
    } catch (e) {
      if (e instanceof RpcWarmupError || isWarmupDetail(String(e.message))) {
        /* devam */
      } else {
        const m = String(e.message || '').toLowerCase();
        if (
          m.includes('could not connect') ||
          m.includes('eof') ||
          m.includes('connection refused') ||
          m.includes('could not locate rpc')
        ) {
          /* devam */
        } else {
          return { ok: false, message: toUserMessage(e) };
        }
      }
    }
    await sleep(RPC_POLL_MS);
  }
  return { ok: false, message: timeoutMessage };
}

// ---------------------------------------------------------------------------
// HD cüzdan (BIP39) — OS şifrelemesi (safeStorage)
// ---------------------------------------------------------------------------

function hdSeedPath() {
  return path.join(app.getPath('userData'), HD_SEED_FILE);
}

function hdMetaPath() {
  return path.join(app.getPath('userData'), HD_META_FILE);
}

function readHdMeta() {
  try {
    return JSON.parse(fs.readFileSync(hdMetaPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeHdMeta(obj) {
  fs.mkdirSync(path.dirname(hdMetaPath()), { recursive: true });
  fs.writeFileSync(hdMetaPath(), JSON.stringify(obj, null, 2), 'utf8');
}

function hasStoredHdSeed() {
  try {
    return fs.existsSync(hdSeedPath()) && fs.statSync(hdSeedPath()).size > 0;
  } catch {
    return false;
  }
}

function loadMnemonicFromDisk() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('İşletim sistemi şifrelemesi kullanılamıyor; seed okunamıyor.');
  }
  const buf = fs.readFileSync(hdSeedPath());
  return safeStorage.decryptString(buf);
}

function saveMnemonicToDisk(mnemonic, wordCount) {
  const m = String(mnemonic || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(m)) {
    throw new Error('Geçersiz kelime dizisi (BIP39).');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Güvenli depolama kullanılamıyor; seed kaydedilemez.');
  }
  const enc = safeStorage.encryptString(m);
  fs.mkdirSync(path.dirname(hdSeedPath()), { recursive: true });
  fs.writeFileSync(hdSeedPath(), enc);
  writeHdMeta({ wordCount, updatedAt: new Date().toISOString() });
}

function deriveHdAddresses(mnemonic, start, count) {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = bip32.fromSeed(seed, synorixTestnet);
  const out = [];
  const n = Math.min(Math.max(1, count), 50);
  const s = Math.max(0, start);
  for (let i = s; i < s + n; i += 1) {
    const dpath = `m/84'/1'/0'/0/${i}`;
    const child = root.derivePath(dpath);
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: child.publicKey,
      network: synorixTestnet,
    });
    out.push({ index: i, path: dpath, address });
  }
  return out;
}

/** BIP84 örnek adresleri (sabit test mnemonic) — konsol / hata ayıklama için */
function logSynorixSampleAddresses() {
  try {
    const demoMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const seed = bip39.mnemonicToSeedSync(demoMnemonic);
    const rootT = bip32.fromSeed(seed, synorixTestnet);
    const tsn = bitcoin.payments.p2wpkh({
      pubkey: rootT.derivePath("m/84'/1'/0'/0/0").publicKey,
      network: synorixTestnet,
    });
    const rootM = bip32.fromSeed(seed, synorixMainnet);
    const sn = bitcoin.payments.p2wpkh({
      pubkey: rootM.derivePath("m/84'/0'/0'/0/0").publicKey,
      network: synorixMainnet,
    });
    console.log('[Synorix SNRX] Örnek testnet BIP84 (tsnrx):', tsn.address);
    console.log('[Synorix SNRX] Örnek mainnet BIP84 (snrx):', sn.address);
  } catch (e) {
    console.warn('[Synorix SNRX] Örnek adres üretilemedi:', e && e.message);
  }
}

function pushMiningTickTime() {
  miningTickTimes.push(Date.now());
  while (miningTickTimes.length > MAX_MINING_TICK_HISTORY) miningTickTimes.shift();
}

function localBlocksPerHourEstimate() {
  const cutoff = Date.now() - 3600000;
  return miningTickTimes.filter((t) => t >= cutoff).length;
}

function getEffectiveMiningIntervalMs(cfgLike) {
  const c = cfgLike || loadConfig();
  const t = Math.min(16, Math.max(1, parseInt(c.miningThreads, 10) || 1));
  return Math.max(MIN_MINING_INTERVAL_MS, Math.floor(AUTO_MINING_INTERVAL_MS / t));
}

function restartMiningIntervalIfNeeded() {
  if (!isMiningActive || !miningAddress) return;
  const cfg = loadConfig();
  const intervalMs = getEffectiveMiningIntervalMs(cfg);
  if (miningInterval) {
    clearInterval(miningInterval);
    miningInterval = null;
  }
  miningInterval = setInterval(() => {
    void runAutoMiningTick();
  }, intervalMs);
  emitMiningStatus({ intervalMs });
}

// ---------------------------------------------------------------------------
// synorixd süreç kontrolü
// ---------------------------------------------------------------------------

function synorixdRunning(cfg) {
  return new Promise((resolve) => {
    execFile(
      WSL_EXE,
      ['-d', cfg.wslDistro, '-e', 'pgrep', '-x', 'synorixd'],
      { windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        resolve(!err && String(stdout || '').trim().length > 0);
      },
    );
  });
}

function startSynorixdDaemon(cfg) {
  const args = wslExecArgs(cfg, cfg.synorixdPath, [...buildCliBaseArgs(cfg)]);
  return new Promise((resolve, reject) => {
    execFile(WSL_EXE, args, { windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 60000 }, (err) => {
      if (err) {
        reject(new Error('synorixd WSL içinde başlatılamadı. Yol ve izinleri kontrol edin.'));
        return;
      }
      resolve();
    });
  });
}

function stopNodeHealthMonitor() {
  if (nodeHealthTimer) {
    clearInterval(nodeHealthTimer);
    nodeHealthTimer = null;
  }
}

function startNodeHealthMonitor() {
  stopNodeHealthMonitor();
  const cfg = loadConfig();
  const tick = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const j = await jsonCli(cfg, ['getblockchaininfo']);
      if (j && !j._warmup && isBlockchainReady(j)) {
        mainWindow.webContents.send('node:health', { ok: true, blocks: j.blocks });
      } else if (j && j._warmup) {
        mainWindow.webContents.send('node:health', { ok: true, warmup: true });
      } else {
        mainWindow.webContents.send('node:health', { ok: true, blocks: undefined });
      }
    } catch (e) {
      const m = String(e.message || '').toLowerCase();
      if (isWarmupDetail(m)) {
        mainWindow.webContents.send('node:health', { ok: true, warmup: true });
        return;
      }
      mainWindow.webContents.send('node:health', {
        ok: false,
        error: toUserMessage(e),
      });
    }
  };
  nodeHealthTimer = setInterval(() => {
    tick().catch(() => {});
  }, HEALTH_POLL_MS);
  tick().catch(() => {});
}

function emitMiningStatus(extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cfg = loadConfig();
  const threads = Math.min(16, Math.max(1, parseInt(cfg.miningThreads, 10) || 1));
  mainWindow.webContents.send('mining:status', {
    active: isMiningActive,
    address: miningAddress || '',
    intervalMs: getEffectiveMiningIntervalMs(cfg),
    threads,
    ...extra,
  });
}

function stopAutoMiningInternal(reason = '') {
  if (miningInterval) {
    clearInterval(miningInterval);
    miningInterval = null;
  }
  isMiningActive = false;
  miningAddress = '';
  miningTickInProgress = false;
  emitMiningStatus({ reason });
  return { ok: true, active: false, reason };
}

async function runAutoMiningTick() {
  if (!isMiningActive || miningTickInProgress) return;
  miningTickInProgress = true;
  try {
    const cfg = loadConfig();
    if (!(await synorixdRunning(cfg))) {
      stopAutoMiningInternal('Node çalışmıyor, arka plan mining durduruldu.');
      return;
    }
    const wr = await waitForRPCReady(cfg);
    if (!wr.ok) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mining:error', { message: wr.message || MSG_RPC_TIMEOUT });
      }
      return;
    }
    const activeWallet = getActiveWalletName(cfg);
    let addr = String(miningAddress || '').trim();
    if (!addr) {
      await autoLoadOrCreateActiveWallet(cfg);
      addr = (await runWalletCliOnce(cfg, getActiveWalletName(cfg), ['getnewaddress'])).trim();
      miningAddress = addr;
    }
    if (!addr) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mining:error', {
          message: 'Madencilik adresi yok; getnewaddress başarısız.',
        });
      }
      return;
    }
    const out = await runWalletCliOnce(cfg, activeWallet, ['generatetoaddress', '1', addr]);
    let count = 1;
    try {
      const parsed = JSON.parse(out);
      if (Array.isArray(parsed)) count = parsed.length || 1;
    } catch {
      /* keep fallback */
    }
    let blockHeight = null;
    try {
      const info = await jsonCli(cfg, ['getblockchaininfo']);
      if (info && Number.isFinite(Number(info.blocks))) {
        blockHeight = Number(info.blocks);
      }
    } catch {
      /* keep null */
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      pushMiningTickTime();
      mainWindow.webContents.send('mining:tick', { count, blockHeight });
    }
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mining:error', { message: toUserMessage(e) });
    }
  } finally {
    miningTickInProgress = false;
  }
}

/**
 * Otomatik madenciliği başlatır.
 * Arayüzdeki adres kullanılmaz; yalnızca düğümün getnewaddress çıktısı (ağ uyumlu) generatetoaddress için kullanılır.
 */
async function startAutoMining() {
  const cfg = loadConfig();
  const wr = await waitForRPCReady(cfg);
  if (!wr.ok) throw new Error(wr.message || MSG_RPC_TIMEOUT);

  await autoLoadOrCreateActiveWallet(cfg);
  const activeWallet = getActiveWalletName(cfg);
  let nodeAddr;
  try {
    nodeAddr = (await runWalletCliOnce(cfg, activeWallet, ['getnewaddress'])).trim();
  } catch (e) {
    if (e instanceof RpcWarmupError) throw new Error(MSG_RPC_WARMUP);
    throw new Error(toUserMessage(e));
  }
  if (!nodeAddr) {
    throw new Error('Düğümden madencilik adresi alınamadı (getnewaddress). Cüzdan yüklü mü kontrol edin.');
  }

  miningAddress = nodeAddr;
  isMiningActive = true;
  if (miningInterval) {
    clearInterval(miningInterval);
    miningInterval = null;
  }
  emitMiningStatus({ started: true });

  // Produce first block immediately, then continue every 2.5 minutes.
  await runAutoMiningTick();
  if (!isMiningActive) return { ok: false, active: false };

  const intervalMs = getEffectiveMiningIntervalMs(cfg);
  miningInterval = setInterval(() => {
    void runAutoMiningTick();
  }, intervalMs);

  return { ok: true, active: true, intervalMs };
}

/**
 * Build a compact status payload for the dashboard.
 * Values are fetched from WSL via synorix-cli and normalized for UI.
 */
async function collectGeneralStatus(cfg) {
  const snapshot = {
    nodeRunning: false,
    rpcReady: false,
    warmup: false,
    blocks: null,
    lastBlockTime: null,
    connections: null,
    balance: null,
    message: '',
  };

  snapshot.nodeRunning = await synorixdRunning(cfg);
  if (!snapshot.nodeRunning) {
    snapshot.message = MSG_RPC_OFFLINE;
    return snapshot;
  }

  const info = await jsonCli(cfg, ['getblockchaininfo']);
  if (info && info._warmup) {
    snapshot.warmup = true;
    snapshot.message = MSG_RPC_WARMUP;
    return snapshot;
  }
  snapshot.rpcReady = isBlockchainReady(info);
  if (!snapshot.rpcReady) {
    snapshot.message = MSG_RPC_WARMUP;
    return snapshot;
  }

  snapshot.blocks = Number.isFinite(Number(info.blocks)) ? Number(info.blocks) : null;
  snapshot.lastBlockTime = Number.isFinite(Number(info.time)) ? Number(info.time) : null;

  try {
    const out = await runCliOnce(cfg, ['getconnectioncount']);
    const n = parseInt(out, 10);
    snapshot.connections = Number.isFinite(n) ? n : null;
  } catch {
    snapshot.connections = null;
  }

  try {
    const activeWallet = getActiveWalletName(cfg);
    const out = await runWalletCliOnce(cfg, activeWallet, ['getbalance']);
    const v = parseFloat(out);
    snapshot.balance = Number.isFinite(v) ? v : null;
  } catch {
    snapshot.balance = null;
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// Pencere
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 860,
    minWidth: 720,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Synorix Testnet (WSL)',
  });
  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
}

app.whenReady().then(() => {
  logSynorixSampleAddresses();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAutoMiningInternal('Uygulama kapanıyor, mining durduruldu.');
  stopNodeHealthMonitor();
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('wsl:envCheck', async () => checkWslEnvironment());

ipcMain.handle('paths:get', () => {
  const c = loadConfig();
  return {
    distro: c.wslDistro,
    datadir: c.datadir,
    synorixdPath: c.synorixdPath,
    synorixCliPath: c.synorixCliPath,
    wallets: getWalletList(c),
    activeWallet: getActiveWalletName(c),
    configFile: configPath(),
    treasuryAddress: c.treasuryAddress || DEFAULT_TREASURY_ADDRESS,
  };
});

ipcMain.handle('app:getVersion', () => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
});

ipcMain.handle('config:getTheme', () => {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return String(raw.theme || 'dark');
  } catch { return 'dark'; }
});

ipcMain.handle('config:setTheme', (_e, { theme }) => {
  const t = theme === 'light' ? 'light' : 'dark';
  saveConfig({ theme: t });
  return t;
});

ipcMain.handle('node:start', async () => {
  try {
    stopAutoMiningInternal('Node yeniden başlatılıyor, mining durduruldu.');
    const env = await checkWslEnvironment();
    if (!env.ok) {
      throw new Error(env.message);
    }
    const cfg = loadConfig();

    if (await synorixdRunning(cfg)) {
      stopNodeHealthMonitor();
      /* Çalışan süreç varken synorix.conf yazma; mevcut düğümle RPC eşleşmeli */
      const wr = await waitForRPCReady(cfg);
      if (!wr.ok) {
        throw new Error(wr.message);
      }
      startNodeHealthMonitor();

      await autoLoadOrCreateActiveWallet(cfg);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('node:health', { ok: true, started: true, attached: true });
      }
      return { ok: true, mode: 'attached', rpcReady: true };
    }

    stopNodeHealthMonitor();
    await ensureDatadirWsl(cfg);
    await ensureSynorixConfWsl(cfg);
    await startSynorixdDaemon(cfg);

    const wr = await waitForRPCReady(cfg);
    if (!wr.ok) {
      throw new Error(wr.message);
    }
    startNodeHealthMonitor();

    // Aktif cüzdanı otomatik yükle; yoksa oluştur
    await autoLoadOrCreateActiveWallet(cfg);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('node:health', { ok: true, started: true });
    }
    return { ok: true, mode: 'fresh', rpcReady: true };
  } catch (e) {
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('node:stop', async () => {
  try {
    const env = await checkWslEnvironment();
    if (!env.ok) {
      throw new Error(env.message);
    }
    const cfg = loadConfig();
    stopAutoMiningInternal('Node durduruldu, mining durduruldu.');
    stopNodeHealthMonitor();

    try {
      await runCliOnce(cfg, ['stop']);
    } catch {
      /* süreç yoksa hata normal */
    }

    await sleep(2000);

    await new Promise((resolve) => {
      execFile(
        WSL_EXE,
        ['-d', cfg.wslDistro, '-e', 'pkill', '-x', 'synorixd'],
        { windowsHide: true },
        () => resolve(),
      );
    });

    await sleep(500);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('node:health', { ok: false, stopped: true });
    }

    return { ok: true };
  } catch (e) {
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('rpc:getblockchaininfo', async () => {
  try {
    const cfg = loadConfig();
    const j = await jsonCli(cfg, ['getblockchaininfo']);
    if (j && j._warmup) return { _warmup: true };
    return j;
  } catch (e) {
    const m = String(e.message || '').toLowerCase();
    if (
      m.includes('could not connect') ||
      m.includes('connection refused') ||
      m.includes('eof') ||
      m.includes('could not locate rpc')
    ) {
      return { _offline: true };
    }
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('rpc:getgeneralstatus', async () => {
  try {
    const cfg = loadConfig();
    return await collectGeneralStatus(cfg);
  } catch (e) {
    const m = String(e.message || '').toLowerCase();
    if (
      m.includes('could not connect') ||
      m.includes('connection refused') ||
      m.includes('eof') ||
      m.includes('could not locate rpc')
    ) {
      return {
        nodeRunning: false,
        rpcReady: false,
        warmup: false,
        blocks: null,
        lastBlockTime: null,
        connections: null,
        balance: null,
        message: MSG_RPC_OFFLINE,
      };
    }
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('rpc:getconnectioncount', async () => {
  try {
    const cfg = loadConfig();
    const out = await runCliOnce(cfg, ['getconnectioncount']);
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
});

ipcMain.handle('rpc:waitForRPCReady', async () => {
  const cfg = loadConfig();
  return waitForRPCReady(cfg);
});

// ---------------------------------------------------------------------------
// Basit RPC hazır kontrolü (tek çağrı, bekleme yok)
// ---------------------------------------------------------------------------

async function quickRpcCheck(cfg) {
  try {
    const out = await runCliOnce(cfg, ['getblockchaininfo']);
    const j = JSON.parse(out);
    return isBlockchainReady(j);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wallet IPC handler'ları — tek cüzdan (default)
// ---------------------------------------------------------------------------

ipcMain.handle('wallet:newaddress', async () => {
  try {
    const cfg = loadConfig();
    const activeWallet = getActiveWalletName(cfg);
    if (!(await quickRpcCheck(cfg))) throw new Error(MSG_RPC_NOT_READY);
    return await runWalletCliOnce(cfg, activeWallet, ['getnewaddress']);
  } catch (e) {
    if (e instanceof RpcWarmupError) throw new Error(MSG_RPC_WARMUP);
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('wallet:autoloadActive', async () => {
  try {
    const cfg = loadConfig();
    if (!(await quickRpcCheck(cfg))) return { ok: false, message: MSG_RPC_NOT_READY };
    await autoLoadOrCreateActiveWallet(cfg);
    return { ok: true, activeWallet: getActiveWalletName(cfg) };
  } catch (e) {
    return { ok: false, message: toUserMessage(e) };
  }
});

ipcMain.handle('wallet:getbalance', async () => {
  try {
    const cfg = loadConfig();
    const activeWallet = getActiveWalletName(cfg);
    const out = await runWalletCliOnce(cfg, activeWallet, ['getbalance']);
    const v = parseFloat(out);
    return { walletName: activeWallet, balance: Number.isFinite(v) ? v : null };
  } catch {
    const cfg = loadConfig();
    return { walletName: getActiveWalletName(cfg), balance: null };
  }
});

ipcMain.handle('wallet:getDisplayReceiveAddress', async () => {
  try {
    const cfg = loadConfig();
    if (!(await quickRpcCheck(cfg))) return { address: null };
    const activeWallet = getActiveWalletName(cfg);
    const out = await runWalletCliOnce(cfg, activeWallet, ['listreceivedbyaddress', '0', 'true', 'true']);
    let arr;
    try {
      arr = JSON.parse(out);
    } catch {
      arr = [];
    }
    if (Array.isArray(arr) && arr.length > 0 && arr[0].address) {
      return { address: String(arr[0].address) };
    }
    const fresh = await runWalletCliOnce(cfg, activeWallet, ['getnewaddress', '', 'bech32']);
    return { address: String(fresh || '').trim() || null };
  } catch (e) {
    if (e instanceof RpcWarmupError) return { address: null };
    return { address: null };
  }
});

ipcMain.handle('wallet:sendToAddress', async (_e, { address, amount }) => {
  const cfg = loadConfig();
  const activeWallet = getActiveWalletName(cfg);
  const wr = await waitForRPCReady(cfg);
  if (!wr.ok) throw new Error(wr.message || MSG_RPC_TIMEOUT);
  const addr = String(address || '').trim();
  const amt = Number(amount);
  if (!addr) throw new Error('Hedef adres gerekli.');
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Geçerli SNRX miktarı girin.');
  try {
    const out = await runWalletCliOnce(cfg, activeWallet, ['sendtoaddress', addr, String(amt)]);
    return { ok: true, txid: String(out || '').trim() };
  } catch (e) {
    if (e instanceof RpcWarmupError) throw new Error(MSG_RPC_WARMUP);
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('wallet:listTransactionsRecent', async (_e, { count } = {}) => {
  const cfg = loadConfig();
  const activeWallet = getActiveWalletName(cfg);
  const wr = await waitForRPCReady(cfg);
  if (!wr.ok) return { ok: false, transactions: [], message: wr.message };
  const n = Math.min(50, Math.max(1, parseInt(count, 10) || 5));
  try {
    const out = await runWalletCliOnce(cfg, activeWallet, ['listtransactions', '*', String(n)]);
    const arr = JSON.parse(out);
    return { ok: true, transactions: Array.isArray(arr) ? arr : [] };
  } catch (e) {
    return { ok: false, transactions: [], message: toUserMessage(e) };
  }
});

ipcMain.handle('rpc:peerNetworkSummary', async () => {
  const cfg = loadConfig();
  if (!(await quickRpcCheck(cfg))) {
    return { ok: false, peerCount: 0, connections: null, subversion: null };
  }
  try {
    const peers = await jsonCli(cfg, ['getpeerinfo']);
    const net = await jsonCli(cfg, ['getnetworkinfo']);
    if (peers && peers._warmup) return { ok: false, peerCount: 0, connections: null, subversion: null };
    const peerCount = Array.isArray(peers) ? peers.length : 0;
    let connections = peerCount;
    if (net && !net._warmup && Number.isFinite(Number(net.connections))) {
      connections = Number(net.connections);
    }
    const subversion = net && !net._warmup && net.subversion ? String(net.subversion) : null;
    return { ok: true, peerCount, connections, subversion };
  } catch {
    return { ok: false, peerCount: 0, connections: null, subversion: null };
  }
});

ipcMain.handle('rpc:treasuryBalance', async () => {
  const cfg = loadConfig();
  const addr = String(cfg.treasuryAddress || '').trim() || DEFAULT_TREASURY_ADDRESS;
  const wr = await waitForRPCReady(cfg);
  if (!wr.ok) return { balance: null, address: addr, error: wr.message };
  try {
    const jsonArg = JSON.stringify([`addr(${addr})`]);
    const raw = await runCliOnce(cfg, ['scantxoutset', 'start', jsonArg]);
    const j = JSON.parse(raw);
    if (!j || j.success !== true) {
      return { balance: null, address: addr, error: 'scantxoutset başarısız veya devre dışı.' };
    }
    const bal = Number(j.total_amount);
    return { balance: Number.isFinite(bal) ? bal : 0, address: addr, error: null };
  } catch (e) {
    return { balance: null, address: addr, error: toUserMessage(e) };
  }
});

ipcMain.handle('util:qrDataUrl', async (_e, { text } = {}) => {
  const t = String(text || '').trim();
  if (!t) return { ok: false };
  try {
    const dataUrl = await QRCode.toDataURL(t, {
      width: 220,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#38bdf8', light: '#0f172a' },
    });
    return { ok: true, dataUrl };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('mining:generatetoaddress', async (_e, { nblocks, address }) => {
  try {
    const cfg = loadConfig();
    const activeWallet = getActiveWalletName(cfg);
    const wr = await waitForRPCReady(cfg);
    if (!wr.ok) {
      throw new Error(wr.message);
    }
    const n = Math.min(Math.max(1, parseInt(nblocks, 10) || 1), 100);
    const out = await runWalletCliOnce(cfg, activeWallet, ['generatetoaddress', String(n), address]);
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error('Mining yanıtı okunamadı. Düğüm cüzdanlı derlenmiş ve mining RPC açık olmalı.');
    }
    return { count: Array.isArray(parsed) ? parsed.length : 0 };
  } catch (e) {
    if (e instanceof RpcWarmupError) {
      throw new Error(MSG_RPC_WARMUP);
    }
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('mining:startAuto', async () => {
  try {
    const result = await startAutoMining();
    return { ...result, miningAddress };
  } catch (e) {
    if (e instanceof RpcWarmupError) {
      throw new Error(MSG_RPC_WARMUP);
    }
    throw new Error(toUserMessage(e));
  }
});

ipcMain.handle('mining:stopAuto', async () => {
  return stopAutoMiningInternal('Mining durduruldu.');
});

ipcMain.handle('mining:getAutoStatus', async () => {
  const cfg = loadConfig();
  const threads = Math.min(16, Math.max(1, parseInt(cfg.miningThreads, 10) || 1));
  return {
    active: isMiningActive,
    address: miningAddress,
    intervalMs: getEffectiveMiningIntervalMs(cfg),
    threads,
    activeWalletName: getActiveWalletName(cfg),
  };
});

ipcMain.handle('mining:setThreads', (_e, { n }) => {
  const t = Math.min(16, Math.max(1, parseInt(n, 10) || 1));
  saveConfig({ miningThreads: t });
  restartMiningIntervalIfNeeded();
  return { ok: true, miningThreads: t, intervalMs: getEffectiveMiningIntervalMs(loadConfig()) };
});

ipcMain.handle('rpc:getnetworkhashps', async (_e, { nblocks } = {}) => {
  try {
    const cfg = loadConfig();
    const nb = Math.min(144, Math.max(1, parseInt(nblocks, 10) || 120));
    const out = await runCliOnce(cfg, ['getnetworkhashps', String(nb)]);
    const v = parseFloat(out);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
});

ipcMain.handle('mining:getLocalHashEstimate', async () => ({
  blocksPerHour: localBlocksPerHourEstimate(),
  tickCount: miningTickTimes.length,
}));

ipcMain.handle('sys:getHostMetrics', async () => {
  try {
    const load = await si.currentLoad();
    const temp = await si.cpuTemperature();
    let cpuTempC = null;
    if (temp && typeof temp.main === 'number' && temp.main > 0) cpuTempC = temp.main;
    else if (Array.isArray(temp.cores)) {
      const vals = temp.cores.filter((x) => typeof x === 'number' && x > 0);
      if (vals.length) cpuTempC = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return {
      cpuLoadPercent: typeof load.currentLoad === 'number' ? load.currentLoad : null,
      cpuTempC,
    };
  } catch {
    return { cpuLoadPercent: null, cpuTempC: null };
  }
});

// ---------------------------------------------------------------------------
// HD seed IPC
// ---------------------------------------------------------------------------

ipcMain.handle('seed:getStatus', async () => {
  const meta = readHdMeta();
  const cfg = loadConfig();
  return {
    hasSeed: hasStoredHdSeed(),
    wordCount: meta.wordCount || null,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    skipped: Boolean(cfg.hdWalletSkipped),
  };
});

ipcMain.handle('seed:generate', async (_e, { strength } = {}) => {
  const ent = strength === 256 ? 256 : 128;
  const mnemonic = bip39.generateMnemonic(ent);
  return { mnemonic, wordCount: ent === 256 ? 24 : 12 };
});

ipcMain.handle('seed:commit', async (_e, { mnemonic }) => {
  const m = String(mnemonic || '')
    .trim()
    .replace(/\s+/g, ' ');
  const wc = m.split(/\s+/).filter(Boolean).length;
  if (wc !== 12 && wc !== 24) {
    throw new Error('12 veya 24 kelime olmalıdır.');
  }
  saveMnemonicToDisk(m, wc);
  return { ok: true, wordCount: wc };
});

ipcMain.handle('seed:import', async (_e, { mnemonic }) => {
  const m = String(mnemonic || '')
    .trim()
    .replace(/\s+/g, ' ');
  const wc = m.split(/\s+/).filter(Boolean).length;
  if (wc !== 12 && wc !== 24) {
    throw new Error('12 veya 24 kelime olmalıdır.');
  }
  saveMnemonicToDisk(m, wc);
  return { ok: true, wordCount: wc };
});

ipcMain.handle('seed:skipWizard', async () => {
  saveConfig({ hdWalletSkipped: true });
  return { ok: true };
});

ipcMain.handle('seed:clear', async () => {
  try {
    fs.unlinkSync(hdSeedPath());
  } catch {
    /* yok */
  }
  try {
    fs.unlinkSync(hdMetaPath());
  } catch {
    /* yok */
  }
  saveConfig({ hdWalletSkipped: false });
  return { ok: true };
});

ipcMain.handle('seed:listAddresses', async (_e, { start, count } = {}) => {
  if (!hasStoredHdSeed()) return { addresses: [] };
  const mnemonic = loadMnemonicFromDisk();
  const s = Math.max(0, parseInt(start, 10) || 0);
  const c = Math.min(20, Math.max(1, parseInt(count, 10) || 5));
  return { addresses: deriveHdAddresses(mnemonic, s, c) };
});

ipcMain.handle('seed:exportMnemonic', async () => {
  if (!hasStoredHdSeed()) return { ok: false, message: 'Kayıtlı HD seed yok.' };
  try {
    return { ok: true, mnemonic: loadMnemonicFromDisk() };
  } catch (e) {
    return { ok: false, message: toUserMessage(e) };
  }
});
