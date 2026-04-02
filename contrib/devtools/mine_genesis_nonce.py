#!/usr/bin/env python3
"""Brute-force genesis nonce for Synorix CreateGenesisBlock (matches chainparams.cpp)."""
import hashlib
import multiprocessing as mp
import struct
import sys

TIMESTAMP_STR = "Synorix - A better, faster evolution of sound money - April 2026"
N_TIME = 1743888000
N_BITS = 0x1D00FFFF  # must satisfy DeriveTarget <= powLimit (0x1e0ffff0 does NOT)
PUBKEY_HEX = (
    "04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f"
)


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
    return bytes([len(data)]) + data


def push_int64(n: int) -> bytes:
    if n == -1 or (1 <= n <= 16):
        return bytes([n + (0x51 - 1)])
    if n == 0:
        return bytes([0x00])
    return push_data(serialize_num(n))


def ser_compact_size(n: int) -> bytes:
    return bytes([n])


def build_coinbase_tx() -> bytes:
    ts = TIMESTAMP_STR.encode("ascii")
    script = push_int64(486604799) + push_data(serialize_num(4)) + push_data(ts)
    pub = bytes.fromhex(PUBKEY_HEX)
    script_pk = bytes([len(pub)]) + pub + bytes([0xAC])
    vin = (
        bytes(32)
        + struct.pack("<II", 0xFFFFFFFF, len(script))
        + script
        + struct.pack("<I", 0xFFFFFFFF)
    )
    vout = struct.pack("<q", 50 * 10**8) + ser_compact_size(len(script_pk)) + script_pk
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


def set_compact(n_compact: int) -> int:
    n_size = n_compact >> 24
    n_word = n_compact & 0x007FFFFF
    if n_size <= 3:
        return n_word >> (8 * (3 - n_size))
    return n_word << (8 * (n_size - 3))


def mine_range(args: tuple[bytes, int, int, int]) -> int | None:
    prefix, target, start, end = args
    for n in range(start, end):
        hdr = prefix + struct.pack("<I", n)
        h = dsha256(hdr)
        val = int.from_bytes(h, "little")
        if val <= target:
            return n
    return None


def main() -> None:
    tx = build_coinbase_tx()
    tx_hash = dsha256(tx)
    pow_limit = int(
        "00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff", 16
    )
    target = set_compact(N_BITS)
    if target > pow_limit or target == 0:
        print("Invalid nBits for powLimit", hex(N_BITS), file=sys.stderr)
        sys.exit(1)

    hash_prev = bytes(32)
    prefix = struct.pack("<i", 1) + hash_prev + tx_hash + struct.pack("<II", N_TIME, N_BITS)

    chunk = 500_000
    workers = max(1, mp.cpu_count() or 1)
    start_batch = 0
    print(f"Mining genesis nonce with nBits={hex(N_BITS)} target_bits={target.bit_length()}...", flush=True)
    while True:
        tasks = []
        base = start_batch * workers * chunk
        for w in range(workers):
            s = base + w * chunk
            tasks.append((prefix, target, s, s + chunk))
        with mp.Pool(workers) as pool:
            for res in pool.imap_unordered(mine_range, tasks):
                if res is not None:
                    print(f"FOUND_NONCE={res}")
                    return
        start_batch += 1
        if start_batch % 10 == 0:
            print(f"tried up to ~{base + workers * chunk} ...", flush=True)


if __name__ == "__main__":
    main()
