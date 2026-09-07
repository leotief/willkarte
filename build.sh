#!/usr/bin/env bash
# Packages both browser builds from src/:
#   - willkarte-chromium.zip  (Chrome/Edge/Brave, MV3 — manifest.json as-is)
#   - willkarte-firefox.xpi   (Firefox, MV2 — manifest.firefox.json swapped in as manifest.json)
#
# src/ is the single source. Chrome/Edge/Brave can also load it
# directly (manifest.json is the MV3 manifest); Firefox needs the MV2 manifest,
# so there we swap manifest.firefox.json in as manifest.json before zipping.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- Chrome/Edge/Brave (MV3) --------------------------------------------------
cp -r "$root/src" "$work/chromium"
rm -f "$work/chromium/manifest.firefox.json" # MV2 manifest not shipped in the Chrome build

rm -f "$root/willkarte-chromium.zip"
( cd "$work/chromium" && zip -qr -X "$root/willkarte-chromium.zip" . -x '.*' )
echo "Built willkarte-chromium.zip"

# --- Firefox (MV2) ------------------------------------------------------------
cp -r "$root/src" "$work/firefox"
mv -f "$work/firefox/manifest.firefox.json" "$work/firefox/manifest.json" # MV2 → manifest.json

rm -f "$root/willkarte-firefox.xpi"
( cd "$work/firefox" && zip -qr -X "$root/willkarte-firefox.xpi" . -x '.*' )
echo "Built willkarte-firefox.xpi"
