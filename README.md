# Synorix (SNRX)

**A faster, more usable evolution of Bitcoin with a sustainable Value Distribution Layer.**

Synorix is a progressive Bitcoin fork designed to solve the practical limitations of legacy blockchains—slow confirmation times and network congestion—while introducing a self-sustaining ecosystem funded by an automated, on-chain Treasury.

## Key Features

* **Block Time:** 2.5 minutes (4x faster than Bitcoin for rapid transactions)
* **Block Size:** 8 MB (Significantly higher transaction capacity/throughput)
* **Supply:** 21,000,000 SNRX (Hard-capped, identical to Bitcoin)
* **Halving:** Every 840,000 blocks (Maintains the ~4-year cycle)
* **Consensus:** SHA-256 Proof-of-Work
* **Fair Launch:** 0% Premine, No ICO, No Team Allocation. 100% publicly mined.
* **On-Chain Treasury:** A predefined portion of network value is routed to a transparent Treasury to fund liquidity, token burns, and ecosystem growth.
* **Dynamic Difficulty Adjustment (DDA):** Ensures stable 2.5-minute block generation regardless of network hashrate fluctuations.

## Links

* **Website:** [https://synorixcoin.com](https://synorixcoin.com) *(coming soon)*
* **Whitepaper:** [Synorix Whitepaper](./WHITEPAPER.md)
* **Explorer:** *(coming soon)*
* **X (Twitter):** [@SynorixCoin](https://twitter.com/SynorixCoin)

## Building from Source

```bash
git clone [https://github.com/Synorixz/synorix.git](https://github.com/Synorixz/synorix.git)
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
