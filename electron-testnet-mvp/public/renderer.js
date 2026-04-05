const $ = (id) => document.getElementById(id);

const logEl = $('log');

const MSG_NODE_START_SKIP_GENESIS = 'Node başlatılıyor... (Genesis doğrulama atlandı)';
const MSG_WSL_NODE_STARTING = 'WSL üzerinden node başlatılıyor (Linux synorixd + Linux veri klasörü).';
const MSG_RPC_PREPARING_RETRY = 'RPC hazırlanıyor, lütfen 10 saniye daha bekleyin.';
const MSG_RPC_CONN_FAILED =
  'RPC bağlantısı kurulamadı. Node\'u durdurup tekrar başlatın.';
/** Ana süreç IPC’de ASCII hata döndürebilir; panelde Türkçe özet (humanError eşler). */
const MSG_RPC_TIMED_OUT =
  'RPC zaman aşımına uğradı. Gerekirse Görev Yöneticisi’nden synorixd’i kapatıp «Testnet node’u başlat»a tekrar basın.';
/** “Testnet node’u başlat” sonrası paneli zorunlu “Node hazır” yap (main wait’ten bağımsız). */
const NODE_FORCE_READY_MS = 40000;

let nodeForceReadyTimer = null;

function clearNodeForceReadyTimer() {
  if (nodeForceReadyTimer != null) {
    clearTimeout(nodeForceReadyTimer);
    nodeForceReadyTimer = null;
  }
}

let pollTimer = null;
let cfg = { synorixdPath: '', synorixCliPath: '', synorixBinDir: '' };
let miningBusy = false;
let lastMiningText = 'Pasif';

/** node:start IPC beklerken cüzdan/mining kapalı */
let nodeStartInProgress = false;

function setNodeStartInProgress(on) {
  nodeStartInProgress = Boolean(on);
}

function humanError(err) {
  const raw = String(err?.message || err || '');
  if (raw.includes('Node henüz hazır değil')) {
    return raw;
  }
  const m = raw.toLowerCase();
  if (m.includes('could not connect') || m.includes('connection refused') || m.includes('econnrefused')) {
    return 'Node henüz hazır değil. Lütfen 30 saniye daha bekleyin.';
  }
  if (m.includes('method not found') && m.includes('generatetoaddress')) {
    return 'Mining RPC bu düğümde kapalı olabilir veya cüzdan devre dışı derleme kullanılıyor.';
  }
  if (m.includes('invalid address')) {
    return 'Geçersiz adres. Testnet adresi (ör. tsnrx1…) kullanın.';
  }
  if (m.includes('wallet') && m.includes('not found')) {
    return 'Cüzdan yok. Önce “Cüzdan oluştur” deyin.';
  }
  if (m.includes('empty wallet')) {
    return 'Cüzdan boş veya adres üretilemedi. Önce cüzdan oluşturun.';
  }
  if (m.includes('verifying block') || m.includes('error code: -28') || m.includes('in warmup')) {
    return 'RPC henüz hazır değil; birkaç saniye sonra tekrar deneyin.';
  }
  if (raw.includes('RPC hazırlanıyor')) {
    return MSG_RPC_PREPARING_RETRY;
  }
  if (raw.includes('RPC bağlantısı kurulamadı')) {
    return MSG_RPC_CONN_FAILED;
  }
  if (
    raw.includes('Node\'u durdurup tekrar başlatın') ||
    raw.includes("Node'u durdurup tekrar başlatın") ||
    m.includes('rpc timed out')
  ) {
    return MSG_RPC_TIMED_OUT;
  }
  return raw || 'Beklenmeyen bir hata oluştu.';
}

function log(msg, isErr = false) {
  const line = `[${new Date().toLocaleTimeString('tr-TR')}] ${msg}\n`;
  logEl.textContent = line + logEl.textContent.slice(0, 4000);
  logEl.style.color = isErr ? 'var(--err)' : 'var(--muted)';
}

/** Başlat sonrası 20 sn dolmadan: rozet “Node çalışıyor”. */
function applyNodeRunningWarmupUi() {
  $('dotNode').className = 'status-dot on';
  $('stNodeRun').textContent = 'Node çalışıyor';
  $('nodeBadge').textContent = 'Node çalışıyor';
  $('nodeBadge').className = 'badge badge-warn';
}

function setNodeRunningUi(running, opts = {}) {
  const fullyReady = Boolean(opts.fullyReady);
  const dot = $('dotNode');
  const val = $('stNodeRun');
  if (running) {
    dot.className = 'status-dot on';
    val.textContent = fullyReady ? 'Node hazır' : 'Node çalışıyor';
    if (fullyReady) {
      $('nodeBadge').textContent = 'Node hazır';
      $('nodeBadge').className = 'badge badge-ok';
    }
  } else {
    dot.className = 'status-dot off';
    val.textContent = 'Durdu';
    $('nodeBadge').textContent = 'Node RPC: yok';
    $('nodeBadge').className = 'badge badge-off';
  }
}

function formatWalletBalance(bal) {
  if (bal === null) return '…';
  if (Number.isFinite(bal)) return `${bal.toFixed(8)} SNRX`;
  return '—';
}

function setWalletMiningActionsEnabled(enabled, titleWhenDisabled = '') {
  const ids = ['btnCreateWallet', 'btnNewAddr', 'btnMine', 'mineN', 'mineAddr'];
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    el.disabled = !enabled;
    el.title = enabled ? '' : titleWhenDisabled;
  }
}

function updateWalletMiningFromNodeState(state) {
  if (state === 'ready') {
    setWalletMiningActionsEnabled(true);
  } else if (state === 'starting') {
    setWalletMiningActionsEnabled(false, 'Node başlatılıyor / RPC hazırlanıyor…');
  } else {
    setWalletMiningActionsEnabled(false, 'Önce “Testnet node’u başlat” deyin.');
  }
}

function showBinUi(result) {
  const ok = result.ok;
  $('binOk').hidden = !ok;
  $('binErr').hidden = ok;
  if (ok) {
    $('pathDShow').textContent = result.synorixdPath;
    $('pathCliShow').textContent = result.synorixCliPath;
    $('pathD').value = result.synorixdPath;
    $('pathCli').value = result.synorixCliPath;
    cfg.synorixdPath = result.synorixdPath;
    cfg.synorixCliPath = result.synorixCliPath;
  } else {
    $('binErrHint').textContent = result.hint || 'Dosyalar bulunamadı.';
    $('pathD').value = '';
    $('pathCli').value = '';
    cfg.synorixdPath = '';
    cfg.synorixCliPath = '';
  }
}

async function refreshBinaries() {
  const result = await window.synorix.binariesResolve();
  showBinUi(result);
  return result;
}

async function saveCfg() {
  const prev = await window.synorix.configGet();
  cfg = {
    ...prev,
    synorixdPath: $('pathD').value.trim(),
    synorixCliPath: $('pathCli').value.trim(),
  };
  await window.synorix.configSet(cfg);
}

async function refreshPickedDirLabel() {
  const c = await window.synorix.configGet();
  const el = $('pickedBinDirLabel');
  if (!el) return;
  el.textContent = c.synorixBinDir ? `Kayıtlı: ${c.synorixBinDir}` : '';
}

async function pickBuildBinFolder() {
  const dir = await window.synorix.pickBinDirectory(
    'synorixd ve synorix-cli dosyalarının bulunduğu klasörü seçin (örn. build/bin)',
  );
  if (!dir) return;
  const prev = await window.synorix.configGet();
  await window.synorix.configSet({ ...prev, synorixBinDir: dir });
  await refreshPickedDirLabel();
  const r = await refreshBinaries();
  log(
    r.ok ? `Binary bulundu (${r.synorixdPath})` : 'Seçilen klasörde synorixd / synorix-cli bulunamadı.',
    !r.ok,
  );
  if (r.ok) startPoll();
}

/** main.js isBlockchainInfoRpcReady ile aynı: yalnizca blocks sayisal >= 0. */
function blockchainInfoLooksRpcReady(info) {
  if (!info || info._offline || info._warmup) return false;
  if (!('blocks' in info)) return false;
  const b = Number(info.blocks);
  return Number.isFinite(b) && b >= 0;
}

async function refreshStatus() {
  const r = await window.synorix.binariesResolve();
  if (!r.ok) {
    setNodeStartInProgress(false);
    setNodeRunningUi(false);
    $('stConn').textContent = '—';
    $('stBlocks').textContent = '—';
    $('stIbd').textContent = '—';
    $('nodeBadge').textContent = 'Binary yok';
    $('nodeBadge').className = 'badge badge-off';
    updateWalletMiningFromNodeState('off');
    return;
  }
  cfg.synorixdPath = r.synorixdPath;
  cfg.synorixCliPath = r.synorixCliPath;
  try {
    const info = await window.synorix.getBlockchainInfo(cfg.synorixCliPath);
    if (info && info._offline) {
      setNodeStartInProgress(false);
      setNodeRunningUi(false);
      $('stConn').textContent = '—';
      $('stBlocks').textContent = '—';
      $('stIbd').textContent = '—';
      $('stBal').textContent = '—';
      $('nodeBadge').textContent = 'Node RPC: yok';
      $('nodeBadge').className = 'badge badge-off';
      updateWalletMiningFromNodeState('off');
      setMiningUi();
      return;
    }

    const warmup = Boolean(info && info._warmup);
    const rpcReadyUi = !warmup && blockchainInfoLooksRpcReady(info);

    if (nodeStartInProgress) {
      applyNodeRunningWarmupUi();
    } else if (rpcReadyUi) {
      setNodeRunningUi(true, { fullyReady: true });
    } else if (!warmup) {
      setNodeRunningUi(true, { fullyReady: false });
      $('nodeBadge').textContent = 'Node çalışıyor';
      $('nodeBadge').className = 'badge badge-warn';
    } else {
      applyNodeRunningWarmupUi();
    }

    if (warmup) {
      $('stIbd').textContent = 'RPC başlangıç (warmup)…';
      $('stBlocks').textContent = '…';
      $('stConn').textContent = '—';
    } else {
      const vp = Number(info.verificationprogress);
      const vpStr = Number.isFinite(vp) ? `${(vp * 100).toFixed(1)}%` : '—';
      const ibd =
        info.initialblockdownload === true
          ? 'evet'
          : info.initialblockdownload === false
            ? 'hayır'
            : '—';
      $('stIbd').textContent = `Genesis doğrulama atlandı · ilerleme: ${vpStr} · IBD: ${ibd}`;
      try {
        const n = await window.synorix.getConnectionCount(cfg.synorixCliPath);
        $('stConn').textContent = n != null && Number.isFinite(n) ? String(n) : '—';
      } catch {
        $('stConn').textContent = '—';
      }
      $('stBlocks').textContent = info.blocks != null ? String(info.blocks) : '—';
    }

    if (nodeStartInProgress) {
      updateWalletMiningFromNodeState('starting');
    } else if (rpcReadyUi) {
      updateWalletMiningFromNodeState('ready');
    } else {
      updateWalletMiningFromNodeState('starting');
    }

    try {
      const bal = await window.synorix.walletBalance(cfg.synorixCliPath);
      $('stBal').textContent = formatWalletBalance(bal);
    } catch {
      $('stBal').textContent = 'cüzdan yok';
    }
  } catch {
    setNodeStartInProgress(false);
    setNodeRunningUi(false);
    $('stConn').textContent = '—';
    $('stBlocks').textContent = '—';
    $('stIbd').textContent = '—';
    updateWalletMiningFromNodeState('off');
  }
  setMiningUi();
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(refreshStatus, 2000);
  refreshStatus();
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function requireBinaries() {
  const r = await refreshBinaries();
  if (!r.ok) {
    log('synorixd ve synorix-cli bulunamadı. “Binary’leri indir” veya uygulama klasörüne kopyalayın.', true);
    return null;
  }
  return r;
}

async function guardRpcReadyForWallet(cliPath) {
  if (typeof window.synorix.waitForRPCReady !== 'function') return true;
  const out = await window.synorix.waitForRPCReady(cliPath);
  if (!out.ok) {
    log(out.message || MSG_RPC_TIMED_OUT, true);
    return false;
  }
  return true;
}

function setMiningUi() {
  const dot = $('dotMine');
  const val = $('stMining');
  if (miningBusy) {
    dot.className = 'status-dot warn';
    val.textContent = 'İşleniyor…';
    return;
  }
  dot.className = 'status-dot off';
  val.textContent = lastMiningText;
}

$('btnPickBuildDir').addEventListener('click', pickBuildBinFolder);
$('btnPickBuildDirErr').addEventListener('click', pickBuildBinFolder);

$('btnRescan').addEventListener('click', async () => {
  await refreshPickedDirLabel();
  const r = await refreshBinaries();
  log(r.ok ? 'Programlar bulundu.' : humanError({ message: r.hint }), !r.ok);
  if (r.ok) startPoll();
});

$('btnRescan2').addEventListener('click', async () => {
  await refreshPickedDirLabel();
  const r = await refreshBinaries();
  log(r.ok ? 'Programlar bulundu.' : 'Hâlâ bulunamadı.', !r.ok);
  if (r.ok) startPoll();
});

$('btnDownloadBin').addEventListener('click', async () => {
  try {
    await window.synorix.openReleases();
    log('GitHub Releases açıldı. İndirdikten sonra dosyaları uygulama yanına koyup “Tekrar dene” deyin.');
  } catch (e) {
    log(humanError(e), true);
  }
});

$('btnPickD').addEventListener('click', async () => {
  const p = await window.synorix.pickBinary('synorixd seç');
  if (p) $('pathD').value = p;
});

$('btnPickCli').addEventListener('click', async () => {
  const p = await window.synorix.pickBinary('synorix-cli seç');
  if (p) $('pathCli').value = p;
});

$('btnSaveManual').addEventListener('click', async () => {
  await saveCfg();
  const r = await refreshBinaries();
  if (r.ok) {
    log('Manuel yollar kaydedildi.');
    startPoll();
  } else {
    log('Her iki dosya da geçerli ve erişilebilir olmalı.', true);
  }
});

$('btnOpenData').addEventListener('click', async () => {
  await window.synorix.openDatadir();
  const paths = await window.synorix.pathsGet();
  if (paths.useWsl && paths.datadirUnc) {
    log(`Veri klasörü (WSL): ${paths.datadir} — Explorer: ${paths.datadirUnc}`);
  } else {
    log(`Veri klasörü: ${paths.datadir}`);
  }
});

$('btnStartNode').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;

  clearNodeForceReadyTimer();
  setNodeStartInProgress(true);
  applyNodeRunningWarmupUi();
  $('stIbd').textContent = 'Genesis doğrulama atlandı · RPC bekleniyor…';
  updateWalletMiningFromNodeState('starting');
  log(MSG_NODE_START_SKIP_GENESIS);
  if (r.useWsl) {
    log(MSG_WSL_NODE_STARTING);
  }
  log('Ana süreç: synorix.conf zorla yazılır; RPC için 40 sn bekleme + 2 sn yoklama (toplam tavan ~240 sn).');

  nodeForceReadyTimer = setTimeout(() => {
    nodeForceReadyTimer = null;
    setNodeRunningUi(true, { fullyReady: true });
    updateWalletMiningFromNodeState('ready');
    setNodeStartInProgress(false);
    log('Node hazır (40 sn — panel zorunlu güncellendi).');
    void refreshStatus();
  }, NODE_FORCE_READY_MS);

  try {
    const start = await window.synorix.nodeStart(r.synorixdPath, r.synorixCliPath);
    if (start.rpcReady) {
      if (start.datadirCleared) {
        log('Veri klasörü sıfırlandı (temiz chainstate + synorix.conf).');
      }
      if (start.mode === 'attached-existing') {
        log(start.wsl ? 'Mevcut synorixd (WSL): RPC hazır — Node hazır.' : 'Mevcut synorixd: RPC hazır — Node hazır.');
      } else if (start.wsl) {
        log('Node hazır (WSL) — RPC yanıt veriyor; cüzdan ve mining kullanılabilir.');
      } else {
        log('Node hazır — RPC yanıt veriyor; cüzdan ve mining kullanılabilir.');
      }
      setNodeRunningUi(true, { fullyReady: true });
      updateWalletMiningFromNodeState('ready');
    } else {
      log(`Düğüm başlatıldı (${start.mode}).`);
    }
    startPoll();
  } catch (e) {
    clearNodeForceReadyTimer();
    log(String(e?.message || e), true);
    void refreshStatus();
  } finally {
    setNodeStartInProgress(false);
    void refreshStatus();
  }
});

$('btnStopNode').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;
  try {
    clearNodeForceReadyTimer();
    await window.synorix.nodeStop(r.synorixCliPath);
    setNodeStartInProgress(false);
    log('Durdurma komutu gönderildi.');
    refreshStatus();
  } catch (e) {
    log(humanError(e), true);
  }
});

$('btnCreateWallet').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;
  try {
    if (!(await guardRpcReadyForWallet(r.synorixCliPath))) return;
    const res = await window.synorix.walletCreate(r.synorixCliPath);
    if (res && res.warmup) {
      log('RPC henüz hazır; birkaç saniye sonra tekrar deneyin.', false);
      return;
    }
    log('Cüzdan “default” hazır (veya zaten vardı).');
    refreshStatus();
  } catch (e) {
    log(humanError(e), true);
  }
});

$('btnNewAddr').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;
  try {
    if (!(await guardRpcReadyForWallet(r.synorixCliPath))) return;
    const addr = await window.synorix.walletNewAddress(r.synorixCliPath);
    if (addr == null || addr === '') {
      log('Adres alınamadı; RPC veya cüzdanı kontrol edin.', true);
      return;
    }
    $('lastAddr').textContent = addr;
    $('mineAddr').value = addr;
    log(`Yeni adres: ${addr}`);
    refreshStatus();
  } catch (e) {
    log(humanError(e), true);
  }
});

$('btnMine').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;
  const addr = $('mineAddr').value.trim();
  if (!addr) {
    log('Önce “Yeni adres al” ile adres oluşturun veya adresi yapıştırın.', true);
    return;
  }
  if (!(await guardRpcReadyForWallet(r.synorixCliPath))) return;
  const n = parseInt($('mineN').value, 10) || 1;
  miningBusy = true;
  $('btnMine').disabled = true;
  setMiningUi();
  try {
    const out = await window.synorix.miningGenerate(r.synorixCliPath, n, addr);
    if (out && out.warmup) {
      log('RPC henüz hazır; biraz sonra tekrar deneyin.', true);
      lastMiningText = 'Pasif';
      return;
    }
    const c = out.count ?? 0;
    lastMiningText = `Pasif (son: ${c} blok üretildi)`;
    log(`Mining tamam: ${c} blok üretildi (generatetoaddress).`);
    refreshStatus();
  } catch (e) {
    lastMiningText = 'Pasif (hata)';
    log(humanError(e), true);
  } finally {
    miningBusy = false;
    void refreshStatus().then(() => setMiningUi());
  }
});

if (typeof window.synorix.onNodeHealth === 'function') {
  window.synorix.onNodeHealth((p) => {
    if (p.stopped) {
      clearNodeForceReadyTimer();
      setNodeStartInProgress(false);
      setNodeRunningUi(false);
      updateWalletMiningFromNodeState('off');
      log('Node durduruldu.');
      return;
    }
    if (p.ok) {
      if (p.started) {
        void refreshStatus();
        return;
      }
      if (p.blocks != null) {
        $('stBlocks').textContent = String(p.blocks);
        void refreshStatus();
      }
    } else if (p.error) {
      const m = String(p.error).toLowerCase();
      if (m.includes('could not connect') || m.includes('connection refused') || m.includes('econnrefused')) {
        setNodeStartInProgress(false);
        setNodeRunningUi(false);
      }
      log(`Node RPC: ${p.error}`, true);
    }
  });
}

(async () => {
  const paths = await window.synorix.pathsGet();
  $('datadirPreview').textContent = paths.useWsl
    ? `${paths.datadir} (WSL · ${paths.wslDistro || 'Ubuntu'})`
    : paths.datadir;
  await refreshPickedDirLabel();
  if (paths.useWsl) {
    log(`Testnet veri klasörü (WSL): ${paths.datadir}`);
    if (paths.datadirUnc) log(`Windows’tan erişim: ${paths.datadirUnc}`);
  } else {
    log(`Testnet veri klasörü: ${paths.datadir}`);
  }
  const r = await refreshBinaries();
  if (r.ok) {
    log(r.useWsl ? 'WSL içinde synorixd / synorix-cli hazır.' : 'Synorix binary’leri otomatik bulundu.');
    startPoll();
  } else {
    log('Binary bulunamadı — “Binary’leri indir” veya uygulama yanına koyun.', true);
  }
  setMiningUi();
})();
