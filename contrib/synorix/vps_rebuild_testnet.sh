#!/usr/bin/env bash
# Synorix — rebuild node and relaunch testnet from the new genesis (run ON the VPS).
# After the chainparams/treasury changes, the OLD testnet chain is incompatible
# (new genesis hash + new network magic), so the datadir must be wiped and resynced.
set -euo pipefail

REPO=/root/synorix
DATADIR=/var/lib/synorix-testnet
CONF=/etc/synorix/synorix.conf

cd "$REPO"
echo ">> Pulling latest source (make sure changes are pushed/copied here first)"
# git pull origin main    # uncomment if pulling from GitHub

echo ">> Building synorixd + synorix-cli"
cmake -S . -B build -DENABLE_IPC=OFF
cmake --build build -j"$(nproc)"

echo ">> Stopping any running node"
./build/bin/synorix-cli -testnet -conf="$CONF" -datadir="$DATADIR" stop 2>/dev/null || true
sleep 3

echo ">> Wiping old testnet chain (new genesis => old chain invalid)"
# Keep wallets! Only remove the chain data, not the wallets/ dir.
rm -rf "$DATADIR/testnet3/blocks" "$DATADIR/testnet3/chainstate" \
       "$DATADIR/testnet3/indexes" "$DATADIR/testnet3/banlist.json" \
       "$DATADIR/testnet3/peers.dat" "$DATADIR/testnet3/mempool.dat" 2>/dev/null || true

echo ">> Starting fresh node"
./build/bin/synorixd -testnet -blocksxor=0 -daemon -conf="$CONF" -datadir="$DATADIR"
sleep 5

echo ">> Verifying genesis hash (expect 00000d35...8cb15da2)"
./build/bin/synorix-cli -testnet -conf="$CONF" -datadir="$DATADIR" getblockhash 0

echo ">> Mining 1 block to a test address and checking the treasury output"
ADDR=$(./build/bin/synorix-cli -testnet -conf="$CONF" -datadir="$DATADIR" getnewaddress)
./build/bin/synorix-cli -testnet -conf="$CONF" -datadir="$DATADIR" generatetoaddress 1 "$ADDR"
HASH=$(./build/bin/synorix-cli -testnet -conf="$CONF" -datadir="$DATADIR" getblockhash 1)
echo ">> Coinbase of block 1 (look for a vout paying the treasury script 76a914a24cf3...88ac, ~2.5 SNRX):"
./build/bin/synorix-cli -testnet -conf="$CONF" -datadir="$DATADIR" getblock "$HASH" 2 | sed -n '/"tx"/,/]/p' | head -60

echo ">> Done. Treasury address: Sc6AghkPkxmpKfoTpUUQPmoQ4TJDmJnDyz"
