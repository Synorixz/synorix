const $ = (id) => document.getElementById(id);
const logEl = $('log');

const AUTO_MINING_INTERVAL_MS = 150000;
const NODE_FORCE_READY_MS = 40000;

let pollTimer = null;
let cfg = { synorixdPath: '', synorixCliPath: '', synorixBinDir: '' };
let miningBusy = false;
let lastMiningText = 'Idle';
let autoMiningEnabled = false;
let autoMiningTimer = null;
let nodeStartInProgress = false;
let nodeForceReadyTimer = null;

function clearNodeForceReadyTimer() {
  if (nodeForceReadyTimer != null) {
    clearTimeout(nodeForceReadyTimer);
    nodeForceReadyTimer = null;
  }
}

function humanError(err) {
  const raw = String(err?.message || err || '');
  const m = raw.toLowerCase();
  if (m.includes('could not connect') || m.includes('connection refused') || m.includes('econnrefused')) {
    return 'Node is not ready. Please wait ~30 seconds.';
  }
  if (m.includes('method not found') && m.includes('generatetoaddress')) {
    return 'Mining RPC is disabled on this node or wallet support is missing.';
  }
  if (m.includes('invalid address')) {
    return 'Invalid address. Use a testnet address (e.g. tsnrx1...).';
  }
  if (m.includes('wallet') && m.includes('not found')) {
    return 'Wallet not found. Click "Create Wallet" first.';
  }
  if (m.includes('empty wallet')) {
    return 'Wallet is empty or address could not be generated. Create a wallet first.';
  }
  if (m.includes('verifying block') || m.includes('error code: -28') || m.includes('in warmup')) {
    return 'RPC is warming up. Try again in a few seconds.';
  }
  if (m.includes('rpc timed out') || m.includes('timeout')) {
    return 'RPC timed out. Try stopping and restarting the node connection.';
  }
  if (m.includes('authorization failed') || m.includes('incorrect rpcuser')) {
    return 'RPC authentication failed. Check rpcUser/rpcPassword in config.';
  }
  if (m.includes('insufficient funds') || m.includes('not enough')) {
    return 'Insufficient funds. Mine some blocks first to get testnet coins.';
  }
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
  if (autoMiningTimer) {
    clearInterval(autoMiningTimer);
    autoMiningTimer = null;
  }
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
  if (miningBusy) {
    dot.className = 'status-dot warn';
    val.textContent = 'Processing...';
    return;
  }
  if (autoMiningEnabled) {
    dot.className = 'status-dot pulse';
    val.textContent = 'Auto (150s)';
    return;
  }
  dot.className = 'status-dot off';
  val.textContent = lastMiningText;
}

function blockchainInfoLooksRpcReady(info) {
  if (!info || info._offline || info._warmup) return false;
  if (!('blocks' in info)) return false;
  const b = Number(info.blocks);
  return Number.isFinite(b) && b >= 0;
}

async function refreshBinaries() {
  const result = await window.synorix.binariesResolve();
  if (result.ok) {
    cfg.synorixdPath = result.synorixdPath;
    cfg.synorixCliPath = result.synorixCliPath;
  }
  return result;
}

async function refreshStatus() {
  const r = await window.synorix.binariesResolve();
  if (!r.ok) {
    nodeStartInProgress = false;
    setNodeRunningUi(false);
    $('stBlocks').textContent = '\u2014';
    $('stIbd').textContent = '\u2014';
    $('nodeBadge').textContent = 'No binaries';
    $('nodeBadge').className = 'badge badge-off';
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
    } else {
      applyNodeRunningWarmupUi();
    }

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
      $('stBal').textContent = 'No wallet';
    }
  } catch {
    nodeStartInProgress = false;
    setNodeRunningUi(false);
    $('stBlocks').textContent = '\u2014';
    $('stIbd').textContent = '\u2014';
    updateWalletMiningFromNodeState('off');
  }
  setMiningUi();
}

let txPollTimer = null;

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
    const addr = tx.address ? `${String(tx.address).slice(0, 14)}...` : '\u2014';
    const conf = tx.confirmations != null ? String(tx.confirmations) : '\u2014';
    return `<tr><td>${date}</td><td>${cat}</td><td class="${amtClass}">${amt.toFixed(8)}</td><td title="${tx.address || ''}">${addr}</td><td>${conf}</td></tr>`;
  }).join('');
}

async function refreshTransactions() {
  try {
    const txList = await window.synorix.walletTransactions(cfg.synorixCliPath, 30);
    renderTransactions(txList);
  } catch { /* silent */ }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(refreshStatus, 2500);
  refreshStatus();
  txPollTimer = setInterval(refreshTransactions, 5000);
  refreshTransactions();
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (txPollTimer) { clearInterval(txPollTimer); txPollTimer = null; }
}

async function requireBinaries() {
  const r = await refreshBinaries();
  if (!r.ok) {
    log('Could not resolve binaries or remote RPC configuration.', true);
    return null;
  }
  return r;
}

async function guardRpcReadyForWallet(cliPath) {
  if (typeof window.synorix.waitForRPCReady !== 'function') return true;
  const out = await window.synorix.waitForRPCReady(cliPath);
  if (!out.ok) {
    log(out.message || 'RPC timed out.', true);
    return false;
  }
  return true;
}

async function runMiningOnce(synorixCliPath, n, addr, source = 'manual') {
  const out = await window.synorix.miningGenerate(synorixCliPath, n, addr);
  if (out && out.warmup) {
    log('RPC is warming up. Try again shortly.', true);
    lastMiningText = 'Idle';
    return;
  }
  const c = out.count ?? 0;
  lastMiningText = `Idle (last: ${c} blocks)`;
  log(`${source === 'auto' ? 'Auto mining' : 'Mining'} complete: ${c} block(s) generated.`);
}

// ---- Event Listeners ----

$('btnStartNode').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;
  clearNodeForceReadyTimer();
  nodeStartInProgress = true;
  applyNodeRunningWarmupUi();
  $('stIbd').textContent = 'Connecting to RPC...';
  updateWalletMiningFromNodeState('starting');
  log('Connecting to VPS node...');

  nodeForceReadyTimer = setTimeout(() => {
    nodeForceReadyTimer = null;
    setNodeRunningUi(true, { fullyReady: true });
    updateWalletMiningFromNodeState('ready');
    nodeStartInProgress = false;
    log('Node ready (force timeout reached).');
    void refreshStatus();
  }, NODE_FORCE_READY_MS);

  try {
    const start = await window.synorix.nodeStart(r.synorixdPath, r.synorixCliPath);
    if (start.rpcReady) {
      log(start.remote ? 'Connected to remote VPS node. RPC is ready.' : 'Node ready. RPC is responding.');
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
    log(humanError(e), true);
    void refreshStatus();
  } finally {
    nodeStartInProgress = false;
    void refreshStatus();
  }
});

$('btnStopNode').addEventListener('click', async () => {
  const r = await requireBinaries();
  if (!r) return;
  try {
    clearNodeForceReadyTimer();
    stopAutoMining('Auto mining stopped (node disconnected).');
    await window.synorix.nodeStop(r.synorixCliPath);
    nodeStartInProgress = false;
    log('Disconnected from node.');
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
      log('RPC is warming up. Try again in a few seconds.');
      return;
    }
    if (res.walletId) {
      $('walletIdDisplay').textContent = res.walletId;
    }
    log(`Wallet "${res.walletId || 'default'}" is ready.`);
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
      log('Could not generate address. Check RPC or wallet.', true);
      return;
    }
    $('lastAddr').textContent = addr;
    $('mineAddr').value = addr;
    log(`New address: ${addr}`);
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
    log('Get a new address first or paste one.', true);
    return;
  }
  if (!(await guardRpcReadyForWallet(r.synorixCliPath))) return;
  const n = parseInt($('mineN').value, 10) || 1;
  miningBusy = true;
  $('btnMine').disabled = true;
  setMiningUi();
  try {
    await runMiningOnce(r.synorixCliPath, n, addr, 'manual');
    refreshStatus();
  } catch (e) {
    lastMiningText = 'Idle (error)';
    log(humanError(e), true);
  } finally {
    miningBusy = false;
    void refreshStatus().then(() => setMiningUi());
  }
});

$('btnAutoMine').addEventListener('click', async () => {
  if (autoMiningEnabled) {
    stopAutoMining('Auto mining stopped.');
    setMiningUi();
    return;
  }

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
    } catch (e) {
      log(humanError(e), true);
      return;
    }
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
    } catch (e) {
      log(humanError(e), true);
    } finally {
      miningBusy = false;
      setMiningUi();
    }
  };
  log('Auto mining started (every 150 seconds).');
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
  if (!to) {
    log('Recipient address cannot be empty.', true);
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    log('Amount must be greater than 0.', true);
    return;
  }
  try {
    const out = await window.synorix.walletSend(r.synorixCliPath, to, amount);
    log(`Coins sent. TXID: ${out.txid || '\u2014'}`);
    await refreshStatus();
  } catch (e) {
    log(humanError(e), true);
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
      if (p.blocks != null) {
        $('stBlocks').textContent = String(p.blocks);
        void refreshStatus();
      }
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
    if (winfo.walletId) {
      $('walletIdDisplay').textContent = winfo.walletId;
    }
  } catch { /* wallet not yet created */ }
  setMiningUi();
  updateAutoMineButton();
})();
