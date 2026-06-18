#!/usr/bin/env python3
"""
Synorix genesis block miner.
Reconstructs the exact CreateGenesisBlock(...) serialization from
src/kernel/chainparams.cpp and searches for a nonce whose double-SHA256
header hash is <= target(nBits). Prints nonce, genesis hash, merkle root.

Mainnet and testnet3 use identical genesis params -> one result covers both.
"""
import hashlib, struct, sys
from multiprocessing import Process, Queue, cpu_count

# ---- genesis parameters (must match chainparams.cpp) ----
PSZ        = b"Synorix - A better, faster evolution of sound money - April 2026"
PUBKEY     = bytes.fromhex(
    "04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb6"
    "49f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f")
NTIME      = 1743888000
NBITS      = 0x1e0ffff0
NVERSION   = 1
REWARD     = 50 * 100_000_000   # 50 COIN

def dsha(b): return hashlib.sha256(hashlib.sha256(b).digest()).digest()

def scriptnum(n):
    if n == 0: return b''
    out = bytearray(); a = abs(n)
    while a: out.append(a & 0xff); a >>= 8
    if out[-1] & 0x80: out.append(0x80 if n < 0 else 0x00)
    elif n < 0: out[-1] |= 0x80
    return bytes(out)

def pushdata(d):
    return bytes([len(d)]) + d  # all our pushes are < 0x4c bytes

# scriptSig = CScript() << 486604799 << CScriptNum(4) << PSZ
s1 = scriptnum(486604799)
s2 = scriptnum(4)
scriptSig = pushdata(s1) + pushdata(s2) + bytes([len(PSZ)]) + PSZ
# scriptPubKey = <pubkey> OP_CHECKSIG
scriptPubKey = bytes([len(PUBKEY)]) + PUBKEY + b'\xac'

# coinbase tx (legacy serialization)
tx  = struct.pack('<i', 1)                       # version
tx += b'\x01'                                    # vin count
tx += b'\x00' * 32 + b'\xff\xff\xff\xff'         # prevout null
tx += bytes([len(scriptSig)]) + scriptSig
tx += b'\xff\xff\xff\xff'                         # sequence
tx += b'\x01'                                    # vout count
tx += struct.pack('<q', REWARD)
tx += bytes([len(scriptPubKey)]) + scriptPubKey
tx += struct.pack('<I', 0)                        # locktime
MERKLE = dsha(tx)                                 # single tx -> merkle = txid

# header without nonce
HEAD = struct.pack('<i', NVERSION) + b'\x00'*32 + MERKLE + struct.pack('<I', NTIME) + struct.pack('<I', NBITS)

exp = NBITS >> 24
mant = NBITS & 0xffffff
TARGET = mant << (8 * (exp - 3))

def worker(start, step, q):
    nonce = start
    head = HEAD
    while True:
        h = dsha(head + struct.pack('<I', nonce))
        if int.from_bytes(h, 'little') <= TARGET:
            q.put((nonce, h)); return
        nonce += step
        if nonce > 0xffffffff:
            return

if __name__ == '__main__':
    ncpu = cpu_count()
    print(f"target  = {TARGET:064x}")
    print(f"merkle  = {MERKLE[::-1].hex()}")
    print(f"mining with {ncpu} workers (nBits={NBITS:#010x}) ...", flush=True)
    q = Queue()
    procs = [Process(target=worker, args=(i, ncpu, q)) for i in range(ncpu)]
    for p in procs: p.start()
    nonce, h = q.get()
    for p in procs: p.terminate()
    print("=== GENESIS FOUND ===")
    print("nonce        :", nonce)
    print("genesis hash :", h[::-1].hex())
    print("merkle root  :", MERKLE[::-1].hex())
