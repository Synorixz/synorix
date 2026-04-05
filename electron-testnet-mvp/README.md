# Synorix Testnet — Electron MVP

Terminal kullanmadan **testnet düğümü**, **cüzdan** ve **`generatetoaddress` ile mining** denemek için basit bir masaüstü kabuğu.

## Gereksinimler

- **Node.js** 18+ (LTS önerilir)
- Kullanıcı makinesinde **cüzdanlı** derlenmiş `synorixd` ve `synorix-cli` (aynı sürüm)
- Synorix **testnet** parametreleri (SNRX test ağı)

## Kurulum

```bash
cd electron-testnet-mvp
npm install
npm start
```

## Binary arama sırası

1. `electron-testnet-mvp/../build/bin`
2. `../../build/bin`
3. Kullanıcının **build/bin klasörünü seç** ile kaydettiği yol (`synorixBinDir`)
4. Uygulama yanı, paket `bin` vb.

**İsimler:** Linux/WSL’de **uzantısız** `synorixd` / `synorix-cli`. Windows’ta arama önce **`synorixd.exe`** / **`synorix-cli.exe`** (Electron `spawn` uzantısız yolu çoğu zaman bulamaz); yoksa uzantısız denenir.

## Kullanım (yol seçmeden)

1. Mümkünse Synorix’i derleyip `build/bin` yolunu uygulamanın görebileceği bir yerde tut veya **build/bin klasörünü seç** ile göster.
2. Aynı klasörde **synorixd** + **synorix-cli** (veya Windows’ta `.exe`) olsun.
2. Uygulamayı aç — programlar **otomatik tespit edilir** (yeşil “Hazır”).
3. **Testnet node’u başlat** — veri dizini otomatik oluşturulur:  
   **`~/SynorixTestnetData`** (Windows: `C:\Users\<kullanıcı>\SynorixTestnetData`).  
   Testnet blokları bu klasörün altında (`testnet3` vb.) tutulur.
4. **Cüzdan oluştur** → **Yeni adres al** → isteğe bağlı **Mining**.

**Paketlenmiş dağıtım örneği** (Windows):

```text
SynorixTestnet/
  Synorix Testnet.exe
  synorixd.exe
  synorix-cli.exe
```

## Gelişmiş

Programlar başka yerdeyse **Gelişmiş → elle seç** ile yolu kaydedebilirsin.

## Notlar

- **Windows:** düğüm arka planda `spawn` ile açılır (`-daemon` kullanılmaz).
- **Linux/macOS:** `-daemon` ile başlatılır.
- **RPC** sadece yerel; uygulama dış ağa RPC açmaz.
- `generatetoaddress` düğümde cüzdan ve mining RPC’lerinin açık olmasına bağlıdır; hata alırsanız `synorixd` cüzdanlı derleme ve `synorix-cli` çıktısını kontrol edin.
- İlk MVP: üretim ortamı veya ana ağ için uygun değildir.

## Sonraki adımlar (fikir)

- İmzalı binary indirme / sürüm kontrolü
- `electron-builder` ile kurulum paketi
- Log görüntüleme (`debug.log`)
- Regtest modu seçeneği
