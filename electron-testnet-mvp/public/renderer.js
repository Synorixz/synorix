const $ = (id) => document.getElementById(id);
const logEl = $('log');

const AUTO_MINING_INTERVAL_MS = 150000;
const NODE_FORCE_READY_MS = 40000;
const TX_POLL_MS = 5000;

let pollTimer = null;
let txPollTimer = null;
let cfg = { synorixdPath: '', synorixCliPath: '', synorixBinDir: '' };
let miningBusy = false;
let lastMiningText = 'Idle';
let autoMiningEnabled = false;
let autoMiningTimer = null;
let nodeStartInProgress = false;
let nodeForceReadyTimer = null;
let nodeConnected = false;
let balanceChart = null;
const balanceSamples = [];
const MAX_BALANCE_SAMPLES = 60;

function clearNodeForceReadyTimer() {
  if (nodeForceReadyTimer != null) { clearTimeout(nodeForceReadyTimer); nodeForceReadyTimer = null; }
}

// ---- Toast System ----
function showToast(message, type = 'info') {
  const container = $('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 350);
  }, 4000);
}

// ---- Clipboard ----
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'success');
  } catch {
    showToast('Failed to copy', 'error');
  }
}

function humanError(err) {
  const raw = String(err?.message || err || '');
  const m = raw.toLowerCase();
  if (m.includes('could not connect') || m.includes('connection refused') || m.includes('econnrefused'))
    return 'Node is not ready. Please wait ~30 seconds.';
  if (m.includes('method not found') && m.includes('generatetoaddress'))
    return 'Mining RPC is disabled on this node.';
  if (m.includes('invalid address'))
    return 'Invalid address. Use a testnet address (e.g. tsnrx1...).';
  if (m.includes('wallet') && m.includes('not found'))
    return 'Wallet not found. Click "Create Wallet" first.';
  if (m.includes('verifying block') || m.includes('error code: -28') || m.includes('in warmup'))
    return 'RPC is warming up. Try again in a few seconds.';
  if (m.includes('rpc timed out') || m.includes('timeout'))
    return 'RPC timed out. Try reconnecting.';
  if (m.includes('authorization failed') || m.includes('incorrect rpcuser'))
    return 'RPC auth failed. Check Settings.';
  if (m.includes('insufficient funds') || m.includes('not enough'))
    return 'Insufficient funds. Mine some blocks first.';
  return raw || 'An unexpected error occurred.';
}

function log(msg, isErr = false) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  logEl.textContent = line + logEl.textContent.slice(0, 5000);
  logEl.style.color = isErr ? 'var(--err)' : 'var(--muted)';
}

function setNodeRunningUi(running, opts = {}) {
  const fullyReady = Boolean(opts.fullyReady);
  const dot = $('dotNode');
  const val = $('stNodeRun');
  nodeConnected = running && fullyReady;
  if (running) {
    dot.className = fullyReady ? 'status-dot on' : 'status-dot warn';
    val.textContent = fullyReady ? 'Connected' : 'Connecting...';
    $('nodeBadge').textContent = fullyReady ? 'Online' : 'Connecting';
    $('nodeBadge').className = fullyReady ? 'badge badge-ok' : 'badge badge-warn';
  } else {
    dot.className = 'status-dot off';
    val.textContent = 'Stopped';
    $('nodeBadge').textContent = 'Offline';
    $('nodeBadge').className = 'badge badge-off';
    nodeConnected = false;
  }
}

function applyNodeRunningWarmupUi() {
  $('dotNode').className = 'status-dot warn';
  $('stNodeRun').textContent = 'Connecting...';
  $('nodeBadge').textContent = 'Connecting';
  $('nodeBadge').className = 'badge badge-warn';
}

function formatWalletBalance(bal) {
  if (bal === null) return '...';
  if (Number.isFinite(bal)) return `${bal.toFixed(8)} SNRX`;
  return '\u2014';
}

function setWalletMiningActionsEnabled(enabled, titleWhenDisabled = '') {
  const ids = [
    'btnCreateWallet', 'btnNewAddr', 'btnMine', 'mineN', 'mineAddr',
    'btnAutoMine', 'btnSend', 'sendTo', 'sendAmount',
  ];
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    el.disabled = !enabled;
    el.title = enabled ? '' : titleWhenDisabled;
  }
}

function stopAutoMining(reason = '') {
  if (autoMiningTimer) { clearInterval(autoMiningTimer); autoMiningTimer = null; }
  const wasOn = autoMiningEnabled;
  autoMiningEnabled = false;
  updateAutoMineButton();
  if (wasOn && reason) log(reason);
}

function updateAutoMineButton() {
  const btn = $('btnAutoMine');
  if (!btn) return;
  if (autoMiningEnabled) {
    btn.textContent = 'Stop Auto Mining';
    btn.className = 'danger';
  } else {
    btn.textContent = 'Start Auto Mining';
    btn.className = 'primary';
  }
}

function updateWalletMiningFromNodeState(state) {
  if (state === 'ready') {
    setWalletMiningActionsEnabled(true);
  } else if (state === 'starting') {
    setWalletMiningActionsEnabled(false, 'Node is starting / RPC warming up...');
  } else {
    stopAutoMining('Node is not ready, auto mining stopped.');
    setWalletMiningActionsEnabled(false, 'Connect to node first.');
  }
}

function setMiningUi() {
  const dot = $('dotMine');
  const val = $('stMining');
  if (miningBusy) { dot.className = 'status-dot warn'; val.textContent = 'Processing...'; return; }
  if (autoMiningEnabled) { dot.className = 'status-dot pulse'; val.textContent = 'Auto (150s)'; return; }
  dot.className = 'status-dot off';
  val.textContent = lastMiningText;
}

function blockchainInfoLooksRpcReady(info) {
  if (!info || info._offline || info._warmup) return false;
  if (!('blocks' in info)) return false;
  return Number.isFinite(Number(info.blocks)) && Number(info.blocks) >= 0;
}

// ---- Balance Chart ----
function initBalanceChart() {
  if (typeof Chart === 'undefined') return;
  const ctx = $('balanceChart');
  if (!ctx) return;
  balanceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Balance (SNRX)',
        data: [],
        borderColor: '#3d9cf5',
        backgroundColor: 'rgba(61, 156, 245, 0.08)',
        borderWidth: 2,
        pointRadius: 2,
        pointBackgroundColor: '#3d9cf5',
        fill: true,
        tension: 0.35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: { legend: { display: false } },
      scales: {
        x: { display: true, grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#7e8fa6', font: { size: 9 }, maxTicksLimit: 8 } },
        y: { display: true, grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#7e8fa6', font: { size: 9 } } },
      },
    },
  });
}

function pushBalanceSample(bal) {
  if (!Number.isFinite(bal) || !balanceChart) return;
  const label = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  balanceSamples.push({ label, value: bal });
  if (balanceSamples.length > MAX_BALANCE_SAMPLES) balanceSamples.shift();
  balanceChart.data.labels = balanceSamples.map((s) => s.label);
  balanceChart.data.datasets[0].data = balanceSamples.map((s) => s.value);
  balanceChart.update();
}

// ---- Transaction Table ----
function renderTransactions(txList) {
  const tbody = $('txBody');
  if (!tbody) return;
  if (!Array.isArray(txList) || txList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="tx-empty">No transactions yet</td></tr>';
    return;
  }
  const sorted = [...txList].sort((a, b) => (b.time || 0) - (a.time || 0));
  tbody.innerHTML = sorted.slice(0, 30).map((tx) => {
    const date = tx.time ? new Date(tx.time * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '\u2014';
    const cat = String(tx.category || 'unknown');
    const amt = Number(tx.amount || 0);
    const amtClass = amt >= 0 ? 'tx-amount-pos' : 'tx-amount-neg';
    const addr = tx.address ? `${String(tx.address).slice(0, 12)}...` : '\u2014';
    const conf = tx.confirmations != null ? String(tx.confirmations) : '\u2014';
    return `<tr><td>${date}</td><td>${cat}</td><td class="${amtClass}">${amt.toFixed(8)}</td><td title="${tx.address || ''}">${addr}</td><td>${conf}</td></tr>`;
  }).join('');
}

async function refreshTransactions() {
  if (!nodeConnected) return;
  try {
    const txList = await window.synorix.walletTransactions(cfg.synorixCliPath, 30);
    renderTransactions(txList);
  } catch { /* silently fail */ }
}

function startTxPoll() {
  stopTxPoll();
  txPollTimer = setInterval(refreshTransactions, TX_POLL_MS);
  refreshTransactions();
}

function stopTxPoll() {
  if (txPollTimer) { clearInterval(txPollTimer); txPollTimer = null; }
}

// ---- Main Refresh ----
async function refreshBinaries() {
  const result = await window.synorix.binariesResolve();
  if (result.ok) { cfg.synorixdPath = result.synorixdPath; cfg.synorixCliPath = result.synorixCliPath; }
  return result;
}

async function refreshStatus() {
  const r = await window.synorix.binariesResolve();
  if (!r.ok) {
    nodeStartInProgress = false;
    setNodeRunningUi(false);
    $('stBlocks').textContent = '\u2014';
    $('stIbd').textContent = '\u2014';
    $('stPeers').textContent = '\u2014';
    updateWalletMiningFromNodeState('off');
    return;
  }
  cfg.synorixdPath = r.synorixdPath;
  cfg.synorixCliPath = r.synorixCliPath;
  try {
    const info = await window.synorix.getBlockchainInfo(cfg.synorixCliPath);
    if (info && info._offline) {
      nodeStartInProgress = false;
      setNodeRunningUi(false);
      $('stBlocks').textContent = '\u2014';
      $('stIbd').textContent = '\u2014';
      $('stBal').textContent = '\u2014';
      $('stPeers').textContent = '\u2014';
      updateWalletMiningFromNodeState('off');
      setMiningUi();
      return;
    }

    const warmup = Boolean(info && info._warmup);
    const rpcReadyUi = !warmup && blockchainInfoLooksRpcReady(info);

    if (nodeStartInProgress) applyNodeRunningWarmupUi();
    else if (rpcReadyUi) setNodeRunningUi(true, { fullyReady: true });
    else if (!warmup) setNodeRunningUi(true, { fullyReady: false });
    else applyNodeRunningWarmupUi();

    if (warmup) {
      $('stIbd').textContent = 'RPC warming up...';
      $('stBlocks').textContent = '...';
    } else {
      const vp = Number(info.verificationprogress);
      const vpStr = Number.isFinite(vp) ? `${(vp * 100).toFixed(1)}%` : '\u2014';
      const ibd = info.initialblockdownload === true ? 'yes' : info.initialblockdownload === false ? 'no' : '\u2014';
      $('stIbd').textContent = `Progress: ${vpStr} | IBD: ${ibd}`;
      $('stBlocks').textContent = info.blocks != null ? String(info.blocks) : '\u2014';
    }

    try {
      const n = await window.synorix.getConnectionCount(cfg.synorixCliPath);
      $('stPeers').textContent = n != null && Number.isFinite(n) ? String(n) : '\u2014';
    } catch { $('stPeers').textContent = '\u2014'; }

    if (nodeStartInProgress) updateWalletMiningFromNodeState('starting');
    else if (rpcReadyUi) updateWalletMiningFromNodeState('ready');
    else updateWalletMiningFromNodeState('starting');

    try {
      const bal = await window.synorix.walletBalance(cfg.synorixCliPath);
      $('stBal').textContent = formatWalletBalance(bal);
      if (Number.isFinite(bal)) pushBalanceSample(bal);
    } catch { $('stBal').textContent = 'No wallet'; }
  } catch {
    nodeStartInProgress = false;
    setNodeRunningUi(false);
    $('stBlocks').textContent = '\u2014';
    $('stIbd').textContent = '\u2014';
    $('stPeers').textContent = '\u2014';
    updateWalletMiningFromNodeState('off');
  }
  setMiningUi();
}

function startPoll() { stopPoll(); pollTimer = setInterval(refreshStatus, 2500); refreshStatus(); startTxPoll(); }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } stopTxPoll(); }

async function requireBinaries() {
  const r = await refreshBinaries();
  if (!r.ok) { log('Could not resolve remote RPC configuration.', true); return null; }
  return r;
}

async function guardRpcReadyForWallet(cliPath) {
  if (typeof window.synorix.waitForRPCReady !== 'function') return true;
  const out = await window.synorix.waitForRPCReady(cliPath);
  if (!out.ok) { log(out.message || 'RPC timed out.', true); return false; }
  return true;
}

async function runMiningOnce(synorixCliPath, n, addr, source = 'manual') {
  const out = await window.synorix.miningGenerate(synorixCliPath, n, addr);
  if (out && out.warmup) { log('RPC is warming up.', true); lastMiningText = 'Idle'; return; }
  const c = out.count ?? 0;
  lastMiningText = `Idle (last: ${c} blocks)`;
  const msg = `${source === 'auto' ? 'Auto mining' : 'Mining'} complete: ${c} block(s) generated.`;
  log(msg);
  showToast(msg, 'success');
}

function showSpinner(btn, show) {
  const sp = btn.querySelector('.spinner');
  const tx = btn.querySelector('.btn-text');
  if (sp) sp.hidden = !show;
  if (tx) tx.hidden = show;
}

// ---- Settings Modal ----
$('btnSettings').addEventListener('click', async () => {
  const c = await window.synorix.configGet();
  $('setRpcUrl').value = c.rpcUrl || '';
  $('setRpcUser').value = c.rpcUser || '';
  $('setRpcPass').value = c.rpcPassword || '';
  $('settingsModal').hidden = false;
});

$('btnCloseSettings').addEventListener('click', () => { $('settingsModal').hidden = true; });

$('btnTogglePass').addEventListener('click', () => {
  const inp = $('setRpcPass');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

$('btnSaveSettings').addEventListener('click', async () => {
  const prev = await window.synorix.configGet();
  await window.synorix.configSet({
    ...prev,
    rpcUrl: $('setRpcUrl').value.trim(),
    rpcUser: $('setRpcUser').value.trim(),
    rpcPassword: $('setRpcPass').value.trim(),
  });
  $('settingsModal').hidden = true;
  showToast('Settings saved. Restart app to apply.', 'info');
  log('Settings saved. Restart the app for changes to take effect.');
});

// ---- Copy Buttons ----
$('btnCopyWalletId').addEventListener('click', () => {
  const text = $('walletIdDisplay').textContent;
  if (text && text !== '\u2014') copyToClipboard(text);
});

$('btnCopyAddr').addEventListener('click', () => {
  const text = $('lastAddr').textContent;
  if (text && text !== '\u2014') copyToClipboard(text);
});

// ---- Node Connect / Disconnect ----
$('btnStartNode').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;
  clearNodeForceReadyTimer();
  nodeStartInProgress = true;
  applyNodeRunningWarmupUi();
  $('stIbd').textContent = 'Connecting to RPC...';
  updateWalletMiningFromNodeState('starting');
  const btn = $('btnStartNode');
  showSpinner(btn, true);
  btn.disabled = true;
  log('Connecting to VPS node...');

  nodeForceReadyTimer = setTimeout(() => {
    nodeForceReadyTimer = null;
    setNodeRunningUi(true, { fullyReady: true });
    updateWalletMiningFromNodeState('ready');
    nodeStartInProgress = false;
    log('Node ready (force timeout).');
    void refreshStatus();
  }, NODE_FORCE_READY_MS);

  try {
    const start = await window.synorix.nodeStart(r.synorixdPath, r.synorixCliPath);
    if (start.rpcReady) {
      const msg = start.remote ? 'Connected to remote VPS node.' : 'Node ready.';
      log(msg);
      showToast(msg, 'success');
      if (start.walletId) {
        $('walletIdDisplay').textContent = start.walletId;
        log(`Wallet loaded: ${start.walletId}`);
      }
      setNodeRunningUi(true, { fullyReady: true });
      updateWalletMiningFromNodeState('ready');
    } else {
      log(`Node started (mode: ${start.mode}).`);
    }
    startPoll();
  } catch (e) {
    clearNodeForceReadyTimer();
    const msg = humanError(e);
    log(msg, true);
    showToast(msg, 'error');
    void refreshStatus();
  } finally {
    nodeStartInProgress = false;
    showSpinner(btn, false);
    btn.disabled = false;
    void refreshStatus();
  }
});

$('btnStopNode').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;
  try {
    clearNodeForceReadyTimer();
    stopAutoMining('Auto mining stopped (disconnected).');
    await window.synorix.nodeStop(r.synorixCliPath);
    nodeStartInProgress = false;
    log('Disconnected from node.');
    showToast('Disconnected from node.', 'info');
    refreshStatus();
  } catch (e) { log(humanError(e), true); }
});

$('btnCreateWallet').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;
  try {
    if (!(await guardRpcReadyForWallet(r.synorixCliPath))) return;
    const res = await window.synorix.walletCreate(r.synorixCliPath);
    if (res && res.warmup) { log('RPC is warming up.'); return; }
    if (res.walletId) $('walletIdDisplay').textContent = res.walletId;
    const msg = `Wallet "${res.walletId || 'default'}" is ready.`;
    log(msg);
    showToast(msg, 'success');
    refreshStatus();
  } catch (e) { log(humanError(e), true); showToast(humanError(e), 'error'); }
});

$('btnNewAddr').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;
  try {
    if (!(await guardRpcReadyForWallet(r.synorixCliPath))) return;
    const addr = await window.synorix.walletNewAddress(r.synorixCliPath);
    if (!addr) { log('Could not generate address.', true); return; }
    $('lastAddr').textContent = addr;
    $('mineAddr').value = addr;
    log(`New address: ${addr}`);
    showToast('New address generated.', 'success');
    refreshStatus();
  } catch (e) { log(humanError(e), true); }
});

$('btnMine').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;
  const addr = $('mineAddr').value.trim();
  if (!addr) { log('Get a new address first.', true); showToast('No address set.', 'error'); return; }
  if (!(await guardRpcReadyForWallet(r.synorixCliPath))) return;
  const n = parseInt($('mineN').value, 10) || 1;
  miningBusy = true;
  const btn = $('btnMine');
  showSpinner(btn, true);
  btn.disabled = true;
  setMiningUi();
  try {
    await runMiningOnce(r.synorixCliPath, n, addr, 'manual');
    refreshStatus();
    refreshTransactions();
  } catch (e) {
    lastMiningText = 'Idle (error)';
    log(humanError(e), true);
    showToast(humanError(e), 'error');
  } finally {
    miningBusy = false;
    showSpinner(btn, false);
    btn.disabled = false;
    void refreshStatus().then(() => setMiningUi());
  }
});

$('btnAutoMine').addEventListener('click', async () => {
  if (autoMiningEnabled) { stopAutoMining('Auto mining stopped.'); showToast('Auto mining stopped.', 'info'); setMiningUi(); return; }
  const r = await requireBinaries();
  if (!r) return;
  if (!(await guardRpcReadyForWallet(r.synorixCliPath))) return;
  let addr = $('mineAddr').value.trim();
  if (!addr) {
    try {
      addr = await window.synorix.walletNewAddress(r.synorixCliPath);
      $('mineAddr').value = addr;
      $('lastAddr').textContent = addr;
      log(`Generated address for auto mining: ${addr}`);
    } catch (e) { log(humanError(e), true); return; }
  }
  autoMiningEnabled = true;
  updateAutoMineButton();
  const tick = async () => {
    if (!autoMiningEnabled || miningBusy) return;
    miningBusy = true;
    setMiningUi();
    try {
      const n = parseInt($('mineN').value, 10) || 1;
      await runMiningOnce(r.synorixCliPath, n, $('mineAddr').value.trim(), 'auto');
      await refreshStatus();
      refreshTransactions();
    } catch (e) { log(humanError(e), true); }
    finally { miningBusy = false; setMiningUi(); }
  };
  log('Auto mining started (every 150 seconds).');
  showToast('Auto mining started.', 'success');
  await tick();
  autoMiningTimer = setInterval(() => { tick().catch(() => {}); }, AUTO_MINING_INTERVAL_MS);
  setMiningUi();
});

$('btnSend').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;
  if (!(await guardRpcReadyForWallet(r.synorixCliPath))) return;
  const to = $('sendTo').value.trim();
  const amount = parseFloat($('sendAmount').value);
  if (!to) { log('Recipient address is empty.', true); showToast('Enter a recipient address.', 'error'); return; }
  if (!Number.isFinite(amount) || amount <= 0) { log('Amount must be > 0.', true); showToast('Invalid amount.', 'error'); return; }
  const btn = $('btnSend');
  showSpinner(btn, true);
  btn.disabled = true;
  try {
    const out = await window.synorix.walletSend(r.synorixCliPath, to, amount);
    const msg = `Coins sent! TXID: ${(out.txid || '').slice(0, 16)}...`;
    log(`Coins sent. TXID: ${out.txid || '\u2014'}`);
    showToast(msg, 'success');
    await refreshStatus();
    refreshTransactions();
  } catch (e) {
    const msg = humanError(e);
    log(msg, true);
    showToast(msg, 'error');
  } finally {
    showSpinner(btn, false);
    btn.disabled = false;
  }
});

if (typeof window.synorix.onNodeHealth === 'function') {
  window.synorix.onNodeHealth((p) => {
    if (p.stopped) {
      clearNodeForceReadyTimer();
      nodeStartInProgress = false;
      setNodeRunningUi(false);
      updateWalletMiningFromNodeState('off');
      log('Node stopped.');
      return;
    }
    if (p.ok) {
      if (p.started) { void refreshStatus(); return; }
      if (p.blocks != null) { $('stBlocks').textContent = String(p.blocks); void refreshStatus(); }
    } else if (p.error) {
      const m = String(p.error).toLowerCase();
      if (m.includes('could not connect') || m.includes('connection refused') || m.includes('econnrefused')) {
        nodeStartInProgress = false;
        setNodeRunningUi(false);
      }
      log(`Node RPC: ${p.error}`, true);
    }
  });
}

(async () => {
  const paths = await window.synorix.pathsGet();
  if (paths.remoteMode) {
    log(`Remote VPS mode: ${paths.rpcUrl || 'configured'}`);
    $('remoteBadge').textContent = 'Remote VPS';
  } else {
    $('remoteBadge').hidden = true;
    log(`Data directory: ${paths.datadir}`);
  }
  const r = await refreshBinaries();
  if (r.ok) {
    log(r.source === 'remote' ? 'Remote RPC mode active.' : 'Binaries found.');
    startPoll();
    if (paths.remoteMode) {
      log('Auto-connecting to VPS node...');
      applyNodeRunningWarmupUi();
      nodeStartInProgress = true;
      updateWalletMiningFromNodeState('starting');
      try {
        const start = await window.synorix.nodeStart(r.synorixdPath, r.synorixCliPath);
        if (start.rpcReady) {
          log(start.remote ? 'Connected to remote VPS node.' : 'Node ready.');
          if (start.walletId) {
            $('walletIdDisplay').textContent = start.walletId;
            log(`Wallet loaded: ${start.walletId}`);
          }
          setNodeRunningUi(true, { fullyReady: true });
          updateWalletMiningFromNodeState('ready');
          showToast('Connected to VPS node.', 'success');
        }
      } catch (e) {
        log(humanError(e), true);
      } finally {
        nodeStartInProgress = false;
        void refreshStatus();
      }
    }
  } else {
    log('Could not initialize. Check configuration.', true);
  }
  try {
    const winfo = await window.synorix.walletInfo();
    if (winfo.walletId) $('walletIdDisplay').textContent = winfo.walletId;
  } catch {}
  initBalanceChart();
  setMiningUi();
  updateAutoMineButton();
})();
