#!/bin/bash
# UpSync.icns üretir. İkon programatik çizildiği için tüm boyutlar
# tek kaynaktan, yeniden üretilebilir şekilde çıkar.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SET="$DIR/UpSync.iconset"
rm -rf "$SET" && mkdir -p "$SET"

render() { swift "$DIR/render.swift" a "$SET/$2" "$1"; }

render 16   icon_16x16.png
render 32   icon_16x16@2x.png
render 32   icon_32x32.png
render 64   icon_32x32@2x.png
render 128  icon_128x128.png
render 256  icon_128x128@2x.png
render 256  icon_256x256.png
render 512  icon_256x256@2x.png
render 512  icon_512x512.png
render 1024 icon_512x512@2x.png

iconutil -c icns "$SET" -o "$DIR/UpSync.icns"
rm -rf "$SET"
echo "==> $DIR/UpSync.icns"
