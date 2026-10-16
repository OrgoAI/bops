#!/usr/bin/env bash
# Puts a release's Mac app on bops.bot: the DMG for the landing page's download buttons,
# https://bops.bot/download/Bops.dmg (always the newest release) and /download/Bops-<version>-arm64.dmg,
# and the zip the app updates itself from, /download/Bops-<version>-arm64-mac.zip (the newest three kept).
# Takes both from the GitHub release on OrgoAI/bops, checks them against the release's latest-mac.yml,
# copies them to the Bops VM (BOPS_SITE_BOX), then checks the VM serves the same bytes. Then it writes
# /download/latest.json, which the Mac app reads to learn a newer version is out and what's new in it,
# and downloads it from (its "currentRelease" and "releases" are what Electron's autoUpdater reads; see
# "New versions" in desktop/main.cjs), and bops.bot's download card reads for its "What's new". Apps
# before 0.0.29 read only "version" and "notes", and send their users to bops.bot. Run from the repo
# after a release:
#   scripts/download-publish.sh           # the newest release
#   scripts/download-publish.sh v0.0.2    # a given one
# Needs Orgo's private OrgoAI/bops-secrets next to this repo (its prod/bops-public.env names the VM;
# BOPS_SECRETS points elsewhere), gh, jq, and SSH to the VM as root (default key: z-legacy-fleet's
# ci-staging.key; BOPS_SITE_SSH_KEY picks another).
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
command -v jq >/dev/null || { echo "latest.json is made with jq: install it first (brew install jq)." >&2; exit 1; }
# Orgo's prod settings and the legacy key sit next to the main checkout (this may be a worktree elsewhere).
main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
prod="${BOPS_SECRETS:-$main/../bops-secrets}/prod"
[ -f "$prod/bops-public.env" ] || { echo "No $prod/bops-public.env: clone OrgoAI/bops-secrets next to $main, or set BOPS_SECRETS." >&2; exit 1; }
set -a
. "$prod/bops-public.env"
set +a
: "${BOPS_SITE_BOX:?set BOPS_SITE_BOX (root@<address>) in bops-secrets prod/bops-public.env}"

ssh_opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
key="${BOPS_SITE_SSH_KEY:-$main/../z-legacy-fleet/.ssh/ci-staging.key}"
[ -f "$key" ] && ssh_opts+=(-i "$key" -o IdentitiesOnly=yes)
box() { ssh "${ssh_opts[@]}" "$BOPS_SITE_BOX" "$@"; }

tag="${1:-$(gh release list -R OrgoAI/bops --exclude-drafts --exclude-pre-releases --limit 1 --json tagName -q '.[0].tagName')}"
dmg="Bops-${tag#v}-arm64.dmg"
zip="Bops-${tag#v}-arm64-mac.zip"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "1/4 $dmg and $zip from the $tag release"
gh release download "$tag" -R OrgoAI/bops -p "$dmg" -p "$zip" -p latest-mac.yml -D "$tmp" >/dev/null
# latest-mac.yml (written by electron-builder) lists each file's sha512, base64.
sha() { openssl dgst -sha512 -binary "$1" | base64 | tr -d '\n'; }
listed() { awk -v f="$1" '$0 ~ "url: "f"$" {getline; sub(/^ *sha512: */, ""); print; exit}' "$tmp/latest-mac.yml"; }
want="$(listed "$dmg")"
zip_want="$(listed "$zip")"
if [ -z "$want" ] || [ "$(sha "$tmp/$dmg")" != "$want" ]; then
  echo "$dmg doesn't match the release's latest-mac.yml: not publishing it." >&2
  exit 1
fi
if [ -z "$zip_want" ] || [ "$(sha "$tmp/$zip")" != "$zip_want" ]; then
  echo "$zip doesn't match the release's latest-mac.yml: not publishing it." >&2
  exit 1
fi

# latest.json, made now, so nothing changes on the VM when it can't be: the version, where to get it, when
# it came out, and "notes", what's new in it. Those are the "- " lines of docs/releases/<tag>.md as tagged
# on OrgoAI/bops, else of this checkout's (a tag from before those files); with neither, the file has no
# "notes", as before. Not the release's own notes: older ones have long lines and details that aren't for
# the app or the page. jq writes it, so quotes and any script in the notes come through intact (as \u
# escapes: the file is plain ASCII).
released="$(gh release view "$tag" -R OrgoAI/bops --json publishedAt -q .publishedAt 2>/dev/null || true)"
if ! md="$(gh api -H "Accept: application/vnd.github.raw" "repos/OrgoAI/bops/contents/docs/releases/$tag.md?ref=$tag" 2>/dev/null)"; then
  md="$(cat "docs/releases/$tag.md" 2>/dev/null || true)"
fi
printf '%s\n' "$md" | tr -d '\r' | sed -nE 's/^-[[:space:]]+//p' > "$tmp/notes.txt"
# currentRelease and releases are Squirrel.Mac's (Electron's autoUpdater, "json" feed): the version to
# update to and its zip. It fetches whatever currentRelease names, so this file only ever names the newest.
jq -nac --arg version "${tag#v}" --arg released "${released:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" --arg zip "https://bops.bot/download/$zip" --rawfile notes "$tmp/notes.txt" '
  [$notes | splits("\n") | sub("\\s+$"; "") | select(length > 0)] as $lines
  | {version: $version, url: "https://bops.bot", dmg: "https://bops.bot/download/Bops.dmg", released: $released}
  + (if ($lines | length) > 0 then {notes: $lines} else {} end)
  + {currentRelease: $version,
     releases: [{version: $version, updateTo: {version: $version, name: "Bops \($version)", notes: ($lines | join("\n")), pub_date: $released, url: $zip}}]}' > "$tmp/latest.json"

echo "2/4 to the VM"
box 'install -d -m 0755 /opt/bops/download'
rsync -a --partial -e "ssh ${ssh_opts[*]}" "$tmp/$dmg" "$BOPS_SITE_BOX:/opt/bops/download/$dmg.part"
# Renamed into place, then Bops.dmg is pointed at it in one step, so nobody gets half a file.
box "cd /opt/bops/download && chmod 0644 '$dmg.part' && mv -f '$dmg.part' '$dmg' && ln -f '$dmg' Bops.dmg.new && mv -f Bops.dmg.new Bops.dmg"
# The zip the apps update from, the same way. About 155 MB each: the newest three are kept (an app
# mid-download of the one before keeps its file).
rsync -a --partial -e "ssh ${ssh_opts[*]}" "$tmp/$zip" "$BOPS_SITE_BOX:/opt/bops/download/$zip.part"
box "cd /opt/bops/download && chmod 0644 '$zip.part' && mv -f '$zip.part' '$zip' && ls -1t -- *-arm64-mac.zip | tail -n +4 | xargs -r rm -f --"

echo "3/4 check"
remote="$(box "openssl dgst -sha512 -binary /opt/bops/download/Bops.dmg | base64 | tr -d '\n'")"
ip="${BOPS_SITE_BOX#*@}"
size="$(curl -fsSI --max-time 15 --resolve "bops.bot:443:$ip" https://bops.bot/download/Bops.dmg | awk 'tolower($1)=="content-length:" {print $2+0}')"
if [ "$remote" != "$want" ] || [ "$size" != "$(wc -c < "$tmp/$dmg" | tr -d ' ')" ]; then
  echo "bops.bot doesn't serve $dmg correctly yet (checksum or size differs)." >&2
  exit 1
fi
echo "https://bops.bot/download/Bops.dmg is $dmg ($((size / 1048576)) MB)"
# The zip as an app gets it: every byte, through Caddy.
curl -fsS --max-time 600 --resolve "bops.bot:443:$ip" -o "$tmp/served.zip" "https://bops.bot/download/$zip"
if [ "$(sha "$tmp/served.zip")" != "$zip_want" ] || [ "$(wc -c < "$tmp/served.zip")" != "$(wc -c < "$tmp/$zip")" ]; then
  echo "bops.bot doesn't serve $zip correctly yet (checksum or size differs)." >&2
  exit 1
fi
rm -f "$tmp/served.zip"
echo "https://bops.bot/download/$zip is served"

# Only once the DMG and the zip are served: the apps that read this download the zip, or send their
# users to the DMG.
echo "4/4 latest.json"
# Written next to it, then renamed into place, so an app never reads half a file.
box "cat > /opt/bops/download/latest.json.new && chmod 0644 /opt/bops/download/latest.json.new && mv -f /opt/bops/download/latest.json.new /opt/bops/download/latest.json" < "$tmp/latest.json"
served="$(curl -fsS --max-time 15 --resolve "bops.bot:443:$ip" https://bops.bot/download/latest.json || true)"
if [ "$served" != "$(cat "$tmp/latest.json")" ]; then
  echo "bops.bot doesn't serve the new latest.json yet: got ${served:-nothing}" >&2
  exit 1
fi
echo "https://bops.bot/download/latest.json says ${tag#v} (what's new: $(jq '.notes // [] | length' "$tmp/latest.json") lines)"
