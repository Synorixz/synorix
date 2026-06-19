const $ = (id) => document.getElementById(id);
let state = { wallets: [], activeId: '', network: 'testnet' };
let pollTimer = null;

/* ---------- helpers ---------- */
function showToast(msg, type = 'info') {
  const c = $('toastContainer'); if (!c) return;
  const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = msg;
  c.appendChild(el); setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 350); }, 4000);
}
async function copyToClipboard(t) { try { await navigator.clipboard.writeText(t); showToast('Copied', 'success'); } catch { showToast('Copy failed', 'error'); } }
function fmt(n) {
  const v = Number(n); if (!Number.isFinite(v)) return '0.00';
  let s = v.toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); if (!s.includes('.')) s += '.00';
  const [a, b] = s.split('.'); return Number(a).toLocaleString('en-US') + '.' + (b.length < 2 ? (b + '00').slice(0, 2) : b);
}
function errMsg(e) { return String(e && e.message ? e.message : e || 'Error').replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, ''); }
function renderQR(addr) {
  const box = $('qrBox'); if (!box) return; box.innerHTML = '';
  if (!addr || addr === '—' || typeof QRCode === 'undefined') { box.classList.add('empty'); return; }
  box.classList.remove('empty');
  try { new QRCode(box, { text: addr, width: 168, height: 168, colorDark: '#0a0b10', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M }); } catch {}
}
function setConn(s) {
  const d = $('connDot'), t = $('connText'); if (!d) return;
  if (s === 'on') { d.className = 'conn-dot on'; t.textContent = 'Connected'; }
  else if (s === 'warn') { d.className = 'conn-dot warn'; t.textContent = 'Connecting'; }
  else { d.className = 'conn-dot off'; t.textContent = 'Offline'; }
}
function renderMnemonic(el, phrase) {
  el.innerHTML = String(phrase).trim().split(/\s+/).map((w, i) => `<div class="mnemonic-word"><b>${i + 1}</b>${w}</div>`).join('');
}

/* ---------- view + modal ---------- */
function showView(hasWallets) {
  $('onboarding').hidden = hasWallets;
  $('walletView').hidden = !hasWallets;
}
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }
function closePanels() { ['panelReceive', 'panelSend'].forEach((id) => { const e = $(id); if (e) e.hidden = true; }); }
function openPanel(id) { closePanels(); const e = $(id); e.hidden = false; e.classList.remove('slide'); void e.offsetWidth; e.classList.add('slide'); }

/* ---------- refresh ---------- */
async function refreshState() {
  try {
    const s = await window.synorix.ncState();
    state = s;
    $('netPill').textContent = s.network === 'mainnet' ? 'Mainnet' : 'Testnet';
    showView(s.hasWallets);
    if (!s.hasWallets) return;
    const active = s.wallets.find((w) => w.id === s.activeId) || s.wallets[0];
    $('activeWalletName').textContent = active ? active.name : 'Wallet';
    const menu = $('walletMenuList'); menu.innerHTML = '';
    for (const w of s.wallets) {
      const b = document.createElement('button');
      b.className = 'wallet-menu-item' + (w.id === s.activeId ? ' active' : '');
      b.textContent = w.name; b.onclick = () => switchWallet(w.id);
      menu.appendChild(b);
    }
    await refreshAddress();
    await refreshBalance();
  } catch (e) { setConn('off'); }
}
async function refreshAddress() {
  try {
    const r = await window.synorix.ncReceiveAddress();
    if (r && r.address) { $('recvAddr').textContent = r.address; if (!$('panelReceive').hidden) renderQR(r.address); }
  } catch {}
}
async function refreshBalance() {
  try {
    const b = await window.synorix.ncBalance();
    if (b.noWallet) return;
    if (b.error) { setConn('off'); return; }
    setConn('on');
    $('balAmount').textContent = fmt(b.spendable);
    const sub = $('balImmature');
    if (b.immature > 0) { sub.textContent = `+${fmt(b.immature)} SNRX maturing`; sub.classList.add('has-immature'); }
    else { sub.textContent = ''; sub.classList.remove('has-immature'); }
  } catch { setConn('off'); }
}
async function switchWallet(id) {
  $('walletMenu').hidden = true;
  try { await window.synorix.ncSwitch(id); await refreshState(); showToast('Wallet switched', 'success'); }
  catch (e) { showToast(errMsg(e), 'error'); }
}

/* ---------- onboarding / create ---------- */
$('obCreate').onclick = () => { $('cName').value = ''; $('cPass').value = ''; $('cPass2').value = ''; openModal('modalCreate'); };
$('obRestore').onclick = () => { $('rName').value = ''; $('rPhrase').value = ''; $('rPass').value = ''; openModal('modalRestore'); };
$('menuNewWallet').onclick = () => { $('walletMenu').hidden = true; $('cName').value = ''; $('cPass').value = ''; $('cPass2').value = ''; openModal('modalCreate'); };
$('menuRestore').onclick = () => { $('walletMenu').hidden = true; openModal('modalRestore'); };

$('cSubmit').onclick = async () => {
  const name = $('cName').value.trim() || 'Main';
  const p1 = $('cPass').value, p2 = $('cPass2').value;
  if (p1.length < 6) { showToast('Password must be at least 6 characters', 'error'); return; }
  if (p1 !== p2) { showToast('Passwords do not match', 'error'); return; }
  $('cSubmit').disabled = true;
  try {
    const res = await window.synorix.ncCreate(name, p1);
    closeModal('modalCreate');
    renderMnemonic($('mnemonicGrid'), res.mnemonic);
    $('bConfirm').checked = false; $('bDone').disabled = true;
    $('bCopy').onclick = () => copyToClipboard(res.mnemonic);
    openModal('modalBackup');
  } catch (e) { showToast(errMsg(e), 'error'); }
  finally { $('cSubmit').disabled = false; }
};
$('bConfirm').onchange = () => { $('bDone').disabled = !$('bConfirm').checked; };
$('bDone').onclick = async () => { closeModal('modalBackup'); await refreshState(); showToast('Wallet ready', 'success'); };

$('rSubmit').onclick = async () => {
  const name = $('rName').value.trim() || 'Restored';
  const phrase = $('rPhrase').value.trim();
  const pass = $('rPass').value;
  if (pass.length < 6) { showToast('Password must be at least 6 characters', 'error'); return; }
  $('rSubmit').disabled = true;
  try { await window.synorix.ncRestore(name, phrase, pass); closeModal('modalRestore'); await refreshState(); showToast('Wallet restored', 'success'); }
  catch (e) { showToast(errMsg(e), 'error'); }
  finally { $('rSubmit').disabled = false; }
};

/* ---------- wallet view interactions ---------- */
$('walletChip').onclick = (e) => { e.stopPropagation(); const m = $('walletMenu'); m.hidden = !m.hidden; };
$('walletMenu').onclick = (e) => e.stopPropagation();
document.addEventListener('click', () => { const m = $('walletMenu'); if (m) m.hidden = true; });
$('advToggle').onclick = () => { const b = $('advBody'); b.hidden = !b.hidden; };

$('btnTabReceive').onclick = () => { openPanel('panelReceive'); renderQR($('recvAddr').textContent.trim()); };
$('btnTabSend').onclick = () => openPanel('panelSend');
$('closeReceive').onclick = closePanels;
$('closeSend').onclick = closePanels;
$('btnCopyAddr').onclick = () => { const t = $('recvAddr').textContent; if (t && t !== '—') copyToClipboard(t); };

$('btnSend').onclick = async () => {
  const to = $('sendTo').value.trim();
  const amount = parseFloat($('sendAmount').value);
  const pass = $('sendPass').value;
  if (!to) { showToast('Enter recipient address', 'error'); return; }
  if (!Number.isFinite(amount) || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }
  if (!pass) { showToast('Enter your wallet password', 'error'); return; }
  $('btnSend').disabled = true;
  try {
    const out = await window.synorix.ncSend(undefined, pass, to, amount);
    showToast(`Sent ${amount} SNRX`, 'success');
    $('sendTo').value = ''; $('sendAmount').value = ''; $('sendPass').value = '';
    closePanels(); await refreshBalance();
  } catch (e) { showToast(errMsg(e), 'error'); }
  finally { $('btnSend').disabled = false; }
};

/* ---------- backup / reveal ---------- */
$('btnBackup').onclick = () => { $('revPass').value = ''; $('revealStep1').hidden = false; $('revealStep2').hidden = true; openModal('modalReveal'); };
$('revSubmit').onclick = async () => {
  const pass = $('revPass').value; if (!pass) { showToast('Enter your password', 'error'); return; }
  try {
    const r = await window.synorix.ncReveal(undefined, pass);
    renderMnemonic($('revealGrid'), r.mnemonic);
    $('revCopy').onclick = () => copyToClipboard(r.mnemonic);
    $('revealStep1').hidden = true; $('revealStep2').hidden = false;
  } catch (e) { showToast(errMsg(e), 'error'); }
};

/* ---------- modal close buttons ---------- */
document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.onclick = () => { const m = btn.closest('.modal'); if (m) m.hidden = true; };
});

/* ---------- startup ---------- */
(async () => {
  setConn('warn');
  await refreshState();
  pollTimer = setInterval(() => { if (!$('walletView').hidden) refreshBalance(); }, 15000);
})();
