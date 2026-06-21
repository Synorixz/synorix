#!/bin/bash
# Deploy a Synorix mainnet node on a fresh Ubuntu 22/24 server.
# Use this to add a backup / seed node on a SECOND machine for resilience —
# so the network survives if the primary VPS goes down.
#
#   1) Get a cheap VPS (any provider), Ubuntu 22.04+, 1-2 GB RAM.
#   2) Copy this script over and run as root:  bash deploy-node.sh
#   3) Edit the rpcpassword below before running (or pass RPCPASS env).
set -euo pipefail

RPCPASS="${RPCPASS:-change-me-$(date +%s)}"
PRIMARY_PEER="${PRIMARY_PEER:-161.97.180.76:9333}"

echo "[1/4] Installing build dependencies…"
apt-get update -y
apt-get install -y git build-essential cmake pkg-config libssl-dev libevent-dev libboost-all-dev

echo "[2/4] Building Synorix node…"
cd /root
[ -d synorix ] || git clone https://github.com/Synorixz/synorix.git
cd synorix && git pull
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)" --target synorixd synorix-cli

echo "[3/4] Configuring mainnet node…"
mkdir -p /var/lib/synorix-mainnet /etc/synorix
cat > /etc/synorix/synorix-mainnet.conf <<CONF
chain=main
listen=1
server=1
rpcbind=127.0.0.1
rpcport=8332
rpcuser=synorixmain
rpcpassword=${RPCPASS}
addnode=${PRIMARY_PEER}
CONF

cat > /etc/systemd/system/synorix-mainnet.service <<UNIT
[Unit]
Description=Synorix Mainnet Node
After=network-online.target
[Service]
ExecStart=/root/synorix/build/bin/synorixd -conf=/etc/synorix/synorix-mainnet.conf -datadir=/var/lib/synorix-mainnet
Restart=on-failure
RestartSec=5
User=root
[Install]
WantedBy=multi-user.target
UNIT

echo "[4/4] Starting node (it will sync from ${PRIMARY_PEER})…"
systemctl daemon-reload
systemctl enable --now synorix-mainnet

echo "Done. Watch sync:  /root/synorix/build/bin/synorix-cli -conf=/etc/synorix/synorix-mainnet.conf -datadir=/var/lib/synorix-mainnet getblockcount"
echo "Open P2P port 9333 in the firewall so it can peer and act as a seed."
