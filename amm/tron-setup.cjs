// Create/load the Tron (Shasta testnet) USDT reserve wallet and verify connectivity.
const { TronWeb } = require("tronweb");
const fs = require("fs");
const FILE = process.env.TRON_RESERVE || "/root/synorix-tron/reserve.json";
const HOST = process.env.TRON_HOST || "https://api.shasta.trongrid.io";
const tronWeb = new TronWeb({ fullHost: HOST });

(async () => {
  let w;
  try { w = JSON.parse(fs.readFileSync(FILE)); }
  catch {
    const acc = await tronWeb.createAccount();
    w = { address: acc.address.base58, privateKey: acc.privateKey };
    fs.writeFileSync(FILE, JSON.stringify(w), { mode: 0o600 });
    console.log("created new Tron reserve wallet");
  }
  console.log("Tron reserve address:", w.address);
  const block = await tronWeb.trx.getCurrentBlock();
  console.log("Shasta connected, block:", block.block_header.raw_data.number);
  const bal = await tronWeb.trx.getBalance(w.address);
  console.log("TRX balance:", bal / 1e6);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
