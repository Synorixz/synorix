#!/usr/bin/env python3
"""
Synorix treasury key generator.
Generates a fresh secp256k1 keypair and derives:
  - mainnet P2PKH address (base58, version byte 63)
  - WIF private key (version byte 191, compressed)
  - the P2PKH scriptPubKey hex (for chainparams treasury script)

Pure-python (no external deps) so it runs anywhere. The PRIVATE KEY / WIF
must be stored safely by the owner; whoever holds it controls the treasury.
"""
import secrets
import hashlib

# ---- secp256k1 ----
P  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8

def inv(a, m): return pow(a, m - 2, m)

def point_add(p, q):
    if p is None: return q
    if q is None: return p
    (x1, y1), (x2, y2) = p, q
    if x1 == x2 and (y1 + y2) % P == 0: return None
    if p == q:
        l = (3 * x1 * x1) * inv(2 * y1, P) % P
    else:
        l = (y2 - y1) * inv(x2 - x1, P) % P
    x3 = (l * l - x1 - x2) % P
    y3 = (l * (x1 - x3) - y1) % P
    return (x3, y3)

def scalar_mul(k, p):
    r = None
    while k:
        if k & 1: r = point_add(r, p)
        p = point_add(p, p)
        k >>= 1
    return r

# ---- pure-python RIPEMD160 (OpenSSL 3 may not expose it) ----
def ripemd160(msg):
    try:
        return hashlib.new('ripemd160', msg).digest()
    except Exception:
        pass
    # minimal pure-python implementation
    import struct
    rol = lambda x, n: ((x << n) | (x >> (32 - n))) & 0xffffffff
    rl = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,
          3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,
          4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13]
    rr = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,
          15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,
          12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11]
    sl = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,
          11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,
          9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6]
    sr = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,
          9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,
          8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11]
    kl = [0,0x5a827999,0x6ed9eba1,0x8f1bbcdc,0xa953fd4e]
    kr = [0x50a28be6,0x5c4dd124,0x6d703ef3,0x7a6d76e9,0]
    def f(j, x, y, z):
        if j < 16: return x ^ y ^ z
        if j < 32: return (x & y) | (~x & z)
        if j < 48: return (x | ~y) ^ z
        if j < 64: return (x & z) | (y & ~z)
        return x ^ (y | ~z)
    h0,h1,h2,h3,h4 = 0x67452301,0xefcdab89,0x98badcfe,0x10325476,0xc3d2e1f0
    ml = len(msg)
    msg += b'\x80' + b'\x00' * ((55 - ml) % 64) + struct.pack('<Q', ml * 8)
    for off in range(0, len(msg), 64):
        X = list(struct.unpack('<16I', msg[off:off+64]))
        al,bl,cl,dl,el = h0,h1,h2,h3,h4
        ar,br,cr,dr,er = h0,h1,h2,h3,h4
        for j in range(80):
            t = (al + f(j, bl, cl, dl) + X[rl[j]] + kl[j//16]) & 0xffffffff
            t = (rol(t, sl[j]) + el) & 0xffffffff
            al,bl,cl,dl,el = el,t,bl,rol(cl,10),dl
            t = (ar + f(79-j, br, cr, dr) + X[rr[j]] + kr[j//16]) & 0xffffffff
            t = (rol(t, sr[j]) + er) & 0xffffffff
            ar,br,cr,dr,er = er,t,br,rol(cr,10),dr
        t  = (h1 + cl + dr) & 0xffffffff
        h1 = (h2 + dl + er) & 0xffffffff
        h2 = (h3 + el + ar) & 0xffffffff
        h3 = (h4 + al + br) & 0xffffffff
        h4 = (h0 + bl + cr) & 0xffffffff
        h0 = t
    return struct.pack('<5I', h0,h1,h2,h3,h4)

def sha256(b): return hashlib.sha256(b).digest()
def hash160(b): return ripemd160(sha256(b))

B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58check(payload):
    chk = sha256(sha256(payload))[:4]
    data = payload + chk
    n = int.from_bytes(data, 'big')
    s = ''
    while n > 0:
        n, r = divmod(n, 58)
        s = B58[r] + s
    s = '1' * (len(data) - len(data.lstrip(b'\x00'))) + s
    return s

# mainnet prefixes (from chainparams.cpp)
PUBKEY_VER = 63
SECRET_VER = 191

priv = secrets.randbelow(N - 1) + 1
px, py = scalar_mul(priv, (Gx, Gy))
prefix = b'\x02' if py % 2 == 0 else b'\x03'
pub_compressed = prefix + px.to_bytes(32, 'big')
h160 = hash160(pub_compressed)

address = b58check(bytes([PUBKEY_VER]) + h160)
wif = b58check(bytes([SECRET_VER]) + priv.to_bytes(32, 'big') + b'\x01')
# P2PKH scriptPubKey: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
script_hex = '76a914' + h160.hex() + '88ac'

print('=== SYNORIX TREASURY KEY (MAINNET) ===')
print('private_key_hex :', hex(priv)[2:].zfill(64))
print('WIF             :', wif)
print('pubkey_compressed:', pub_compressed.hex())
print('hash160         :', h160.hex())
print('address (P2PKH) :', address)
print('scriptPubKey hex:', script_hex)
