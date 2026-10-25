#!/usr/bin/env bash
# Builds Bops.app for release: the orgo-relay agent, the ingot command for the bots' computers, the
# production server (Next standalone, and its bundle for the bots' computers: scripts/server-bundle.sh)
# and the signed, notarized DMG + zip in dist-desktop/. See "Releasing the Mac app" in README.md.
#
# Signing uses a "Developer ID Application" certificate: from the keychain, or CSC_LINK (a .p12,
# path or base64) + CSC_KEY_PASSWORD, or CSC_NAME to pick one. Notarization runs when one of these
# is set: APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER (recommended), or APPLE_ID +
# APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID. Without a certificate it builds an unsigned app for
# testing on this Mac only.
#
# The zip is what installed apps download to update themselves (desktop/updates.cjs), so it's checked
# to be signed by Orgo's team (A47GG9FV27) as ai.orgo.bops: a change to either stops every update.
#
# Usage: scripts/release.sh [extra electron-builder args, e.g. --dir]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

[ "$(uname -s)" = Darwin ] || { echo "Build the Mac app on a Mac." >&2; exit 1; }

# desktop/repo.json makes the app run `next dev` from this folder (npm run app:build); a release
# runs its own bundled server instead.
rm -f desktop/repo.json

# 1. The orgo-relay agent, bundled as Contents/Resources/bin/orgo-relay. BOPS_RELAY_READY=1: it's in
# vendor/orgo-relay already (a release build that fetched it in a step of its own).
relay="vendor/orgo-relay/orgo-relay"
if [ -x scripts/fetch-relay.sh ] && [ -z "${BOPS_RELAY_READY:-}" ]; then
  scripts/fetch-relay.sh
fi
[ -x "$relay" ] || { echo "Missing $relay (scripts/fetch-relay.sh puts it there)." >&2; exit 1; }
file "$relay" | grep -q "arm64" || { echo "$relay is not an arm64 Mac binary." >&2; exit 1; }

# 1b. The ingot command for the bots' computers (Linux, both arches: lib/server/ingot.ts copies the one a
# computer needs onto it), bundled as Contents/Resources/bin/ingot. BOPS_INGOT_READY=1: it's in
# vendor/ingot already (a release build that fetched it in a step of its own).
if [ -x scripts/fetch-ingot.sh ] && [ -z "${BOPS_INGOT_READY:-}" ]; then
  scripts/fetch-ingot.sh
fi
for arch in amd64:x86-64 arm64:aarch64; do
  ingot="vendor/ingot/ingot-linux-${arch%%:*}"
  [ -x "$ingot" ] || { echo "Missing $ingot (scripts/fetch-ingot.sh puts it there)." >&2; exit 1; }
  kind="$(file -b "$ingot")"
  [[ "$kind" == "ELF 64-bit"*"${arch#*:}"* ]] || { echo "$ingot is not a ${arch%%:*} Linux binary." >&2; exit 1; }
done

# 2. The server, built, stripped and checked for leaked secrets, and packed for the bots' computers'
# Bops runners (dist-runner/bops-server-<version>-<BUILD_ID>.tgz, which the app ships in Resources/runner):
# scripts/server-bundle.sh.
scripts/server-bundle.sh

# 3. Signing and notarization.
signing=""
if [ -n "${CSC_LINK:-}" ] || security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  signing=1
  # electron-builder falls back to any certificate (an Apple Development one, a teammate's) when it
  # finds no Developer ID: pin the lookup to the Developer ID one, by its hash, unless CSC_NAME or
  # CSC_LINK picks one. (The check after the build fails if anything else signed the app.)
  if [ -z "${CSC_LINK:-}" ] && [ -z "${CSC_NAME:-}" ]; then
    CSC_NAME="$(security find-identity -v -p codesigning | awk '/"Developer ID Application: /{print $2; exit}')"
    export CSC_NAME
  fi
  if [ -z "${APPLE_API_KEY:-}${APPLE_ID:-}${APPLE_KEYCHAIN_PROFILE:-}" ]; then
    echo "Signing with Developer ID, but no notarization credentials are set (APPLE_API_KEY, APPLE_API_KEY_ID," >&2
    echo "APPLE_API_ISSUER). The app will be signed but not notarized: Gatekeeper will block it on other Macs." >&2
  fi
else
  cat >&2 <<'EOF'
No "Developer ID Application" certificate found (in the keychain or CSC_LINK).
Building UNSIGNED, for testing on this Mac only:
  - other Macs block it (Gatekeeper), and it can't be notarized;
  - macOS ties Screen Recording and Microphone grants to the signature, so each unsigned build
    may ask again.
To ship, install the Developer ID Application certificate of the Apple Developer team (or set
CSC_LINK and CSC_KEY_PASSWORD) and the notarization settings, then run this again.
EOF
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

# 4. The app. Resources/server is the standalone server (electron-builder never copies a top-level
# node_modules folder, so package.json copies .next/standalone/node_modules on its own).
npx electron-builder --mac "$@"

app="$root/dist-desktop/mac-arm64/Bops.app"

# 5. Smoke test: the bundled server starts with the app's own Node and serves the app and its state
# without a missing file. It runs as a fresh install does: no keys (env -i drops this shell's), an
# empty HOME, so it can't reach this Mac's Keychain, Orgo sign-in or Codex, and a spare port, so it
# doesn't meet a running Bops.
smoke="$(mktemp -d)"
for f in "$app/Contents/Resources/server/"* "$app/Contents/Resources/server/.next"; do ln -s "$f" "$smoke/"; done
(cd "$smoke" && exec env -i HOME="$smoke" PATH=/usr/bin:/bin:/usr/sbin:/sbin ELECTRON_RUN_AS_NODE=1 NODE_ENV=production \
  PORT=3299 HOSTNAME=127.0.0.1 BOPS_SERVER_JS="$app/Contents/Resources/server/server.js" \
  "$app/Contents/MacOS/Bops" -e "process.chdir = () => {}; require(process.env.BOPS_SERVER_JS)" > "$smoke/server.log" 2>&1) &
smoke_pid=$!
ok=""
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:3299/api/health)" = 200 ]; then ok=1; break; fi
  sleep 1
done
# The page and the app's state must answer too, with no key set (the window loads both first).
if [ -n "$ok" ]; then
  for route in / /api/state; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:3299$route")"
    [ "$code" = 200 ] || { echo "$route answered $code without keys." >&2; ok=""; }
  done
fi
kill "$smoke_pid" 2>/dev/null || true
wait "$smoke_pid" 2>/dev/null || true
if [ -z "$ok" ] || grep -qE "Cannot find module|MODULE_NOT_FOUND|ENOENT" "$smoke/server.log"; then
  echo "The bundled server failed its smoke test; its log:" >&2
  sed -n 1,40p "$smoke/server.log" >&2
  exit 1
fi
rm -rf "$smoke"
echo "Bundled server smoke test passed."
# The bots' computers' runners are set up from the bundle the app carries (lib/server/runner-install.ts):
# exactly one, with its sha256.
bundles=("$app/Contents/Resources/runner/"bops-server-*.tgz)
if [ "${#bundles[@]}" -ne 1 ] || [ ! -f "${bundles[0]}" ] || [ ! -f "${bundles[0]}.sha256" ]; then
  echo "The app doesn't carry one server bundle for the bots' computers (Resources/runner)." >&2
  exit 1
fi

# -dvv: plain -dv never prints the Authority lines. Read into a variable first: with pipefail, grep -q
# stopping at the first match makes codesign fail on the closed pipe, and the check with it.
signature="$( [ -d "$app" ] && codesign -dvv "$app" 2>&1 || true)"
if [[ "$signature" == *"Authority=Developer ID Application"* ]]; then
  codesign --verify --deep --strict "$app" && echo "Signature OK."
  spctl -a -vv -t exec "$app" 2>&1 || echo "Gatekeeper doesn't accept it yet (not notarized?)." >&2
elif [ -n "$signing" ]; then
  echo "Bops.app isn't signed with a Developer ID Application certificate:" >&2
  grep Authority <<<"$signature" >&2 || echo "  (not signed)" >&2
  exit 1
fi

# 6. The zip is what installed apps update themselves from (desktop/updates.cjs): macOS installs it only
# when the app in it is signed by the same team, with the same bundle id. Checked as it will be, from
# the zip itself. Not with --dir (no zip) or an unsigned test build (it can't update anyone). Squirrel
# doesn't check notarization, so that's checked here too: the app in the zip notarized, its ticket
# stapled. A build without notarization settings skips that, and its zip isn't fit to publish.
dir_only=""
for a in "$@"; do [ "$a" = --dir ] && dir_only=1; done
notarizing=""
[ -n "${APPLE_API_KEY:-}${APPLE_ID:-}${APPLE_KEYCHAIN_PROFILE:-}" ] && notarizing=1
if [ -n "$signing" ] && [ -z "$dir_only" ]; then
  for z in dist-desktop/*.zip; do
    [ -e "$z" ] || continue
    unz="$(mktemp -d)"
    ditto -x -k "$z" "$unz"
    if ! codesign --verify --deep --strict -R='identifier "ai.orgo.bops" and anchor apple generic and certificate leaf[subject.OU] = A47GG9FV27' "$unz/Bops.app"; then
      rm -rf "$unz"
      echo "$z: the zip's app isn't signed so Bops can update to it." >&2
      exit 1
    fi
    if [ -n "$notarizing" ]; then
      if ! xcrun stapler validate "$unz/Bops.app" || ! spctl -a -t exec -vv "$unz/Bops.app"; then
        rm -rf "$unz"
        echo "$z: the zip's app isn't notarized and stapled. Not fit to publish." >&2
        exit 1
      fi
      echo "$(basename "$z"): notarized."
    else
      echo "$(basename "$z"): no notarization settings, so not notarized. Not fit to publish." >&2
    fi
    rm -rf "$unz"
    echo "$(basename "$z"): signed so Bops can update to it."
  done
fi
ls -lh dist-desktop/*.dmg dist-desktop/*.zip 2>/dev/null || true
