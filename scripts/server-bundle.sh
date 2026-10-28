#!/usr/bin/env bash
# Builds Bops' production server (Next standalone) the way a release ships it, and packs it for the
# bots' computers: dist-runner/bops-server-<version>-<BUILD_ID>.tgz and its .sha256. The Mac app sets a
# computer's Bops runner up from that file (lib/server/runner-install.ts, docs/cloud-runner.md), so it is
# what a release builds, stripped and checked the same way: never the dev tree, never a running server's
# folder. scripts/release.sh runs this, and the app ships the file in its Resources (package.json).
#
# BOPS_SERVER_BUILT=1: .next/standalone is built already (by this script, just now); only strip, check
# and pack it.
#
# Usage: scripts/server-bundle.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# 1. The server. Keys stay out of the app: .env files are never bundled. A release has no brains
# (lib/types.ts BRAINS_ON): set here, so a .env file that turns them on for development can't, and
# built into the server and the window alike, so nothing at run time can either.
if [ -z "${BOPS_SERVER_BUILT:-}" ]; then
  NEXT_PUBLIC_BOPS_BRAINS=0 npx next build
fi
rm -f .next/standalone/.env*
rm -rf .next/standalone/.data
[ -f .next/standalone/server.js ] || { echo "No .next/standalone/server.js: is output \"standalone\" set in next.config.ts?" >&2; exit 1; }
# Only the built server ships: the compiled .next, its node_modules, public, server.js and the files
# it reads at run time (vm/, cloud/, slack/). A file read through process.cwd() with a name known only
# at run time makes the build's tracer copy parts of the project too (it once took .git, envs/,
# docs/internal and scripts/), and the source is compiled into .next anyway, so anything else at the
# top of the standalone folder is removed here, by name, before the app is built from it.
for f in .next/standalone/* .next/standalone/.[!.]*; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in
    .next | cloud | LICENSE | node_modules | package.json | public | server.js | slack | vm) ;;
    *) echo "Not shipping $(basename "$f") (traced from the project, not part of the server)."; rm -rf "$f" ;;
  esac
done
for f in .git .github envs docs scripts .sops.yaml .data; do
  [ ! -e ".next/standalone/$f" ] || { echo ".next/standalone/$f is still there. Not shipping." >&2; exit 1; }
done
# No secret from the .env files next build reads may end up in what ships (only the setting names
# are printed). Settings named like secrets are checked (plain URLs and names would match the code's
# own defaults), written as KEY=v, KEY="v", KEY='v' or with `export ` in front.
leaked=""
for envfile in .env .env.local .env.production .env.production.local; do
  [ -f "$envfile" ] || continue
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#export }"
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ "$(tr '[:lower:]' '[:upper:]' <<<"$key")" =~ (KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|DATABASE_URL) ]] || continue
    value="${value%"${value##*[![:space:]]}"}"
    case "$value" in
      \"*\") value="${value:1:${#value}-2}" ;;
      \'*\') value="${value:1:${#value}-2}" ;;
    esac
    [ "${#value}" -ge 12 ] || continue
    if grep -rqsF -- "$value" .next/standalone .next/static public; then leaked="$leaked $key ($envfile)"; fi
  done < "$envfile"
done
[ -z "$leaked" ] || { echo "Values of these settings are in the build output:$leaked. Not shipping." >&2; exit 1; }

# 2. The bundle for the bots' computers: the server as the app runs it (standalone, its static files
# and public beside it, as electron-builder lays them out in Resources/server), packed from a copy
# (APFS clones it, so it takes no room) with no macOS metadata, owned by root, and its sha256.
version="$(node -p 'require("./package.json").version')"
build_id="$(cat .next/BUILD_ID)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "package.json's version ($version) isn't x.y.z." >&2; exit 1; }
[[ "$build_id" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "The build's id ($build_id) isn't one the runner can be named for." >&2; exit 1; }
name="bops-server-$version-$build_id.tgz"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
# A clone where APFS can, else a plain copy (a build on another volume than the stage's). A clone that
# fails partway leaves a folder behind, which the plain copy would go into, a level down: it goes first.
copy() { cp -Rc "$1" "$2" 2>/dev/null || { rm -rf "$2"; cp -R "$1" "$2"; }; }
copy .next/standalone "$stage/server"
mkdir -p "$stage/server/.next"
rm -rf "$stage/server/.next/static" "$stage/server/public"
copy .next/static "$stage/server/.next/static"
copy public "$stage/server/public"
# The runner installs only a bundle with its server.js on top (lib/server/runner-install.ts installScript).
[ -f "$stage/server/server.js" ] || { echo "The runner bundle has no server.js at its top. Not shipping." >&2; exit 1; }
mkdir -p dist-runner
rm -f dist-runner/bops-server-*.tgz dist-runner/bops-server-*.tgz.sha256
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --uid 0 --gid 0 --uname root --gname root -czf "dist-runner/$name" -C "$stage/server" .
(cd dist-runner && shasum -a 256 "$name" > "$name.sha256")
echo "Server bundle: dist-runner/$name ($(du -h "dist-runner/$name" | cut -f1))."
