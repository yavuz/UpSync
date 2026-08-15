#!/bin/bash
# UpSync sürüm yayınlar: sürümü yükseltir, test eder, derler, paketler,
# etiketler ve GitHub Releases'e yükler.
#
#   ./release.sh 0.2.0
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Kullanım: ./release.sh <sürüm>   (örn. 0.2.0)" >&2
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "HATA: sürüm X.Y.Z biçiminde olmalı (verilen: $VERSION)" >&2
  exit 1
fi

TAG="v$VERSION"

# --- Ön koşullar -----------------------------------------------------------

command -v gh >/dev/null || { echo "HATA: gh CLI kurulu değil." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "HATA: gh oturumu yok ('gh auth login')." >&2; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  echo "HATA: çalışma dizini temiz değil. Önce commit edin:" >&2
  git status --short >&2
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "HATA: $TAG etiketi zaten var." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "UYARI: main dalında değilsiniz ($BRANCH)."
  read -r -p "Devam edilsin mi? [e/H] " answer
  [ "$answer" = "e" ] || exit 1
fi

# --- Testler ---------------------------------------------------------------

echo "==> Testler"
(cd engine && npm test)

# --- Sürümü yaz ve derle ---------------------------------------------------

echo "==> Sürüm $VERSION"
echo "$VERSION" > VERSION
git add VERSION
git commit -q -m "Sürüm $VERSION"

./build.sh release

# Info.plist gerçekten istenen sürümü taşıyor mu.
BUILT="$(plutil -extract CFBundleShortVersionString raw "build/UpSync.app/Contents/Info.plist")"
if [ "$BUILT" != "$VERSION" ]; then
  echo "HATA: paketteki sürüm ($BUILT) beklenenle ($VERSION) uyuşmuyor." >&2
  exit 1
fi

# --- Paketle ---------------------------------------------------------------

echo "==> Paketleniyor"
ZIP="$ROOT/build/UpSync-$VERSION.zip"
rm -f "$ZIP"
# ditto: imzayı ve paket yapısını bozmadan sıkıştırır. 'zip' bunu yapamaz.
ditto -c -k --keepParent "build/UpSync.app" "$ZIP"

# --- Etiketle ve yayınla ---------------------------------------------------

echo "==> Etiket $TAG"
git tag -a "$TAG" -m "UpSync $VERSION"
git push origin main
git push origin "$TAG"

NOTES="$(mktemp)"
cat > "$NOTES" <<NOTE
## Kurulum

1. \`UpSync-$VERSION.zip\` dosyasını indirin ve açın
2. \`UpSync.app\`'i **Applications** klasörüne taşıyın
3. İlk açılışta macOS uyarabilir (uygulama ad-hoc imzalı, Apple Developer
   sertifikasıyla notarize edilmemiş). Sağ tık → **Aç** deyin, ya da:

   \`\`\`bash
   xattr -dr com.apple.quarantine /Applications/UpSync.app
   \`\`\`

## Gereksinim

Node.js 18+ sistemde kurulu olmalı. UpSync onu şu sırayla arar:
paket içi → \`/opt/homebrew/bin\` → \`/usr/local/bin\` → \`/usr/bin\` →
giriş kabuğunun PATH'i (nvm, Herd vb.).
NOTE

echo "==> GitHub Releases"
gh release create "$TAG" "$ZIP" \
  --title "UpSync $VERSION" \
  --notes-file "$NOTES" \
  --verify-tag
rm -f "$NOTES"

echo "==> Yayınlandı: $(gh release view "$TAG" --json url --jq .url)"
