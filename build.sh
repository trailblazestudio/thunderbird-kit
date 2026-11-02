#!/bin/bash
# Builds the add-ons into dist/. Tracking is only built when addons/tracking/config.js exists.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist

(cd addons/preview && zip -q -r ../../dist/preview-for-thunderbird.xpi manifest.json schema.json api.js)
echo "Built dist/preview-for-thunderbird.xpi"

CFG=addons/tracking/config.js
if [ ! -f "$CFG" ]; then
  echo "Skipping tracking (no $CFG – see README)."
  exit 0
fi

URL=$(node -e "$(cat "$CFG"); console.log(TRACK_CONFIG.url.replace(/\/+$/, ''))")
if ! [[ "$URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "Error: url in $CFG must be https://<host> without a path, got: $URL" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp -r addons/tracking/. "$TMP/"
sed -i "s#__TRACKING_URL__#$URL#g" "$TMP/manifest.json" "$TMP/api.js"
(umask 077; cd "$TMP" && zip -q -r "$OLDPWD/dist/tracking-for-thunderbird.xpi" manifest.json schema.json api.js background.js config.js icons)
echo "Built dist/tracking-for-thunderbird.xpi (contains your API key – keep it private)"
