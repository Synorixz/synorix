'use strict';
/**
 * Synorix non-custodial wallet core.
 * Keys are generated and kept on the user's device. The node is used only as a
 * blockchain backend via the injected `rpc(method, params)` callback:
 *   - scantxoutset  -> balances / UTXOs (no server-side wallet, no key custody)
 *   - sendrawtransaction -> broadcast locally-signed transactions
 * Crypto is delegated to audited libraries (bitcoinjs-lib / bip39 / bip32).
 */
const crypto = require('crypto');
const ecc = require('tiny-secp256k1');
const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const bip32mod = require('bip32');
const ecpairmod = require('ecpair');
const BIP32Factory = bip32mod.BIP32Factory || bip32mod.default;
const ECPairFactory = ecpairmod.ECPairFactory || ecpairmod.default;
const { NETWORKS } = require('./synorix-net');

const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

const GAP_LIMIT = 25;
const COINBASE_MATURITY = 100;
const SATS = 100000000;
const DUST = 294; // p2wpkh dust threshold

function coinType(network) { return network === 'mainnet' ? 0 : 1; }
function netObj(network) { return NETWORKS[network] || NETWORKS.testnet; }
function toSats(snrx) { return Math.round(Number(snrx) * SATS); }
function fromSats(s) { return s / SATS; }

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

/* ---------- key derivation ---------- */
function rootFromMnemonic(mnemonic, network) {
  const seed = bip39.mnemonicToSeedSync(mnemonic.trim());
  return bip32.fromSeed(Buffer.from(seed), netObj(network));
}
function deriveNode(root, network, chain, index) {
  return root.derivePath(`m/84'/${coinType(network)}'/0'/${chain}/${index}`);
}
function addressOf(node, network) {
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(node.publicKey), network: netObj(network) }).address;
}

/* ---------- wallet metadata (no plaintext key stored) ---------- */
function createWallet(name, password, network = 'testnet') {
  const mnemonic = bip39.generateMnemonic(128); // 12 words
  return { meta: walletMeta(name, network, encrypt(mnemonic, password)), mnemonic };
}
function restoreWallet(name, mnemonic, password, network = 'testnet') {
  if (!bip39.validateMnemonic(mnemonic.trim())) throw new Error('Invalid recovery phrase.');
  return { meta: walletMeta(name, network, encrypt(mnemonic.trim(), password)) };
}
function walletMeta(name, network, encrypted) {
  return { id: 'w_' + crypto.randomBytes(6).toString('hex'), name: String(name || 'Wallet'), network, encrypted, createdAt: null };
}
function revealMnemonic(meta, password) { return decrypt(meta.encrypted, password); }

/* ---------- address set (gap limit) ---------- */
function buildAddressMap(root, network) {
  // returns Map<address, {chain,index,node}> for external + change up to GAP_LIMIT
  const map = new Map();
  for (const chain of [0, 1]) {
    for (let i = 0; i < GAP_LIMIT; i++) {
      const node = deriveNode(root, network, chain, i);
      map.set(addressOf(node, network), { chain, index: i, node });
    }
  }
  return map;
}
function firstReceiveAddress(meta, password) {
  const root = rootFromMnemonic(decrypt(meta.encrypted, password), meta.network);
  return addressOf(deriveNode(root, meta.network, 0, 0), meta.network);
}

/* ---------- balance / UTXOs via scantxoutset ---------- */
async function scanUtxos(addresses, rpc) {
  const descriptors = addresses.map((a) => `addr(${a})`);
  const res = await rpc('scantxoutset', ['start', descriptors]);
  return (res && res.unspents) ? res.unspents : [];
}
async function getBalance(meta, password, rpc) {
  const root = rootFromMnemonic(decrypt(meta.encrypted, password), meta.network);
  const map = buildAddressMap(root, meta.network);
  const unspents = await scanUtxos([...map.keys()], rpc);
  const tip = Number(await rpc('getblockcount', []));
  let spendable = 0, immature = 0;
  for (const u of unspents) {
    const confs = u.height ? (tip - u.height + 1) : 0;
    const isImmatureCoinbase = u.coinbase && confs < COINBASE_MATURITY;
    if (isImmatureCoinbase) immature += toSats(u.amount); else spendable += toSats(u.amount);
  }
  return { spendable: fromSats(spendable), immature: fromSats(immature), total: fromSats(spendable + immature) };
}

/* ---------- send: build + sign locally + broadcast ---------- */
async function send(meta, password, toAddress, amountSnrx, rpc, opts = {}) {
  const network = meta.network;
  const net = netObj(network);
  const root = rootFromMnemonic(decrypt(meta.encrypted, password), network);
  const map = buildAddressMap(root, network);
  const tip = Number(await rpc('getblockcount', []));
  const unspents = await scanUtxos([...map.keys()], rpc);

  // spendable, mature UTXOs we own
  const spendables = unspents
    .filter((u) => map.has(scriptToAddress(u.scriptPubKey, net)))
    .filter((u) => !(u.coinbase && (tip - (u.height || tip) + 1) < COINBASE_MATURITY))
    .map((u) => ({ ...u, address: scriptToAddress(u.scriptPubKey, net) }))
    .sort((a, b) => b.amount - a.amount);

  const target = toSats(amountSnrx);
  if (target <= 0) throw new Error('Amount must be greater than 0.');
  const feeRate = Number(opts.feeRate || 1); // sats/vbyte
  // greedy coin selection
  let selected = [], inSats = 0;
  for (const u of spendables) {
    selected.push(u); inSats += toSats(u.amount);
    const vbytes = 11 + selected.length * 68 + 2 * 31; // rough p2wpkh size (2 outputs)
    if (inSats >= target + Math.ceil(vbytes * feeRate)) break;
  }
  const vbytes = 11 + selected.length * 68 + 2 * 31;
  const fee = Math.ceil(vbytes * feeRate);
  if (inSats < target + fee) throw new Error('Insufficient spendable funds (mining rewards mature after 100 blocks).');

  const psbt = new bitcoin.Psbt({ network: net });
  for (const u of selected) {
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      witnessUtxo: { script: Buffer.from(u.scriptPubKey, 'hex'), value: toSats(u.amount) },
    });
  }
  psbt.addOutput({ address: toAddress, value: target });
  const change = inSats - target - fee;
  const changeAddr = addressOf(deriveNode(root, network, 1, 0), network); // first change address
  if (change >= DUST) psbt.addOutput({ address: changeAddr, value: change });

  // sign each input locally with the key that owns it (Buffer-wrapped signer so
  // newer ecc libs returning Uint8Array stay compatible with bitcoinjs-lib v6).
  selected.forEach((u, i) => {
    const child = map.get(u.address).node;
    psbt.signInput(i, {
      publicKey: Buffer.from(child.publicKey),
      sign: (hash) => Buffer.from(child.sign(hash)),
    });
  });
  psbt.finalizeAllInputs();
  const hex = psbt.extractTransaction().toHex();
  const txid = await rpc('sendrawtransaction', [hex]);
  return { txid, fee: fromSats(fee), inputs: selected.length };
}

function scriptToAddress(scriptHex, net) {
  try { return bitcoin.address.fromOutputScript(Buffer.from(scriptHex, 'hex'), net); }
  catch { return null; }
}

module.exports = {
  createWallet, restoreWallet, revealMnemonic, firstReceiveAddress,
  getBalance, send, addressOf, deriveNode, rootFromMnemonic, GAP_LIMIT,
};
