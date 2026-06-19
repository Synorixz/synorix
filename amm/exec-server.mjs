// Synorix AMM SNRX-side executor (runs on the VPS, localhost-only).
// Holds the SNRX reserve wallet and signs+broadcasts SNRX payouts when a swap
// fills. Uses the same @scure signing path verified end-to-end on regtest.
// RPC + network come from env so the same service runs on regtest/testnet/mainnet.
import http from "http";
import fs from "fs";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto; // @scure/@noble need global WebCrypto
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";

const PORT = Number(process.env.EXEC_PORT || 3002);
const RPC_URL = process.env.EXEC_RPC_URL || "http://127.0.0.1:9332";
const RPC_USER = process.env.EXEC_RPC_USER || "synorix";
const RPC_PASS = process.env.EXEC_RPC_PASS || "";
const RESERVE_FILE = process.env.EXEC_RESERVE || "/root/synorix-amm-exec/reserve.json";

const NETS = {
  testnet: { bech32: "tsnrx", pubKeyHash: 65, scriptHash: 124, wif: 239, bip32: { public: 0x043587cf, private: 0x04358394 }, coinType: 1 },
  mainnet: { bech32: "snrx", pubKeyHash: 63, scriptHash: 122, wif: 191, bip32: { public: 0x0488b21e, private: 0x0488ade4 }, coinType: 0 },
};
const NET = NETS[process.env.EXEC_NETWORK || "testnet"];
const versions = { private: NET.bip32.private, public: NET.bip32.public };
const ap = `m/84'/${NET.coinType}'/0'`;
const GAP = 25, MATURITY = 100, SATS = 1e8;
const hexToBytes = (h) => Uint8Array.from(h.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
const bytesToHex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

function rpc(method, params = []) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: "1.0", id: "exec", method, params });
    const u = new URL(RPC_URL);
    const r = http.request({ hostname: u.hostname, port: u.port, path: "/", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
        Authorization: "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64") } },
      (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => { try { const j = JSON.parse(d); j.error ? rej(new Error(j.error.message)) : res(j.result); } catch (e) { rej(new Error("bad rpc")); } }); });
    r.on("error", rej); r.write(body); r.end();
  });
}

function loadReserve() {
  try { return JSON.parse(fs.readFileSync(RESERVE_FILE, "utf8")).mnemonic; }
  catch {
    const m = generateMnemonic(wordlist, 128);
    fs.writeFileSync(RESERVE_FILE, JSON.stringify({ mnemonic: m }), { mode: 0o600 });
    return m;
  }
}
function root() { return HDKey.fromMasterSeed(mnemonicToSeedSync(loadReserve()), versions); }
function deriveSet() {
  const r = root(); const out = [];
  for (const chain of [0, 1]) for (let i = 0; i < GAP; i++) {
    const node = r.derive(`${ap}/${chain}/${i}`); const p = btc.p2wpkh(node.publicKey, NET);
    out.push({ address: p.address, scriptHex: bytesToHex(p.script), chain, index: i, node });
  }
  return out;
}
const receiveAddress = () => btc.p2wpkh(root().derive(`${ap}/0/0`).publicKey, NET).address;

async function scan(addrs) { const r = await rpc("scantxoutset", ["start", addrs.map((a) => `addr(${a})`)]); return (r && r.unspents) || []; }

async function balance() {
  const slots = deriveSet(); const uns = await scan(slots.map((s) => s.address)); const tip = Number(await rpc("getblockcount"));
  let sp = 0, im = 0;
  for (const u of uns) { const c = u.height ? tip - u.height + 1 : 0; (u.coinbase && c < MATURITY) ? (im += Math.round(u.amount * SATS)) : (sp += Math.round(u.amount * SATS)); }
  return { spendable: sp / SATS, immature: im / SATS, address: receiveAddress() };
}

async function send(to, amount) {
  const r = root(); const slots = deriveSet(); const byScript = new Map(slots.map((s) => [s.scriptHex, s]));
  const tip = Number(await rpc("getblockcount")); const uns = await scan(slots.map((s) => s.address));
  const sp = uns.filter((u) => byScript.has(u.scriptPubKey)).filter((u) => !(u.coinbase && tip - (u.height || tip) + 1 < MATURITY)).sort((a, b) => b.amount - a.amount);
  const target = BigInt(Math.round(amount * SATS)); if (target <= 0n) throw new Error("bad amount");
  const sel = []; let inS = 0n, fee = 0n;
  for (const u of sp) { sel.push(u); inS += BigInt(Math.round(u.amount * SATS)); fee = BigInt(11 + sel.length * 68 + 62); if (inS >= target + fee) break; }
  if (inS < target + fee) throw new Error("reserve insufficient");
  const tx = new btc.Transaction();
  for (const u of sel) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: hexToBytes(u.scriptPubKey), amount: BigInt(Math.round(u.amount * SATS)) } });
  tx.addOutputAddress(to, target, NET);
  const chg = inS - target - fee; if (chg >= 294n) tx.addOutputAddress(btc.p2wpkh(r.derive(`${ap}/1/0`).publicKey, NET).address, chg, NET);
  const signed = new Set();
  for (const u of sel) { const s = byScript.get(u.scriptPubKey); const c = r.derive(`${ap}/${s.chain}/${s.index}`); const kh = bytesToHex(c.privateKey); if (!signed.has(kh)) { tx.sign(c.privateKey); signed.add(kh); } }
  tx.finalize();
  const txid = await rpc("sendrawtransaction", [tx.hex]);
  return { txid };
}

const json = (r, code, o) => { const b = JSON.stringify(o); r.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) }); r.end(b); };
http.createServer((req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  let d = ""; req.on("data", (c) => (d += c));
  req.on("end", async () => {
    try {
      const body = d ? JSON.parse(d) : {};
      if (req.url === "/address") return json(res, 200, { address: receiveAddress() });
      if (req.url === "/balance") return json(res, 200, await balance());
      if (req.url === "/send") { if (!body.to || !(body.amount > 0)) return json(res, 400, { error: "to+amount required" }); return json(res, 200, await send(body.to, Number(body.amount))); }
      return json(res, 404, { error: "not found" });
    } catch (e) { json(res, 500, { error: String(e.message || e) }); }
  });
}).listen(PORT, "127.0.0.1", () => console.log(`SNRX executor on 127.0.0.1:${PORT} (${process.env.EXEC_NETWORK || "testnet"})`));
