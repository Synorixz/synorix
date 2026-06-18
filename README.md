# Synorix (SNRX)

**A faster, more usable evolution of Bitcoin with a sustainable Value Distribution Layer.**

Synorix is a progressive Bitcoin fork designed to solve the practical limitations of legacy blockchains—slow confirmation times and network congestion—while introducing a self-sustaining ecosystem funded by an automated, on-chain Treasury.

## Key Features

* **Block Time:** 2.5 minutes (4x faster than Bitcoin for rapid transactions)
* **Block Capacity:** 8,000,000 weight units (~2x Bitcoin's transaction throughput)
* **Supply:** 21,000,000 SNRX (Hard-capped, identical to Bitcoin)
* **Block Reward:** 50 SNRX, halving every 210,000 blocks (~1 year at 2.5-minute blocks)
* **Consensus:** SHA-256 Proof-of-Work
* **Fair Launch:** 0% premine, no ICO, no presale, no team allocation at genesis. Coins enter circulation only through mining.
* **On-Chain Treasury:** 5% of every block subsidy is routed automatically, in the coinbase, to a single transparent Treasury address to fund liquidity, development, and ecosystem growth. The remaining 95% (plus all transaction fees) goes to miners.
* **Difficulty Adjustment:** Bitcoin-style retargeting every two weeks to keep block times near 2.5 minutes as hashrate changes.

## Links

* **Website:** [https://synorixcoin.com](https://synorixcoin.com) *(coming soon)*
* **Whitepaper:** [Synorix Whitepaper (PDF)](./Synorix_Whitepaper.pdf) · [Litepaper (PDF)](./Synorix_Litepaper.pdf)
* **Explorer:** *(coming soon)*
* **X (Twitter):** [@SynorixCoin](https://twitter.com/SynorixCoin)

## Building from Source

```bash
git clone https://github.com/Synorixz/synorix.git
cd synorix
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
```

## Downloading Binaries

Release binaries are built automatically via GitHub Actions (`build-binaries` workflow) on every push to the `main` branch and pull requests.

1. Go to the **Actions** tab on the GitHub repository page.
2. Select the **build-binaries** workflow from the left menu.
3. Click on a completed run (green checkmark). 
4. Download from the **Artifacts** section at the bottom of the page:
   * `linux-binaries` — zip: `synorixd`, `synorix-cli` (Compiled on Ubuntu 24.04 + GCC 13).
   * `windows-binaries` — zip: `synorixd.exe`, `synorix-cli.exe` (Built with Visual Studio 2022 + vcpkg).

*Note: Windows `.exe` files may require the Visual C++ Redistributable package. Artifacts are automatically deleted by GitHub after a certain period; for permanent distribution, check the **Releases** tab.*

## Testnet (Quick Start)

```bash
./synorixd -testnet -daemon
./synorix-cli -testnet getblockchaininfo
```
*Use `-testnet` with the same logic on Windows. Set RPC user/password in `synorix.conf` or via flags (see `doc/` for details).*

## License

Synorix is released under the terms of the MIT license. See `COPYING` for more information or see https://opensource.org/licenses/MIT.
