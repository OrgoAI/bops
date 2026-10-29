#!/bin/bash
# Builds a partner's app from this repo: the same Bops under the partner's name, look and identity
# (lib/brand.ts for the app, desktop/brand.cjs for its window). It's a separate app on the Mac: its own
# name and bundle id, icon, data folder, bots' workspace (~/.bops-<brand>) and port, so it runs beside
# Bops, and it never updates itself from Bops' releases.
# Usage: scripts/brand.sh <brand> [extra electron-builder args, e.g. --dir]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

brand="${1:?Name a brand: momentum}"
shift
case "$brand" in
  momentum)
    name="Momentum AMP"
    app_id="ai.orgo.momentum-amp"
    port=3220
    ;;
  *)
    echo "No brand \"$brand\" (lib/brand.ts)." >&2
    exit 1
    ;;
esac
dir="desktop/brands/$brand"
[ -f "$dir/icon.icns" ] || { echo "Missing $dir/icon.icns." >&2; exit 1; }

# For this build only: desktop/brand.json goes into the app, and is gone again after.
printf '{"id":"%s","name":"%s","port":%s,"updates":false}\n' "$brand" "$name" "$port" > desktop/brand.json
trap 'rm -f desktop/brand.json' EXIT

export NEXT_PUBLIC_BOPS_BRAND="$brand" BOPS_APP_NAME="$name"
scripts/release.sh \
  -c.productName="$name" \
  -c.appId="$app_id" \
  -c.mac.icon="$dir/icon.icns" \
  -c.mac.extendInfo.NSMicrophoneUsageDescription="$name uses your microphone when you call one of your bots." \
  "$@"
