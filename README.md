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
```

### Binary'leri İndirme

Her `main` dalına yapılan **push** ve açılan **pull request**’lerde GitHub Actions (**build-binaries** workflow’u) başsız (GUI kapalı) **Release** ikililerini üretir.

1. GitHub’da repo sayfasında **Actions** sekmesine gidin.
2. Sol listeden **build-binaries** iş akışını seçin.
3. Tamamlanmış bir koşuya tıklayın (yeşil tik). Sarı/turuncu = hâlâ derleniyor; Windows ilk seferde **vcpkg** yüzünden **1–3 saat** sürebilir.
4. Sayfanın altındaki **Artifacts** bölümünden indirin:
   - **linux-binaries** — zip: `synorixd`, `synorix-cli` (Linux x86_64; CI’da Ubuntu 24.04 + GCC 13 ile derlenir).
   - **windows-binaries** — zip: `synorixd.exe`, `synorix-cli.exe` (GitHub runner’da **Visual Studio 2022** + vcpkg; yerelde VS 2026 kullanıyorsanız sürüm farkı normaldir).

**Not:** `.exe` dosyaları genelde **Visual C++ yeniden dağıtılabilir** paketine ihtiyaç duyar.

Artifact’ler belirli bir süre sonra GitHub tarafından otomatik silinir; kalıcı dağıtım için **Releases** veya kendi sunucunuza kopyalayın.

### Testnet (kısa)

```bash
./synorixd -testnet -daemon
./synorix-cli -testnet getblockchaininfo
```

Windows’ta aynı mantıkla `-testnet` kullanın; `synorix.conf` veya ek bayraklarla RPC kullanıcı/parola ayarlayın (bkz. `doc/` ve Electron MVP README).

### License

MIT License — see COPYING file for details.
