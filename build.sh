#!/bin/bash
# UpSync'i derleyip UpSync.app paketini üretir.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${1:-release}"
APP_NAME="UpSync"
BUILD_DIR="$ROOT/build"
APP="$BUILD_DIR/$APP_NAME.app"

echo "==> Motor derleniyor"
cd "$ROOT/engine"
if [ ! -d node_modules ]; then
  npm ci 2>/dev/null || npm install
fi
npm run build

echo "==> Swift uygulaması derleniyor ($CONFIG)"
cd "$ROOT/app"
swift build -c "$CONFIG"
BINARY="$(swift build -c "$CONFIG" --show-bin-path)/$APP_NAME"

echo "==> .app paketi hazırlanıyor"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/engine"

cp "$BINARY" "$APP/Contents/MacOS/$APP_NAME"
cp "$ROOT/engine/dist/engine.js" "$APP/Contents/Resources/engine/engine.js"

# fsevents native modül olduğu için bundle'a giremez, yanında taşınmalı.
# Onsuz chokidar dosya başına fs.watch açar ve uygulama launchd'den devraldığı
# 256 fd limitinde EMFILE alır.
FSEVENTS="$ROOT/engine/node_modules/fsevents"
if [ ! -f "$FSEVENTS/fsevents.node" ]; then
  echo "HATA: fsevents bulunamadı ($FSEVENTS)." >&2
  echo "      'npm i fsevents@2.3.3 --ignore-scripts' ile kurun." >&2
  exit 1
fi
mkdir -p "$APP/Contents/Resources/engine/node_modules"
cp -R "$FSEVENTS" "$APP/Contents/Resources/engine/node_modules/fsevents"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>UpSync</string>
  <key>CFBundleDisplayName</key><string>UpSync</string>
  <key>CFBundleIdentifier</key><string>dev.upsync.app</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- Menü çubuğu ajanı: Dock'ta görünmez, açılışta pencere açmaz. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# İmzasız çalıştırmada Keychain erişimi için ad-hoc imza yeterli.
codesign --force --deep --sign - "$APP" 2>/dev/null || \
  echo "    (codesign atlandı)"

echo "==> Hazır: $APP"
