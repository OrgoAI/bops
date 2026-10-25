#!/usr/bin/env bash
# Fetches the ingot command for the bots' computers (Linux, amd64 and arm64), which a bot works on an
# app's Ingot repo with (lib/server/ingot.ts copies the one for the computer's arch onto it), checks each
# against the release's SHA256SUMS, and puts them in vendor/ingot/, where the dev server finds them. The
# packaged app bundles this folder and points BOPS_INGOT_DIR at it.
#
# The version is pinned: keep it at what the central Ingot (https://bops.bot/api/ingot) runs. The repo is
# private for now, so this needs `gh` signed in to GitHub with access to orgoai/ingot.
#
# Usage: scripts/fetch-ingot.sh [version]     e.g. scripts/fetch-ingot.sh v0.1.0
set -euo pipefail

version="${1:-${BOPS_INGOT_VERSION:-v0.1.0}}"
assets=(ingot-linux-amd64 ingot-linux-arm64)

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/vendor/ingot"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

gh release download "$version" -R orgoai/ingot -p "${assets[0]}" -p "${assets[1]}" -p SHA256SUMS -D "$tmp"

# Both checked before either is put in place, so vendor/ingot never holds two versions.
for asset in "${assets[@]}"; do
  want="$(awk -v f="$asset" '$2 == f || $2 == "*"f { print $1 }' "$tmp/SHA256SUMS")"
  [ -n "$want" ] || { echo "$asset isn't in the release's SHA256SUMS" >&2; exit 1; }
  got="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
  [ "$want" = "$got" ] || { echo "checksum mismatch for $asset: want $want, got $got" >&2; exit 1; }
done

mkdir -p "$dest"
for asset in "${assets[@]}"; do install -m 0755 "$tmp/$asset" "$dest/$asset"; done
echo "$version" > "$dest/VERSION"
echo "ingot $version -> vendor/ingot/ingot-linux-amd64, ingot-linux-arm64 (checked against SHA256SUMS)"
