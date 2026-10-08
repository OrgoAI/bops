#!/usr/bin/env bash
# Makes the public copy of Bops: the committed files minus the internal ones, as one fresh commit in
# a new repo. No history comes along (the private history has build notes, account ids and test
# data). Then it checks the copy: gitleaks for secrets, and the private patterns (names, numbers,
# ids) listed in docs/internal/private-patterns.txt, which stays out of the copy.
#
# Usage: scripts/export-public.sh <new empty folder>
# Then look it over, and push it to the public repo yourself.
set -euo pipefail

dest="${1:?usage: scripts/export-public.sh <new empty folder>}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

if [ -e "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
  echo "$dest isn't empty" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "Note: uncommitted changes are left out (only what's committed is exported)." >&2
fi

mkdir -p "$dest"
git archive --format=tar HEAD | tar -x -C "$dest"
# Internal: build notes, launch research, carrier registration, and dev scripts tied to one install.
rm -rf "$dest/docs/internal" "$dest/scripts/internal"
# Orgo's secrets helper belongs to the hosted Bops, not the public copy. (Its encrypted secrets moved to
# OrgoAI/bops-secrets; envs/ and .sops.yaml stay listed for a tree from before that.)
rm -rf "$dest/envs" "$dest/.sops.yaml" "$dest/scripts/secrets.sh"

failed=0
if command -v gitleaks >/dev/null; then
  gitleaks dir "$dest" --redact --no-banner || failed=1
else
  echo "gitleaks isn't installed: skipping the secret scan (brew install gitleaks)." >&2
  failed=1
fi
patterns="$root/docs/internal/private-patterns.txt"
# Text that may stay in the copy although a pattern matches it (one fixed string per line): the
# public repo's own address, which the landing page links to.
allowed="$root/docs/internal/public-allowed.txt"
if [ -f "$patterns" ]; then
  if grep -rnE -f <(grep -v '^#' "$patterns" | grep -v '^$') "$dest" | grep -vF -f <(grep -v '^#' "$allowed" 2>/dev/null | grep -v '^$' || echo $'\x01'); then
    echo "Private details found above: fix them in the private repo, commit, and export again." >&2
    failed=1
  fi
fi

cd "$dest"
git init -q -b main
git add -A
git commit -q -m "Bops"
echo "Public copy: $dest ($(git ls-files | wc -l | tr -d ' ') files, one commit)."
[ "$failed" = 0 ] || { echo "Checks didn't pass: don't publish this copy yet." >&2; exit 1; }
