# Synorix

**A faster and more usable evolution of Bitcoin.**

Synorix is a Bitcoin fork designed for better everyday usability while preserving the core principles of sound money.

### Key Features

- **Block Time**: 2.5 minutes (4x faster than Bitcoin)
- **Block Size**: 8 MB (significantly higher transaction capacity)
- **Supply**: 21,000,000 SNRX (same as Bitcoin)
- **Halving**: Every 210,000 blocks (same schedule as Bitcoin)
- **Consensus**: SHA-256 Proof-of-Work
- **Fair Launch**: No premine, no ICO
- **Low Fees**: Near-zero transaction fees

### Links

- **Website**: https://synorixcoin.com (coming soon)
- **Whitepaper**: [Synorix Whitepaper](Synorix_Whitepaper.pdf)
- **Explorer**: Coming soon
- **X (Twitter)**: [@SynorixCoin](https://x.com/SynorixCoin)

### Building from Source

```bash
git clone https://github.com/Synorixz/synorix.git
cd synorix
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)

Running Testnet
Bash./synorixd -testnet -daemon
./synorix-cli -testnet getblockchaininfo

License
MIT License — see COPYING file for details.
