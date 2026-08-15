#!/bin/bash
# Publishes an UpSync release: bumps the version, tests, builds, packages,
# tags, and uploads to GitHub Releases.
#
#   ./release.sh 0.2.0
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: ./release.sh <version>   (e.g. 0.2.0)" >&2
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: version must look like X.Y.Z (got: $VERSION)" >&2
  exit 1
fi

TAG="v$VERSION"

# --- Preconditions ---------------------------------------------------------

command -v gh >/dev/null || { echo "ERROR: gh CLI is not installed." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: not logged in to gh ('gh auth login')." >&2; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is not clean. Commit first:" >&2
  git status --short >&2
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "ERROR: tag $TAG already exists." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "WARNING: you are not on main (current: $BRANCH)."
  read -r -p "Continue? [y/N] " answer
  [ "$answer" = "y" ] || exit 1
fi

# --- Tests -----------------------------------------------------------------

echo "==> Tests"
(cd engine && npm test)

# --- Write version and build -----------------------------------------------

echo "==> Version $VERSION"
echo "$VERSION" > VERSION
git add VERSION
git commit -q -m "Release $VERSION"

./build.sh release

# Make sure the bundle really carries the version we asked for.
BUILT="$(plutil -extract CFBundleShortVersionString raw "build/UpSync.app/Contents/Info.plist")"
if [ "$BUILT" != "$VERSION" ]; then
  echo "ERROR: bundle version ($BUILT) does not match expected ($VERSION)." >&2
  exit 1
fi

# --- Package ---------------------------------------------------------------

echo "==> Packaging"
ZIP="$ROOT/build/UpSync-$VERSION.zip"
rm -f "$ZIP"
# ditto preserves the code signature and bundle structure; plain `zip` does not.
ditto -c -k --keepParent "build/UpSync.app" "$ZIP"

# --- Tag and publish -------------------------------------------------------

echo "==> Tagging $TAG"
git tag -a "$TAG" -m "UpSync $VERSION"
git push origin main
git push origin "$TAG"

NOTES="$(mktemp)"
cat > "$NOTES" <<NOTE
## Install

1. Download and unzip \`UpSync-$VERSION.zip\`
2. Move \`UpSync.app\` to your **Applications** folder
3. macOS may warn on first launch — the app is ad-hoc signed, not notarized
   with an Apple Developer certificate. Right-click → **Open**, or run:

   \`\`\`bash
   xattr -dr com.apple.quarantine /Applications/UpSync.app
   \`\`\`

## Requirements

Node.js 18+ must be installed. UpSync looks for it in this order:
bundled → \`/opt/homebrew/bin\` → \`/usr/local/bin\` → \`/usr/bin\` →
your login shell's PATH (nvm, Herd, etc.).
NOTE

echo "==> Publishing to GitHub Releases"
gh release create "$TAG" "$ZIP" \
  --title "UpSync $VERSION" \
  --notes-file "$NOTES" \
  --verify-tag
rm -f "$NOTES"

echo "==> Published: $(gh release view "$TAG" --json url --jq .url)"
