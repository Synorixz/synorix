'use strict';
/**
 * Synorix non-custodial wallet core.
 * Keys are generated and kept on the user's device. The node is only a blockchain
 * backend via the injected `rpc(method, params)` callback (scantxoutset for
 * balances/UTXOs, sendrawtransaction to broadcast locally-signed txs).
 *
 * Privacy/UX: the account-level xpub is stored so balances and receive addresses
 * derive WITHOUT a password. The encrypted mnemonic is only decrypted to SIGN.
 * Crypto is delegated to audited libraries (bitcoinjs-lib / bip39 / bip32).
 */
const crypto = require('crypto');
const ecc = require('tiny-secp256k1');
const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const bip32mod = require('bip32');
const BIP32Factory = bip32mod.BIP32Factory || bip32mod.default;
const { NETWORKS } = require('./synorix-net');

const bip32 = BIP32Factory(ecc);

const GAP_LIMIT = 25;
const COINBASE_MATURITY = 100;
const SATS = 100000000;
const DUST = 294;

function coinType(network) { return network === 'mainnet' ? 0 : 1; }
function netObj(network) { return NETWORKS[network] || NETWORKS.testnet; }
function toSats(snrx) { return Math.round(Number(snrx) * SATS); }
function fromSats(s) { return s / SATS; }
function accountPath(network) { return `m/84'/${coinType(network)}'/0'`; }

/* ---------- encryption (AES-256-GCM, scrypt KDF) ---------- */
function encrypt(plaintext, password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: enc.toString('hex') };
}
function decrypt(blob, password) {
  const key = crypto.scryptSync(String(password), Buffer.from(blob.salt, 'hex'), 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
  d.setAuthTag(Buffer.from(blob.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(blob.data, 'hex')), d.final()]).toString('utf8');
}

/* ---------- derivation ---------- */
function rootFromMnemonic(mnemonic, network) {
  const seed = bip39.mnemonicToSeedSync(mnemonic.trim());
  return bip32.fromSeed(Buffer.from(seed), netObj(network));
}
function accountXpub(mnemonic, network) {
  return rootFromMnemonic(mnemonic, network).derivePath(accountPath(network)).neutered().toBase58();
}
function addressOf(node, network) {
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(node.publicKey), network: netObj(network) }).address;
}
// public (xpub) derivation — no private key needed
function addrFromXpub(meta, chain, index) {
  const acc = bip32.fromBase58(meta.xpub, netObj(meta.network));
  return addressOf(acc.derive(chain).derive(index), meta.network);
}
function addressMapPub(meta) {
  const acc = bip32.fromBase58(meta.xpub, netObj(meta.network));
  const map = new Map();
  for (const chain of [0, 1]) {
    const branch = acc.derive(chain);
    for (let i = 0; i < GAP_LIMIT; i++) map.set(addressOf(branch.derive(i), meta.network), { chain, index: i });
  }
  return map;
}

/* ---------- wallet metadata ---------- */
function walletMeta(name, network, encrypted, xpub) {
  return { id: 'w_' + crypto.randomBytes(6).toString('hex'), name: String(name || 'Wallet'), network, encrypted, xpub };
}
function createWallet(name, password, network = 'testnet') {
  const mnemonic = bip39.generateMnemonic(128); // 12 words
  return { meta: walletMeta(name, network, encrypt(mnemonic, password), accountXpub(mnemonic, network)), mnemonic };
}
function restoreWallet(name, mnemonic, password, network = 'testnet') {
  const m = String(mnemonic || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(m)) throw new Error('Invalid recovery phrase.');
  return { meta: walletMeta(name, network, encrypt(m, password), accountXpub(m, network)) };
}
function revealMnemonic(meta, password) { return decrypt(meta.encrypted, password); }
function checkPassword(meta, password) { try { decrypt(meta.encrypted, password); return true; } catch { return false; } }
function firstReceiveAddress(meta) { return addrFromXpub(meta, 0, 0); }

/* ---------- balance via scantxoutset ---------- */
async function scanUtxos(addresses, rpc) {
  const res = await rpc('scantxoutset', ['start', addresses.map((a) => `addr(${a})`)]);
  return (res && res.unspents) ? res.unspents : [];
}
async function getBalance(meta, rpc) {
  const map = addressMapPub(meta);
  const unspents = await scanUtxos([...map.keys()], rpc);
  const tip = Number(await rpc('getblockcount', []));
  let spendable = 0, immature = 0;
  for (const u of unspents) {
    const confs = u.height ? (tip - u.height + 1) : 0;
    if (u.coinbase && confs < COINBASE_MATURITY) immature += toSats(u.amount); else spendable += toSats(u.amount);
  }
  return { spendable: fromSats(spendable), immature: fromSats(immature), total: fromSats(spendable + immature) };
}

/* ---------- send: build + sign locally + broadcast ---------- */
async function send(meta, password, toAddress, amountSnrx, rpc, opts = {}) {
  const network = meta.network;
  const net = netObj(network);
  // validate destination for this network
  try { bitcoin.address.toOutputScript(toAddress, net); } catch { throw new Error('Invalid Synorix address for this network.'); }
  const root = rootFromMnemonic(decrypt(meta.encrypted, password), network); // throws on wrong password
  const map = addressMapPub(meta);
  const tip = Number(await rpc('getblockcount', []));
  const unspents = await scanUtxos([...map.keys()], rpc);

  const spendables = unspents
    .map((u) => ({ ...u, address: scriptToAddress(u.scriptPubKey, net) }))
    .filter((u) => u.address && map.has(u.address))
    .filter((u) => !(u.coinbase && (tip - (u.height || tip) + 1) < COINBASE_MATURITY))
    .sort((a, b) => b.amount - a.amount);

  const target = toSats(amountSnrx);
  if (!(target > 0)) throw new Error('Amount must be greater than 0.');
  const feeRate = Number(opts.feeRate || 1);
  let selected = [], inSats = 0, fee = 0;
  for (const u of spendables) {
    selected.push(u); inSats += toSats(u.amount);
    fee = Math.ceil((11 + selected.length * 68 + 2 * 31) * feeRate);
    if (inSats >= target + fee) break;
  }
  if (inSats < target + fee) throw new Error('Insufficient spendable funds. Mining rewards mature after 100 blocks.');

  const psbt = new bitcoin.Psbt({ network: net });
  for (const u of selected) {
    psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: Buffer.from(u.scriptPubKey, 'hex'), value: toSats(u.amount) } });
  }
  psbt.addOutput({ address: toAddress, value: target });
  const change = inSats - target - fee;
  if (change >= DUST) psbt.addOutput({ address: addrFromXpub(meta, 1, 0), value: change });

  selected.forEach((u, i) => {
    const { chain, index } = map.get(u.address);
    const child = root.derivePath(`${accountPath(network)}/${chain}/${index}`);
    psbt.signInput(i, { publicKey: Buffer.from(child.publicKey), sign: (h) => Buffer.from(child.sign(h)) });
  });
  psbt.finalizeAllInputs();
  const txid = await rpc('sendrawtransaction', [psbt.extractTransaction().toHex()]);
  return { txid, fee: fromSats(fee), inputs: selected.length, amount: amountSnrx };
}

function scriptToAddress(scriptHex, net) {
  try { return bitcoin.address.fromOutputScript(Buffer.from(scriptHex, 'hex'), net); } catch { return null; }
}

module.exports = {
  createWallet, restoreWallet, revealMnemonic, checkPassword,
  firstReceiveAddress, addrFromXpub, getBalance, send, GAP_LIMIT,
};
