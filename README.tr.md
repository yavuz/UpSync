<div align="center">

<img src="docs/icon.png" width="120" alt="UpSync">

# UpSync

**Dosyayı kaydet. Sunucuda.**

Proje klasörlerinizi izleyen, kaydettiğiniz her dosyayı SFTP veya FTP ile uzak
sunucuya yükleyen bir macOS menü çubuğu uygulaması. Editör eklentisi yok,
derleme adımı yok, akılda tutulacak bir şey yok.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/macOS-14%2B-lightgrey.svg)](#gereksinimler)
[![İndir](https://img.shields.io/github/v/release/yavuz/UpSync?label=indir)](https://github.com/yavuz/UpSync/releases/latest)

*[English](README.md) · Türkçe*

<img src="docs/panel.png" width="380" alt="UpSync menü çubuğu paneli">

</div>

---

## Neden

Kaydedince yükleyen araçların çoğu tek bir editörün içinde yaşar. Editör
değiştirince onları kaybedersiniz — ya da daha kötüsü, belirli dosya türleri
için sessizce çalışmayı bırakırlar.

UpSync bunun yerine dosya sistemini izler. Zed'den mi, VS Code'dan mı,
PhpStorm'dan mı, Vim'den mi yoksa bir kabuk betiğinden mi kaydettiğiniz
umurunda değildir. Dosya değiştiyse yukarı gider.

[vscode-sftp](https://github.com/Natizyskunk/vscode-sftp) ile aynı `sftp.json`
formatını okur; mevcut proje config'leriniz değişiklik gerektirmez.

## Kurulum

**Son sürümü indirin** → [Releases](https://github.com/yavuz/UpSync/releases/latest)

1. Zip'i açın, `UpSync.app`'i **Applications** klasörüne sürükleyin
2. İlk açılışta uygulamaya sağ tık → **Aç** (paket ad-hoc imzalı, notarize
   değil), ya da:
   ```bash
   xattr -dr com.apple.quarantine /Applications/UpSync.app
   ```
3. Menü çubuğu ikonuna tıklayın → **Add Folder**

### Gereksinimler

- macOS 14 veya üzeri
- **Node.js 18+** — senkron motoru onun üzerinde çalışır. UpSync Node'u şu
  sırayla arar: paket içi → `/opt/homebrew/bin` → `/usr/local/bin` →
  `/usr/bin` → giriş kabuğunuzun `PATH`'i (nvm, Herd, fnm hepsi çalışır).
  ```bash
  brew install node
  ```

### Kaynaktan derleme

```bash
git clone https://github.com/yavuz/UpSync.git
cd UpSync
./build.sh
```

`build/UpSync.app` üretir. Node'a ek olarak Xcode 15+ / Swift 6 gerekir.

## Hızlı başlangıç

Projenizde `.vscode/sftp.json` (ya da `.zed/sftp.json`, ya da `sftp.json`)
oluşturun:

```jsonc
{
  "host": "example.com",
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_rsa",
  "remotePath": "/var/www/site",
  "uploadOnSave": true,
  "ignore": ["**/node_modules/**", "**/.git/**", "*.log"]
}
```

Klasörü UpSync'e ekleyin, bir dosya kaydedin, etkinlik listesinde belirmesini
izleyin.

## Neler var

<img src="docs/activity.png" width="640" alt="Etkinlik penceresi">

- **Kaydedince yükleme** — her dosya türü, her editör, her uzantı
- **Canlı ilerleme** — büyük klasör senkronlarında kaç dosyanın uçtuğunu görün
- **Hiçbir şey sessizce başarısız olmaz** — her yükleme, atlama ve hata
  görünür; hata metni ve dosya yolu ile birlikte
- **Manuel yükleme / indirme / senkron**, çift yönlü dahil
- **Çoklu profil** — klasör başına staging ve production
- **SFTP ve FTP/FTPS**
- **Şifreler Keychain'de**, config dosyanızda değil
- **gitignore tarzı ignore kalıpları**, ayrıca `ignoreFile` desteği

<img src="docs/settings.png" width="640" alt="Ayarlar penceresi">

## Yapılandırma

UpSync config dosyasını şu sırayla arar:

1. `.zed/sftp.json`
2. `.vscode/sftp.json`
3. `sftp.json`

Yorumlar ve sondaki virgüller (JSONC) desteklenir. Panel hangi dosyayı
yüklediğini gösterir; tahmin etmeye gerek kalmaz.

<details>
<summary><b>Tam config referansı</b></summary>

```jsonc
{
  "name": "Production",
  "host": "example.com",
  "protocol": "sftp",          // "sftp" | "ftp"
  "port": 22,
  "username": "deploy",

  // Birini seçin: anahtar (önerilen), şifre, ya da bir kez sorulup
  // Keychain'de saklanması için "password": true.
  "privateKeyPath": "~/.ssh/id_rsa",
  "passphrase": true,
  "password": true,

  "remotePath": "/var/www/site",
  "context": "src",            // yalnızca bu alt klasörü senkronla

  "uploadOnSave": true,
  "watcher": {
    "autoUpload": true,        // uploadOnSave ile eşdeğer
    "autoDelete": false        // lokalde silineni uzakta da sil
  },

  "ignore": ["**/node_modules/**", "**/.git/**", "*.log"],
  "ignoreFile": ".gitignore",

  "syncOption": {
    "delete": false,           // lokalde olmayan uzak dosyaları sil
    "skipCreate": false,
    "ignoreExisting": false,
    "update": false            // yalnızca daha eskisinin üzerine yaz
  },

  "concurrency": 4,
  "connectTimeout": 10000,
  "useTempFile": false,        // geçici dosyaya yükle, sonra adlandır
  "filePerm": 644,
  "dirPerm": 755,

  "profiles": {
    "staging": {
      "host": "staging.example.com",
      "remotePath": "/var/www/staging"
    }
  }
}
```

ssh-config okuma, agent kimlik doğrulama ve jump host desteği vscode-sftp
motorundan devralındı ve aynı şekilde çalışır.

</details>

### Ignore kuralları

Kalıplar **gitignore semantiğiyle** değerlendirilir, glob ile değil:

- `CLAUDE.md` gibi çıplak isimler **her dizin seviyesinde** eşleşir
- `tests/fixtures/**` gibi yol içeren kalıplar **yalnızca kökten** eşleşir
- `**/cache/**` klasörün *içeriğini* yok sayar, klasörün kendisini değil.
  Tamamen atlanmasını istiyorsanız `**/cache` kalıbını da ekleyin.

### uploadOnSave ve watcher.autoUpload

vscode-sftp bunları ayrı ele alır — biri editör kaydını, diğeri dışarıdan gelen
değişikliği ifade eder. UpSync'in tek izleyicisi var, bu yüzden **ikisinden
biri** açıksa klasör izlenir. Mevcut config'ler değişiklik gerektirmez.

### Şifreler

`"password": true` yazın. UpSync bir kez sorar, Keychain'e `kullanıcı@host:port`
anahtarıyla kaydeder ve bir daha sormaz. **Forget Saved Password** ile silinir.

Yine de SSH anahtarı kullanmak daha iyidir.

## Sorun giderme

<details>
<summary><b>"UpSync açılamıyor çünkü Apple denetleyemedi"</b></summary>

Sürüm ad-hoc imzalı, ücretli Apple Developer hesabıyla notarize edilmedi.
Uygulamaya sağ tık → **Aç**, ya da:

```bash
xattr -dr com.apple.quarantine /Applications/UpSync.app
```
</details>

<details>
<summary><b>"Node.js not found"</b></summary>

Node 18 veya üzerini kurun:

```bash
brew install node
```

nvm ya da Herd kullanıyorsanız UpSync giriş kabuğunuzun `PATH`'ini okur; yeni
bir terminalde `node` komutunun çalıştığından emin olun.
</details>

<details>
<summary><b>Kaydediyorum ama hiçbir şey yüklenmiyor</b></summary>

Paneli açıp klasör kartına bakın:

- Kırmızı nokta ve hata mesajı: config yüklenemedi ya da bağlantı kurulamadı —
  mesaj hangisi olduğunu söyler.
- "uploadOnSave is off in the config": ne `uploadOnSave` ne de
  `watcher.autoUpload` `true`.
- Dosya bir `ignore` kalıbına takılıyor olabilir — etkinlik penceresi
  atlananları da kaydeder.
</details>

<details>
<summary><b>Dosyalarım iki kez yüklendi</b></summary>

Muhtemelen iki UpSync kopyası birden çalışıyordu. İkisini de menü çubuğundan
kapatıp tek kopya açın. (0.2.0'dan itibaren motor ebeveyniyle birlikte
kapandığı için bunun olmaması gerekir.)
</details>

## Kaputun altında

    ┌─────────────────────────────┐
    │  SwiftUI menü çubuğu (app/) │  panel, etkinlik, ayarlar, Keychain
    └───────────┬─────────────────┘
                │ stdio üzerinden satır ayraçlı JSON-RPC
    ┌───────────▼─────────────────┐
    │  Node motoru (engine/)      │  FSEvents izleyici, ssh2 + ftp,
    │  esbuild → tek dosya        │  transfer/sync algoritması, ignore
    └─────────────────────────────┘

Transfer çekirdeği [vscode-sftp](https://github.com/Natizyskunk/vscode-sftp)'den
portlandı; vscode'a bağımlı her şey bir shim ile değiştirildi. Swift uygulaması
motoru denetler ve ölürse üstel geri çekilmeyle yeniden başlatır.

**Port sırasında iki upstream hatası düzeltildi:**

1. `sshClient.ts` listener yerine bir fonksiyonun *dönüş değerini*
   (`undefined`) kaydediyor ve `end()`'i bağlantı kurulurken çağırıyordu.
   Node 22 `undefined` listener'ı reddettiği için bağlantı hiç kurulmuyordu.
2. `transfer.ts` sync silmelerini `forEach` içinde await etmeden tetikliyordu;
   `sync()` erken dönüyor ve silme hataları yutuluyordu.

**Kaydet→sunucu gecikmesi ~150 ms** ve büyük kısmı bilinçli: chokidar dosya
boyutu sabitlenene kadar bekliyor, böylece yarım yazılmış dosya yüklenmiyor.
3 MB'lık dosyayı parça parça yazan bir süreçle ölçüm:

| eşik | gecikme | büyük dosya |
|---|---|---|
| 200 ms (önce) | 316 ms | tam |
| **100 ms (şimdi)** | **117 ms** | tam |
| 50 ms | 102 ms | tam |
| kapalı | 101 ms | **yarım** |

8000 dosyalık ağaçta uçtan uca: izleyici ~300 ms'de hazır, tek kayıt 154 ms'de
sunucuda, 100 dosyalık toplu kayıt 313 ms (320 dosya/sn), motor boşta 38 MB.

**Gerçek sunucu söz konusu olunca CPU değil gidiş-dönüş sayısı belirleyici.**
Bir yükleme 6 SFTP protokol çağrısı; her biri bir gidiş-dönüş. İzin ve zaman
damgası eskiden iki ayrı `FSETSTAT` paketiydi, artık tek pakette birleşiyor —
dosya başına tam bir gidiş-dönüş eksiliyor. 40 ms yapay gecikmeli test
sunucusuna karşı, protokol yolu izole edilerek ölçüldü (n=20):

| | medyan |
|---|---|
| ayrı (7 çağrı) | 255.7 ms |
| **birleşik (6 çağrı)** | **213.6 ms** |

**Dosya izleme** FSEvents ile yapılır (chokidar 3 + `fsevents`) — tüm ağaç için
tek akış. chokidar 4 macOS'ta FSEvents desteğini kaldırıp dosya başına
`fs.watch`'a düşüyor; launchd'nin GUI uygulamalarına verdiği 256 tanıtıcı
limitiyle birleşince gerçek projelerde `EMFILE` hatası veriyordu. 1603 dizinlik
bir ağaçta ölçüm: **44 açık tanıtıcı, 86 MB RSS**.

**Test**: 68 uçtan uca test — SFTP ve FTP yükleme/indirme/senkron, ignore
kuralları, Keychain şifre akışı, dosya başına ilerleme olayları, düşük tanıtıcı
limiti ve yetim süreç kapanışı. Testler localhost'ta tek kullanımlık ssh2 ve
`ftp-srv` sunucuları kaldırır; hiçbir gerçek sunucuya bağlanılmaz.

```bash
cd engine && npm install && npm test
```

## Sürüm yayınlama

`VERSION` tek doğruluk kaynağıdır.

```bash
./release.sh 0.2.0
```

Testleri koşar, derler, paketteki sürümü doğrular, `ditto` ile zipler (imzayı
koruyarak), etiketler, push eder ve GitHub Releases'e yayınlar.

## Uygulama ikonu

`icon/render.swift` içinde programatik çiziliyor — binary varlık yok, tüm
boyutlar `./icon/make-icns.sh` ile tek kaynaktan üretiliyor.

Sanat bilerek kenardan kenara. macOS 26 eski usul `.icns` ikonlarını kendi
standart karesine oturtuyor; kendi yuvarlatılmış karemizi çizmek çift çerçeve
üretiyordu. macOS 15 ve öncesinde bunun bedeli köşelerin yuvarlanmaması;
kalıcı çözüm bir Icon Composer `.icon` varlığı da eklemek.

## Lisans

MIT — bkz. [LICENSE](LICENSE).

Transfer motoru [vscode-sftp](https://github.com/Natizyskunk/vscode-sftp)'den
türetilmiştir (MIT, Natizyskunk; özgün hali liximomo).
