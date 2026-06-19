#!/usr/bin/env python3
"""
Synorix Block Explorer — single-file service (Python stdlib only).
Runs on the VPS, talks to the local Synorix node via JSON-RPC, and serves a
premium web UI + JSON API to browse blocks, transactions and addresses.

Config via env: SNRX_RPC (default http://127.0.0.1:9332), SNRX_RPC_USER,
SNRX_RPC_PASS, SNRX_EXPLORER_PORT (default 3001), SNRX_NETWORK (label).
"""
import json, os, base64, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RPC_URL = os.environ.get('SNRX_RPC', 'http://127.0.0.1:9332')
RPC_USER = os.environ.get('SNRX_RPC_USER', 'synorix')
RPC_PASS = os.environ.get('SNRX_RPC_PASS', '')  # provided via env / systemd unit, never hardcoded
PORT = int(os.environ.get('SNRX_EXPLORER_PORT', '3001'))
NETWORK = os.environ.get('SNRX_NETWORK', 'Testnet')


def rpc(method, params=None):
    payload = json.dumps({'jsonrpc': '1.0', 'id': 'exp', 'method': method, 'params': params or []}).encode()
    req = urllib.request.Request(RPC_URL, data=payload, headers={
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + base64.b64encode(f'{RPC_USER}:{RPC_PASS}'.encode()).decode(),
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    if d.get('error'):
        raise RuntimeError(d['error']['message'])
    return d['result']


def latest_blocks(n=15):
    tip = rpc('getblockcount')
    out = []
    for h in range(tip, max(-1, tip - n), -1):
        bh = rpc('getblockhash', [h])
        b = rpc('getblockheader', [bh])
        out.append({'height': b['height'], 'hash': bh, 'time': b['time'], 'ntx': b.get('nTx', 0)})
    return {'tip': tip, 'blocks': out}


def block_detail(idv):
    bh = rpc('getblockhash', [int(idv)]) if str(idv).isdigit() else idv
    return rpc('getblock', [bh, 2])


def tx_detail(txid):
    return rpc('getrawtransaction', [txid, True])


def address_detail(addr):
    res = rpc('scantxoutset', ['start', [f'addr({addr})']])
    return {'address': addr, 'balance': res.get('total_amount', 0), 'utxos': res.get('unspents', []), 'txouts': res.get('txouts', 0)}


HTML = r'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Synorix Explorer</title><style>
:root{--bg:#0a0b10;--card:#161925;--line:#262b3d;--text:#eef1f8;--muted:#8b91a7;--gold:#e8b339;--gold2:#f6cf5e;--violet:#7c5cff;--green:#34d399}
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:radial-gradient(900px 500px at 50% -10%,rgba(124,92,255,.14),transparent 60%),var(--bg);color:var(--text);min-height:100vh}
.wrap{max-width:1000px;margin:0 auto;padding:24px 18px 60px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px;flex-wrap:wrap;gap:12px}
.brand{display:flex;align-items:center;gap:11px}.logo{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;font-weight:800;font-size:20px;color:#1a1407;background:linear-gradient(135deg,var(--gold2),var(--gold))}
.brand h1{font-size:20px}.brand span{color:var(--muted);font-size:12px}
.net{font-size:11px;font-weight:700;text-transform:uppercase;color:var(--violet);background:rgba(124,92,255,.14);border:1px solid rgba(124,92,255,.3);padding:5px 10px;border-radius:999px}
.search{display:flex;gap:8px;margin-bottom:20px}
.search input{flex:1;background:var(--card);border:1px solid var(--line);border-radius:12px;color:var(--text);padding:13px 15px;font-size:14px;outline:none}
.search input:focus{border-color:var(--violet)}
.search button{background:linear-gradient(135deg,var(--gold2),var(--gold));border:none;border-radius:12px;color:#1a1407;font-weight:700;padding:0 20px;cursor:pointer}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:22px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:15px}.stat .l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px}.stat .v{font-size:22px;font-weight:800;margin-top:5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px;margin-bottom:18px}
.card h2{font-size:14px;color:var(--muted);padding:12px 14px 6px;text-transform:uppercase;letter-spacing:.5px}
.row{display:flex;align-items:center;gap:12px;padding:12px 14px;border-top:1px solid var(--line);cursor:pointer;text-decoration:none;color:var(--text)}
.row:hover{background:rgba(255,255,255,.03)}.row:first-of-type{border-top:none}
.h{font-weight:700;color:var(--gold2);min-width:70px}.mono{font-family:Consolas,monospace;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.t{color:var(--muted);font-size:12px;white-space:nowrap}
.io{display:flex;gap:14px;flex-wrap:wrap}.io>div{flex:1;min-width:240px}
.io-item{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:9px 11px;margin:6px 0;font-size:12px}
.addr{font-family:Consolas,monospace;color:var(--gold2);word-break:break-all}.amt{color:var(--green);font-weight:700;float:right}
.k{color:var(--muted);font-size:12px}.v{font-family:Consolas,monospace;font-size:12px;word-break:break-all}
.kv{padding:9px 14px;border-top:1px solid var(--line);display:flex;gap:12px}.kv .k{min-width:130px}
.back{color:var(--violet);cursor:pointer;font-size:13px;margin-bottom:14px;display:inline-block}
.empty{color:var(--muted);padding:18px;text-align:center}
</style></head><body><div class="wrap">
<header><div class="brand"><div class="logo">S</div><div><h1>Synorix Explorer</h1><span>Blocks · Transactions · Addresses</span></div></div><span class="net" id="net">Testnet</span></header>
<div class="search"><input id="q" placeholder="Search block height / hash, txid, or address…"/><button onclick="search()">Search</button></div>
<div id="view"></div></div>
<script>
const $=id=>document.getElementById(id);
async function api(p){const r=await fetch('/api'+p);if(!r.ok)throw new Error((await r.json()).error||'error');return r.json();}
function short(s,n=20){return s&&s.length>n?s.slice(0,n)+'…':s;}
function tdate(t){return new Date(t*1000).toLocaleString();}
async function home(){
 try{const info=await api('/info');$('net').textContent=info.network;
 const d=await api('/blocks');
 let h=`<div class="stats"><div class="stat"><div class="l">Height</div><div class="v">${d.tip}</div></div><div class="stat"><div class="l">Chain</div><div class="v">${info.chain}</div></div><div class="stat"><div class="l">Difficulty</div><div class="v">${Number(info.difficulty).toFixed(4)}</div></div></div>`;
 h+=`<div class="card"><h2>Latest Blocks</h2>`;
 h+=d.blocks.map(b=>`<a class="row" onclick="showBlock('${b.hash}')"><span class="h">#${b.height}</span><span class="mono">${b.hash}</span><span class="t">${b.ntx} tx · ${tdate(b.time)}</span></a>`).join('');
 h+=`</div>`;$('view').innerHTML=h;
 }catch(e){$('view').innerHTML='<div class="empty">Node unreachable: '+e.message+'</div>';}
}
async function showBlock(id){
 try{const b=await api('/block/'+id);
 let h=`<span class="back" onclick="home()">← Back</span><div class="card"><h2>Block #${b.height}</h2>`;
 h+=kv('Hash',b.hash)+kv('Time',tdate(b.time))+kv('Transactions',b.tx.length)+kv('Size',b.size+' bytes')+kv('Merkle root',b.merkleroot)+`</div>`;
 h+=`<div class="card"><h2>Transactions</h2>`+b.tx.map(t=>`<a class="row" onclick="showTx('${t.txid}')"><span class="mono">${t.txid}</span><span class="t">${t.vout.length} out</span></a>`).join('')+`</div>`;
 $('view').innerHTML=h;
 }catch(e){$('view').innerHTML='<span class="back" onclick="home()">← Back</span><div class="empty">'+e.message+'</div>';}
}
async function showTx(txid){
 try{const t=await api('/tx/'+txid);
 const ins=t.vin.map(v=>v.coinbase?`<div class="io-item"><span class="addr">Coinbase (newly minted)</span></div>`:`<div class="io-item"><span class="addr">${short(v.txid,24)}:${v.vout}</span></div>`).join('');
 const outs=t.vout.map(v=>{const a=(v.scriptPubKey&&(v.scriptPubKey.address||(v.scriptPubKey.addresses&&v.scriptPubKey.addresses[0])))||'(non-standard)';return `<div class="io-item"><span class="amt">${v.value} SNRX</span><span class="addr" onclick="showAddr('${a}')" style="cursor:pointer">${a}</span></div>`;}).join('');
 let h=`<span class="back" onclick="home()">← Back</span><div class="card"><h2>Transaction</h2>`+kv('TXID',t.txid)+kv('Confirmations',t.confirmations||0)+`</div>`;
 h+=`<div class="card"><h2>Inputs → Outputs</h2><div class="io" style="padding:12px"><div><div class="k">From</div>${ins}</div><div><div class="k">To</div>${outs}</div></div></div>`;
 $('view').innerHTML=h;
 }catch(e){$('view').innerHTML='<span class="back" onclick="home()">← Back</span><div class="empty">'+e.message+'</div>';}
}
async function showAddr(a){
 try{const d=await api('/address/'+a);
 let h=`<span class="back" onclick="home()">← Back</span><div class="card"><h2>Address</h2>`+kv('Address',d.address)+kv('Balance',d.balance+' SNRX')+kv('Unspent outputs',d.utxos.length)+`</div>`;
 h+=`<div class="card"><h2>Unspent Outputs</h2>`+(d.utxos.length?d.utxos.map(u=>`<div class="row"><span class="mono">${short(u.txid,28)}:${u.vout}</span><span class="amt">${u.amount} SNRX</span></div>`).join(''):'<div class="empty">No unspent outputs</div>')+`</div>`;
 $('view').innerHTML=h;
 }catch(e){$('view').innerHTML='<span class="back" onclick="home()">← Back</span><div class="empty">'+e.message+'</div>';}
}
function kv(k,v){return `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;}
async function search(){const q=$('q').value.trim();if(!q)return;
 if(/^\d+$/.test(q))return showBlock(q);
 if(q.length===64)return showBlock(q).catch(()=>showTx(q));
 if(/^t?snrx1/.test(q)||q.length<64)return showAddr(q);
 showBlock(q);
}
$('q').addEventListener('keydown',e=>{if(e.key==='Enter')search();});
home();
</script></body></html>'''


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype='application/json'):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        try:
            p = self.path.split('?')[0]
            if p == '/' or p == '/index.html':
                return self._send(200, HTML, 'text/html; charset=utf-8')
            if p == '/api/info':
                i = rpc('getblockchaininfo')
                return self._send(200, json.dumps({'chain': i['chain'], 'blocks': i['blocks'], 'difficulty': i['difficulty'], 'network': NETWORK}))
            if p == '/api/blocks':
                return self._send(200, json.dumps(latest_blocks()))
            if p.startswith('/api/block/'):
                return self._send(200, json.dumps(block_detail(p.split('/api/block/')[1])))
            if p.startswith('/api/tx/'):
                return self._send(200, json.dumps(tx_detail(p.split('/api/tx/')[1])))
            if p.startswith('/api/address/'):
                return self._send(200, json.dumps(address_detail(p.split('/api/address/')[1])))
            return self._send(404, json.dumps({'error': 'not found'}))
        except Exception as e:
            return self._send(500, json.dumps({'error': str(e)}))


if __name__ == '__main__':
    print(f'Synorix Explorer on :{PORT} (rpc {RPC_URL}, {NETWORK})')
    ThreadingHTTPServer(('0.0.0.0', PORT), H).serve_forever()
