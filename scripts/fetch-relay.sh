#!/usr/bin/env bash
# Fetches the relay agent (orgo-relay) that routes the bots' computers through this Mac
# (lib/server/relay.ts), checks it against the release's SHA256SUMS, and puts it at
# vendor/orgo-relay/orgo-relay, where the dev server finds it. The packaged app bundles this copy
# and points BOPS_RELAY_BIN at it.
#
# The version is pinned: keep it at what Orgo's ORGO_RELAY_VERSION expects (orgo-web
# envs/<env>/web-public.env). The repo is private for now, so this needs `gh` signed in to GitHub
# with access to orgoai/orgo-relay.
#
# Usage: scripts/fetch-relay.sh [version] [arch]     e.g. scripts/fetch-relay.sh v0.0.3 arm64
set -euo pipefail

version="${1:-${BOPS_RELAY_VERSION:-v0.0.3}}"
arch="${2:-$(uname -m)}"
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac
asset="orgo-relay-darwin-$arch"

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/vendor/orgo-relay"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

gh release download "$version" -R orgoai/orgo-relay -p "$asset" -p SHA256SUMS -D "$tmp"

want="$(awk -v f="$asset" '$2 == f || $2 == "*"f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$want" ] || { echo "$asset isn't in the release's SHA256SUMS" >&2; exit 1; }
got="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
[ "$want" = "$got" ] || { echo "checksum mismatch for $asset: want $want, got $got" >&2; exit 1; }

mkdir -p "$dest"
install -m 0755 "$tmp/$asset" "$dest/orgo-relay"
echo "$version" > "$dest/VERSION"
echo "orgo-relay $version ($arch) -> vendor/orgo-relay/orgo-relay (sha256 $got)"
