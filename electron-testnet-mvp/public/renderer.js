const $ = (id) => document.getElementById(id);

const AUTO_MINING_INTERVAL_MS = 150000;
let cfg = { synorixdPath: '', synorixCliPath: '' };
let miningBusy = false;
let autoMiningEnabled = false;
let autoMiningTimer = null;
let pollTimer = null, txPollTimer = null;

/* ---------- helpers ---------- */
function showToast(message, type = 'info') {
  const c = $('toastContainer'); if (!c) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`; el.textContent = message;
  c.appendChild(el);
  setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 350); }, 4000);
}
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); showToast('Copied to clipboard', 'success'); }
  catch { showToast('Copy failed', 'error'); }
}
function log(msg) {
  const el = $('log'); if (!el) return;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + el.textContent.slice(0, 4000);
}
function humanError(err) {
  const raw = String(err?.message || err || ''); const m = raw.toLowerCase();
  if (m.includes('could not connect') || m.includes('econnrefused') || m.includes('connection refused')) return 'Node not ready. Please wait a moment.';
  if (m.includes('invalid address')) return 'Invalid address.';
  if (m.includes('insufficient funds') || m.includes('not enough')) return 'Insufficient funds. Mining rewards need 100 confirmations before they can be spent.';
  if (m.includes('warmup') || m.includes('-28')) return 'Node is warming up. Try again shortly.';
  if (m.includes('authorization failed')) return 'RPC auth failed.';
  return raw || 'Something went wrong.';
}
function fmt(n) {
  if (n == null || !Number.isFinite(Number(n))) return '0.00';
  const v = Number(n);
  let s = v.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  if (!s.includes('.')) s += '.00';
  const [a, b] = s.split('.');
  return Number(a).toLocaleString('en-US') + '.' + (b.length < 2 ? (b + '00').slice(0, 2) : b);
}

function renderQR(addr) {
  const box = $('qrBox'); if (!box) return;
  box.innerHTML = '';
  if (!addr || addr === '—' || typeof QRCode === 'undefined') { box.classList.add('empty'); return; }
  box.classList.remove('empty');
  try { new QRCode(box, { text: addr, width: 168, height: 168, colorDark: '#0a0b10', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M }); } catch {}
}

/* ---------- connection state ---------- */
function setConn(state) {
  const dot = $('connDot'), txt = $('connText');
  if (state === 'on') { dot.className = 'conn-dot on'; txt.textContent = 'Connected'; }
  else if (state === 'warn') { dot.className = 'conn-dot warn'; txt.textContent = 'Connecting'; }
  else { dot.className = 'conn-dot off'; txt.textContent = 'Offline'; }
}

/* ---------- panels ---------- */
function closeAllPanels() {
  ['panelReceive', 'panelSend', 'panelCreate'].forEach((id) => { const e = $(id); if (e) e.hidden = true; });
}
function openPanel(id) { closeAllPanels(); const e = $(id); if (e) { e.hidden = false; e.classList.remove('slide'); void e.offsetWidth; e.classList.add('slide'); } }

/* ---------- status / balance ---------- */
async function refreshStatus() {
  try {
    const r = await window.synorix.binariesResolve();
    if (!r.ok) { setConn('off'); return; }
    cfg.synorixdPath = r.synorixdPath; cfg.synorixCliPath = r.synorixCliPath;
    const info = await window.synorix.getBlockchainInfo(cfg.synorixCliPath);
    if (info && info._offline) { setConn('off'); return; }
    if (info && info._warmup) { setConn('warn'); return; }
    if (info && 'blocks' in info) {
      setConn('on');
      $('stBlocks').textContent = String(info.blocks);
      $('stNodeRun').textContent = info.initialblockdownload ? 'Syncing' : 'Ready';
      try { const pc = await window.synorix.getConnectionCount(cfg.synorixCliPath); $('stPeers').textContent = Number.isFinite(pc) ? String(pc) : '0'; } catch { $('stPeers').textContent = '0'; }
    }
    // balance
    try {
      const bals = await window.synorix.walletBalances(cfg.synorixCliPath);
      let spendable = 0, immature = 0;
      if (bals && bals.mine) { spendable = Number(bals.mine.trusted || 0); immature = Number(bals.mine.immature || 0); }
      else { spendable = Number(await window.synorix.walletBalance(cfg.synorixCliPath) || 0); }
      $('balAmount').textContent = fmt(spendable);
      const sub = $('balImmature');
      if (immature > 0) { sub.textContent = `+${fmt(immature)} SNRX pending`; sub.classList.add('has-immature'); }
      else { sub.textContent = ''; sub.classList.remove('has-immature'); }
    } catch { /* no wallet yet */ }
  } catch { setConn('off'); }
}

/* ---------- wallets ---------- */
async function refreshWalletList() {
  try {
    const winfo = await window.synorix.walletInfo();
    const list = winfo.wallets || [];
    const active = winfo.walletId || '';
    $('activeWalletName').textContent = winfo.walletName || active || 'My Wallet';
    const menu = $('walletMenuList'); menu.innerHTML = '';
    if (list.length === 0) { menu.innerHTML = '<div class="tx-empty" style="padding:10px">No wallets</div>'; }
    else for (const w of list) {
      const b = document.createElement('button');
      b.className = 'wallet-menu-item' + (w.id === active ? ' active' : '');
      b.textContent = w.name || w.id;
      b.dataset.wid = w.id;
      b.addEventListener('click', () => switchWallet(w.id));
      menu.appendChild(b);
    }
    if (winfo.address) { $('recvAddr').textContent = winfo.address; if (!$('panelReceive').hidden) renderQR(winfo.address); }
  } catch {}
}
async function switchWallet(wid) {
  $('walletMenu').hidden = true;
  try {
    const res = await window.synorix.walletSwitch(cfg.synorixCliPath, wid);
    if (res && res.ok) { showToast('Wallet switched', 'success'); await refreshWalletList(); refreshStatus(); refreshTransactions(); }
  } catch (e) { showToast(humanError(e), 'error'); }
}

/* ---------- transactions ---------- */
async function refreshTransactions() {
  try {
    const txs = await window.synorix.walletTransactions(cfg.synorixCliPath, 30);
    const el = $('txList');
    if (!Array.isArray(txs) || txs.length === 0) { el.innerHTML = '<div class="tx-empty">No transactions yet</div>'; return; }
    const sorted = [...txs].sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 25);
    el.innerHTML = sorted.map((tx) => {
      const amt = Number(tx.amount || 0);
      const pos = amt >= 0;
      const cat = String(tx.category || '');
      const when = tx.time ? new Date(tx.time * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const conf = tx.confirmations != null ? `${tx.confirmations} conf` : '';
      const label = cat === 'generate' || cat === 'immature' ? 'Mined' : pos ? 'Received' : 'Sent';
      return `<div class="tx-item">
        <div class="tx-ic ${pos ? 'in' : 'out'}">${pos ? '↓' : '↑'}</div>
        <div class="tx-mid"><div class="tx-cat">${label}</div><div class="tx-meta">${when}${conf ? ' · ' + conf : ''}</div></div>
        <div class="tx-amt ${pos ? 'pos' : 'neg'}">${pos ? '+' : ''}${fmt(amt)}</div>
      </div>`;
    }).join('');
  } catch {}
}

/* ---------- polling ---------- */
function startPoll() {
  stopPoll();
  pollTimer = setInterval(refreshStatus, 2500); refreshStatus();
  txPollTimer = setInterval(refreshTransactions, 6000); refreshTransactions();
}
function stopPoll() { if (pollTimer) clearInterval(pollTimer); if (txPollTimer) clearInterval(txPollTimer); pollTimer = txPollTimer = null; }

async function requireBinaries() {
  const r = await window.synorix.binariesResolve();
  if (r.ok) { cfg.synorixdPath = r.synorixdPath; cfg.synorixCliPath = r.synorixCliPath; return r; }
  showToast('Cannot reach node configuration', 'error'); return null;
}
async function rpcReady(cli) {
  if (typeof window.synorix.waitForRPCReady !== 'function') return true;
  const out = await window.synorix.waitForRPCReady(cli);
  if (!out.ok) { showToast(out.message || 'RPC timed out', 'error'); return false; }
  return true;
}

/* ---------- events: navigation ---------- */
$('walletChip').addEventListener('click', (e) => { e.stopPropagation(); const m = $('walletMenu'); m.hidden = !m.hidden; });
document.addEventListener('click', () => { $('walletMenu').hidden = true; });
$('walletMenu').addEventListener('click', (e) => e.stopPropagation());
$('btnOpenCreate').addEventListener('click', () => { $('walletMenu').hidden = true; openPanel('panelCreate'); });
$('btnTabReceive').addEventListener('click', () => { openPanel('panelReceive'); renderQR($('recvAddr').textContent.trim()); });
$('btnTabSend').addEventListener('click', () => openPanel('panelSend'));
$('closeReceive').addEventListener('click', closeAllPanels);
$('closeSend').addEventListener('click', closeAllPanels);
$('closeCreate').addEventListener('click', closeAllPanels);
$('advToggle').addEventListener('click', () => { const b = $('advBody'); b.hidden = !b.hidden; });

/* ---------- events: wallet actions ---------- */
$('btnCopyAddr').addEventListener('click', () => { const t = $('recvAddr').textContent; if (t && t !== '—') copyToClipboard(t); });

$('btnNewAddr').addEventListener('click', async () => {
  const r = await requireBinaries(); if (!r) return;
  if (!(await rpcReady(r.synorixCliPath))) return;
  try {
    const addr = await window.synorix.walletNewAddress(r.synorixCliPath);
    if (addr) { $('recvAddr').textContent = addr; renderQR(addr); if ($('mineAddr')) $('mineAddr').value = addr; showToast('New address ready', 'success'); }
  } catch (e) { showToast(humanError(e), 'error'); }
});

$('btnCreateNamed').addEventListener('click', async () => {
  const name = $('newWalletName').value.trim();
  if (!name) { showToast('Enter a wallet name', 'error'); return; }
  const r = await requireBinaries(); if (!r) return;
  try {
    const res = await window.synorix.walletCreateNamed(r.synorixCliPath, name);
    if (res && res.ok) {
      showToast(`Wallet "${res.walletName}" created`, 'success');
      $('newWalletName').value = ''; closeAllPanels();
      await refreshWalletList(); refreshStatus(); refreshTransactions();
    }
  } catch (e) { showToast(humanError(e), 'error'); }
});

$('btnSend').addEventListener('click', async () => {
  const r = await requireBinaries(); if (!r) return;
  const to = $('sendTo').value.trim();
  const amount = parseFloat($('sendAmount').value);
  if (!to) { showToast('Enter recipient address', 'error'); return; }
  if (!Number.isFinite(amount) || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }
  if (!(await rpcReady(r.synorixCliPath))) return;
  $('btnSend').disabled = true;
  try {
    const out = await window.synorix.walletSend(r.synorixCliPath, to, amount);
    showToast('Coins sent!', 'success');
    log(`Sent ${amount} SNRX. TXID: ${out.txid || ''}`);
    $('sendTo').value = ''; $('sendAmount').value = ''; closeAllPanels();
    refreshStatus(); refreshTransactions();
  } catch (e) { showToast(humanError(e), 'error'); }
  finally { $('btnSend').disabled = false; }
});

/* ---------- events: advanced (mining / node) ---------- */
$('btnMine').addEventListener('click', async () => {
  const r = await requireBinaries(); if (!r) return;
  let addr = $('mineAddr').value.trim() || $('recvAddr').textContent.trim();
  if (!addr || addr === '—') { showToast('Generate an address first', 'error'); return; }
  if (!(await rpcReady(r.synorixCliPath))) return;
  $('btnMine').disabled = true;
  try {
    const n = parseInt($('mineN').value, 10) || 1;
    const out = await window.synorix.miningGenerate(r.synorixCliPath, n, addr);
    const c = out.count ?? 0;
    log(`Mining: ${c} block(s) generated.`);
    showToast(c > 0 ? `Mined ${c} block(s)` : 'No block found (difficulty too high for app mining)', c > 0 ? 'success' : 'info');
    refreshStatus(); refreshTransactions();
  } catch (e) { showToast(humanError(e), 'error'); }
  finally { $('btnMine').disabled = false; }
});

function updateAutoMineBtn() {
  const btn = $('btnAutoMine'); const t = btn.querySelector('.btn-text'); const s = btn.querySelector('.spinner');
  if (autoMiningEnabled) { t.textContent = 'Stop Auto'; s.hidden = false; } else { t.textContent = 'Auto Mine'; s.hidden = true; }
}
$('btnAutoMine').addEventListener('click', async () => {
  if (autoMiningEnabled) { autoMiningEnabled = false; if (autoMiningTimer) clearInterval(autoMiningTimer); updateAutoMineBtn(); log('Auto mining stopped.'); return; }
  const r = await requireBinaries(); if (!r) return;
  let addr = $('mineAddr').value.trim() || $('recvAddr').textContent.trim();
  if (!addr || addr === '—') { try { addr = await window.synorix.walletNewAddress(r.synorixCliPath); $('mineAddr').value = addr; } catch { showToast('Need an address', 'error'); return; } }
  autoMiningEnabled = true; updateAutoMineBtn();
  const tick = async () => {
    if (!autoMiningEnabled || miningBusy) return; miningBusy = true;
    try { const n = parseInt($('mineN').value, 10) || 1; const out = await window.synorix.miningGenerate(r.synorixCliPath, n, $('mineAddr').value.trim() || addr); log(`Auto mining: ${out.count ?? 0} block(s).`); await refreshStatus(); refreshTransactions(); }
    catch (e) { log(humanError(e)); } finally { miningBusy = false; }
  };
  log('Auto mining started.'); await tick();
  autoMiningTimer = setInterval(() => { tick().catch(() => {}); }, AUTO_MINING_INTERVAL_MS);
});

$('btnStartNode').addEventListener('click', async () => {
  const r = await requireBinaries(); if (!r) return;
  setConn('warn');
  try { const s = await window.synorix.nodeStart(r.synorixdPath, r.synorixCliPath); if (s.rpcReady) { setConn('on'); showToast('Connected', 'success'); await refreshWalletList(); } startPoll(); }
  catch (e) { showToast(humanError(e), 'error'); }
});
$('btnStopNode').addEventListener('click', async () => {
  try { await window.synorix.nodeStop(cfg.synorixCliPath); } catch {}
  if (autoMiningEnabled) { autoMiningEnabled = false; if (autoMiningTimer) clearInterval(autoMiningTimer); updateAutoMineBtn(); }
  setConn('off'); log('Disconnected.'); showToast('Disconnected', 'info');
});

/* ---------- node health pushes ---------- */
if (typeof window.synorix.onNodeHealth === 'function') {
  window.synorix.onNodeHealth((p) => {
    if (p.stopped) { setConn('off'); return; }
    if (p.ok) { setConn('on'); if (p.blocks != null) $('stBlocks').textContent = String(p.blocks); }
  });
}

/* ---------- startup ---------- */
(async () => {
  try {
    const paths = await window.synorix.pathsGet();
    if (paths && paths.network) $('netPill').textContent = paths.network;
  } catch {}
  setConn('warn');
  const r = await window.synorix.binariesResolve();
  if (r.ok) {
    cfg.synorixdPath = r.synorixdPath; cfg.synorixCliPath = r.synorixCliPath;
    startPoll();
    try {
      const s = await window.synorix.nodeStart(r.synorixdPath, r.synorixCliPath);
      if (s.rpcReady) { setConn('on'); await refreshWalletList(); }
    } catch (e) { log(humanError(e)); }
  } else { setConn('off'); }
  await refreshWalletList();
  updateAutoMineBtn();
})();
