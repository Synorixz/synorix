#!/usr/bin/env python3
"""Verify Synorix genesis block PoW matches chainparams.cpp CreateGenesisBlock."""
import hashlib
import struct

TIMESTAMP_STR = "Synorix - A better, faster evolution of sound money - April 2026"
N_TIME = 1743888000
N_BITS = 0x1E0FFFF0
N_VERSION = 1
REWARD_SATS = 50 * 10**8
PUBKEY_HEX = (
    "04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f"
)
# Same as consensus.powLimit in chainparams (big-endian hex string in Core)
POW_LIMIT_HEX = "00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff"


def compact_to_uint256_target(bits: int) -> int:
    """Match consensus/pow.cpp DeriveTarget nBits decoding (arith_uint256 style)."""
    exponent = bits >> 24
    mantissa = bits & 0xFFFFFF
    if exponent <= 3:
        t = mantissa >> (8 * (3 - exponent))
    else:
        t = mantissa << (8 * (exponent - 3))
    return t


def serialize_num(n: int) -> bytes:
    if n == 0:
        return b""
    neg = n < 0
    absvalue = (~n + 1) & ((1 << 64) - 1) if neg else (n & ((1 << 64) - 1))
    result = bytearray()
    v = absvalue
    while v:
        result.append(v & 0xFF)
        v >>= 8
    if result[-1] & 0x80:
        result.append(0x80 if neg else 0)
    elif neg:
        result[-1] |= 0x80
    return bytes(result)


def push_data(data: bytes) -> bytes:
    n = len(data)
    if n < 76:
        return bytes([n]) + data
    raise NotImplementedError("long push")


def push_int64(n: int) -> bytes:
    # CScript::push_int64
    if n == -1 or (1 <= n <= 16):
        return bytes([n + (0x51 - 1)])
    if n == 0:
        return bytes([0x00])
    return push_data(serialize_num(n))


def build_coinbase_script() -> bytes:
    ts = TIMESTAMP_STR.encode("ascii")
    # CreateGenesisBlock: << 486604799 << CScriptNum(4) << timestamp bytes
    return push_int64(486604799) + push_data(serialize_num(4)) + push_data(ts)


def ser_compact_size(n: int) -> bytes:
    if n < 253:
        return bytes([n])
    raise NotImplementedError


def build_coinbase_tx() -> bytes:
    script_sig = build_coinbase_script()
    pub = bytes.fromhex(PUBKEY_HEX)
    script_pk = bytes([len(pub)]) + pub + bytes([0xAC])  # OP_CHECKSIG

    vin = (
        bytes(32)
        + struct.pack("<I", 0xFFFFFFFF)
        + ser_compact_size(len(script_sig))
        + script_sig
        + struct.pack("<I", 0xFFFFFFFF)
    )
    vout = struct.pack("<q", REWARD_SATS) + ser_compact_size(len(script_pk)) + script_pk

    return (
        struct.pack("<i", 1)
        + ser_compact_size(1)
        + vin
        + ser_compact_size(1)
        + vout
        + struct.pack("<I", 0)
    )


def dsha256(b: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(b).digest()).digest()


def main() -> None:
    tx = build_coinbase_tx()
    tx_hash = dsha256(tx)  # uint256 from GetHash — internal LE bytes order
    assert len(tx_hash) == 32

    pow_limit = int.from_bytes(bytes.fromhex(POW_LIMIT_HEX), "big")
    target = compact_to_uint256_target(N_BITS)
    assert target <= pow_limit, (target, pow_limit)

    hash_prev = bytes(32)

    def header_passes(nonce: int) -> bool:
        hdr = (
            struct.pack("<i", N_VERSION)
            + hash_prev
            + tx_hash
            + struct.pack("<III", N_TIME, N_BITS, nonce)
        )
        assert len(hdr) == 80
        h = dsha256(hdr)
        # Interpret as little-endian 256-bit integer (Bitcoin uint256)
        val = int.from_bytes(h, "little")
        return val <= target

    # Current chainparams nonce
    nonce = 61198
    ok = header_passes(nonce)
    print(f"Nonce {nonce} passes PoW: {ok}")

    if not ok:
        print("Searching for valid nonce...")
        for n in range(0, 10_000_000):
            if header_passes(n):
                print(f"Found valid nonce: {n}")
                break
        else:
            print("No nonce found in range (expand search).")


if __name__ == "__main__":
    main()
