# UpSync

**Kaydet, yüklensin.** macOS menü çubuğu uygulaması: tanımladığınız klasörleri
izler, kaydedilen dosyayı SFTP veya FTP ile uzak sunucuya yükler. Editörden bağımsız çalışır — Zed, VS Code,
PhpStorm, `vim`, hatta `sed` fark etmez.

## Neden

Zed'in eklenti API'si panel, komut ve dosya izleyici sunmuyor. Mevcut Zed SFTP
eklentisi bunu dil sunucusu (LSP) numarasıyla dolanıyor, ama o zaman yükleme
Zed'in dosyaya hangi dili atadığına bağlı kalıyor. Bu uygulama o bağı tamamen
koparıyor: izleme işletim sistemi seviyesinde.

## Mimari

    ┌─────────────────────────────┐
    │  SwiftUI menü çubuğu (app/) │  MenuBarExtra, etkinlik penceresi,
    │                             │  Keychain, klasör yönetimi
    └───────────┬─────────────────┘
                │ stdin/stdout, satır ayraçlı JSON-RPC
    ┌───────────▼─────────────────┐
    │  Node motoru (engine/)      │  chokidar, ssh2 (SFTP), ftp (FTP/FTPS),
    │  esbuild → tek dosya        │  transfer/sync algoritması, ignore, profiller
    └─────────────────────────────┘

Motor, [vscode-sftp](https://github.com/Natizyskunk/vscode-sftp)'nin transfer
çekirdeğinden portlandı: `core/fs`, `core/remote-client`, `scheduler`,
`transferTask`, `ignore`, `fileService` ve `fileHandlers/transfer`. vscode'a
bağımlı olan her şey `src/shims/` altındaki karşılıklarıyla değiştirildi.

Swift tarafı motoru çocuk süreç olarak başlatır ve süreç ölürse üstel geri
çekilmeyle yeniden başlatır.

## Kurulum

Gereksinim: Node.js 18+ (motor için), Xcode 15+ / Swift 6 (derlemek için).

    ./build.sh

`build/UpSync.app` üretilir. Applications klasörüne kopyalayabilirsiniz.

Uygulama sistemdeki Node'u arar: paket içi → `/opt/homebrew/bin` →
`/usr/local/bin` → `/usr/bin` → giriş kabuğunun PATH'i (nvm, Herd vb. için).

## Config

Klasör eklediğinizde şu sırayla aranır:

1. `.zed/sftp.json`
2. `.vscode/sftp.json`
3. `sftp.json`

Format vscode-sftp ile birebir aynı — mevcut dosyalarınız değişiklik
gerektirmez. Yorum ve sondaki virgül (JSONC) desteklenir.

```jsonc
{
  "name": "Production",
  "host": "example.com",
  "protocol": "sftp",          // "sftp" | "ftp"
  "port": 22,
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_rsa",
  "remotePath": "/var/www/site",
  "context": "src",            // sadece bu alt klasör senkronlanır
  "uploadOnSave": true,
  "ignore": ["**/node_modules/**", "**/.git/**", "*.log"],
  "watcher": {
    "autoUpload": true,        // uploadOnSave ile eşdeğer
    "autoDelete": false        // lokalde silineni uzakta da sil
  },
  "syncOption": {
    "delete": false,
    "skipCreate": false,
    "ignoreExisting": false,
    "update": false
  },
  "profiles": {
    "staging": { "host": "staging.example.com", "remotePath": "/var/www/staging" }
  }
}
```

### Ignore kuralları

`ignore` listesi **gitignore semantiğiyle** değerlendirilir (`ignore` npm
paketi), glob ile değil. Pratik sonuçları:

- `CLAUDE.md` gibi çıplak isimler **her dizin seviyesinde** eşleşir.
- `crns/tests/**` gibi yol içeren kalıplar **yalnızca kökten** eşleşir.
- `**/cache/**` klasörün *içeriğini* yok sayar, klasörün kendisini değil.
  İzleyici o dizini bir kez açar ama içine inmez — maliyeti tek bir `readdir`.
  Daha sıkı isterseniz `**/cache` kalıbını da ekleyin.

`watcher.files` alanı bu uygulamada kullanılmaz; izleyici her zaman klasörün
tamamını kapsar ve eleme `ignore` ile yapılır. `watcher.ignore` diye bir alan
ne burada ne vscode-sftp'de tanımlıdır — yazarsanız sessizce yok sayılır,
kuralları üst seviye `ignore` içine koyun.

### uploadOnSave ve watcher.autoUpload

vscode-sftp'de `uploadOnSave` editör kaydını, `watcher.autoUpload` dışarıdan
gelen dosya değişikliğini ifade eder. Bu uygulamanın tek bir izleyicisi var,
bu yüzden **ikisinden biri açıksa** klasör izlenir. Sadece `"uploadOnSave": true`
yazan mevcut config'ler ek ayar gerektirmeden çalışır.

### Şifreler

`"password": true` yazın — şifre config dosyasında tutulmaz. Uygulama ilk
bağlantıda sorar, "Keychain'e kaydet" işaretliyse saklar ve sonraki
bağlantılarda hiç sormaz. Menüdeki **Kayıtlı Şifreyi Unut** ile silinir.
Keychain kaydı `kullanici@host:port` anahtarıyla tutulur.

En iyisi yine de `privateKeyPath` ile anahtar kullanmaktır.

## Özellikler

- Kaydedince otomatik yükleme (dosya türü fark etmez)
- Manuel yükleme / indirme / klasör senkronu
- Çift yönlü senkron, `delete` / `skipCreate` / `ignoreExisting` / `update`
- `autoDelete`: lokalde silineni uzakta da sil
- Çoklu profil (staging / production), klasör başına ayrı seçim
- SFTP ve FTP/FTPS
- `"password": true` ile Keychain'de saklanan şifreler
- ssh-config okuma, agent auth, jump host — motordan devralındı, bu projede
  ayrıca test edilmedi
- gitignore uyumlu ignore kalıpları, `ignoreFile` desteği
- Etkinlik penceresi: her yükleme, atlama ve hata görünür

## Geliştirme

    cd engine && npm install && npm run build && npm test
    cd app && swift build

Testler `test/sftp-server.mjs` (ssh2 tabanlı) ve `ftp-srv` ile localhost'ta
tek kullanımlık sunucular ayağa kaldırır; hiçbir gerçek sunucuya bağlanmaz.

## Portlama sırasında düzeltilen upstream hataları

Aşağıdaki iki hata vscode-sftp'den devralındı ve burada düzeltildi:

1. `sshClient.ts` — `.on('close', this.end())`: listener yerine dönüş değeri
   (`undefined`) kaydediliyor ve `end()` bağlantı kurulurken hemen çağrılıyordu.
   Node 22 `undefined` listener'ı reddettiği için bağlantı hiç kurulamıyor.
2. `transfer.ts` — sync'in silme işlemleri (`fileMissed` / `dirMissed`)
   `forEach` içinde await edilmeden çağrılıyordu; `sync()` silmeler bitmeden
   dönüyor ve silme hataları sessizce yutuluyordu.

## Doğrulama durumu

**Uçtan uca test edildi** (`engine/test`, 62 test): SFTP ve FTP üzerinden
kaydedince yükleme, manuel upload/download, klasör senkronu, `delete` seçeneği,
`autoDelete`, ignore kalıpları, `"password": true` akışı ve hesap kimliği,
yanlış şifrede sessiz başarısızlık olmaması. Ayrıca derlenmiş `.app` gerçekten
başlatılıp yerel test sunucusuna dosya yüklediği doğrulandı.

`test/ignore.test.mjs` gerçek bir projenin 44 kurallık ignore listesini birebir
alıp 42 ayrı yol üzerinde doğruluyor: dizin kalıpları (`**/node_modules/**`),
derinlemesine dosya kalıpları (`**/*.log`), göreli tam yollar
(`includes/env.local.php`), çıplak isimler (`CLAUDE.md` — gitignore
semantiğinde her seviyede eşleşir) ve joker (`docker-compose.*.yml`).
Aynı kontrol hem kaydedince yükleme hem manuel klasör yüklemesi için yapılıyor.

**Devralındı, ayrıca test edilmedi**: ssh-config okuma, agent auth, jump host
(`hop`), `useTempFile`. Bunlar vscode-sftp'de çalışan kod; port sırasında
davranışları değiştirilmedi ama burada test kapsamına girmedi.

**Test edilmedi**: arayüzün kendisi — menü etkileşimleri, klasör ekleme paneli,
etkinlik penceresi, şifre diyaloğu. Doğrulama `folders.json` önceden
doldurularak başsız yapıldı.

## Dosya izleme ve fd limiti

macOS'ta izleme **FSEvents** üzerinden yapılır (chokidar 3 + `fsevents`).
Tüm ağaç için tek bir akış açılır; dizin ya da dosya başına tanıtıcı
harcanmaz.

Bu önemli, çünkü:

- **chokidar 4 macOS FSEvents desteğini kaldırdı** ve dosya başına `fs.watch`
  açıyor. Bir projede on binlerce tanıtıcı gerekebiliyor.
- **`open` ile başlatılan uygulamalar launchd'den 256'lık soft fd limiti
  devralır** (`launchctl limit maxfiles`). Kabuktan çalıştırırken limit çok
  yüksek olduğu için sorun geliştirmede görünmez, sadece paketlenmiş
  uygulamada patlar.

İkisi birleşince `EMFILE: too many open files` alınıyor — ve tanıtıcılar
tükendiği için SSH özel anahtarı bile açılamıyor, yani yükleme de çöküyor.

Çift önlem alındı: FSEvents'e geçildi **ve** Swift tarafı motoru başlatmadan
önce `RLIMIT_NOFILE` soft limitini `kern.maxfilesperproc` (61440) değerine
çekiyor; çocuk süreç bunu miras alıyor.

Ölçüm — 1603 dizin / 8000 dosyalık ağaçta, paketlenmiş `.app` ile:

| | önce (chokidar 4) | sonra (FSEvents) |
|---|---|---|
| açık fd | 15.000+ gerekiyordu → EMFILE | **44** |
| bellek (RSS) | ~212 MB | **86 MB** |

`test/fdlimit.test.mjs` bunu regresyona karşı korur: motoru bilerek 256 fd
limitiyle başlatıp 800+ dizinlik ağaçta yükleme yapıldığını doğrular.

### Gelecek iyileştirme

İzleme Swift tarafına, doğrudan FSEvents API'sine taşınabilir; o zaman
`fsevents` native modülünü paketle taşımaya gerek kalmaz. Ancak FSEvents
yazma *başlarken* tetiklenir; chokidar'ın `awaitWriteFinish` davranışının
(yarım yazılmış dosyayı yüklememe) yeniden yazılması gerekir. Şimdilik
yapılmadı.

## Bilinen sınırlar

- Node.js sistemde kurulu olmalı; şu an paket içine gömülmüyor (Node ikilisi
  ~110MB, .app boyutunu Electron seviyesine çıkarır).
- Uygulama imzalanmamış (ad-hoc). Gatekeeper ilk açılışta uyarabilir.
- Girişte otomatik başlatma henüz yok — Sistem Ayarları > Giriş Öğeleri'nden
  elle eklenebilir.

## Sürüm yayınlama

Sürüm numarasının tek kaynağı `VERSION` dosyasıdır; `build.sh` onu okur ve
`Info.plist`'e yazar.

    ./release.sh 0.2.0

Script sırayla: testleri koşar, sürümü yazıp commit eder, `.app`'i derler,
paketteki sürümü doğrular, `ditto` ile zip'ler (imzayı bozmadan), `vX.Y.Z`
etiketi atar, main ve etiketi push eder, GitHub Releases'e kurulum notlarıyla
birlikte yükler.

Ön koşul olarak çalışma dizininin temiz olmasını ve `gh` oturumunu şart koşar;
etiket zaten varsa durur.

## Lisans

MIT. Bkz. [LICENSE](LICENSE).

Transfer motoru [vscode-sftp](https://github.com/Natizyskunk/vscode-sftp)'den
(MIT, Natizyskunk; özgün hali liximomo) türetilmiştir. Port sırasında bulunan
iki hata yukarıda listelenmiştir.
