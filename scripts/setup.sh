#!/usr/bin/env bash
# Sets up this checkout for development, and says what's left. Run it again any time: it only adds what's
# missing, and never overwrites your .env.local.
#   1. Node 22 or newer, and the dependencies (npm install).
#   2. .env.local from .env.example, when there's none: fill in your keys (see "Run it yourself" in the
#      README), or leave it as it is and sign in with Orgo.
#   3. The relay agent (scripts/fetch-relay.sh), when your GitHub login can read Orgo's relay releases.
#      Without it everything works but "Route through this Mac". The same for the ingot command the bots'
#      computers work on apps with (scripts/fetch-ingot.sh), when it can read Orgo's Ingot releases.
#   4. A git hook (scripts/push-guard.sh) that refuses to push history that isn't this repo's to
#      github.com/OrgoAI/bops. (A clone made before Orgo's private repo was renamed still holds its history,
#      and its old address now reaches this public repo.) With bops-secrets next to it, it also refuses new
#      commits that carry a private detail anywhere (its docs/private-patterns.txt).
# Orgo's team: with the private OrgoAI/bops-secrets cloned next to this repo, it also says how to put
# Orgo's development keys in .env.local.
#
#   npm run setup                 (or scripts/setup.sh)
#   scripts/setup.sh --hook       only the git hook
set -euo pipefail
# The guard the hook is a copy of: this script's own, whichever checkout it's run in.
guard="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/push-guard.sh"
root="$(git rev-parse --show-toplevel)"
cd "$root"

# The git hook is a copy of scripts/push-guard.sh, which says what it checks. A copy installed from another
# checkout that's newer (a higher guard_version) is left as it is; an older one is replaced (and replaces
# itself before a push from a checkout with a newer one).
install_hook() {
  local hooks hook have want tmp
  hooks="$(git rev-parse --path-format=absolute --git-path hooks)"
  hook="$hooks/pre-push"
  if [ -f "$hook" ] && ! grep -q 'bops-public-history-guard' "$hook"; then
    echo "  - $hook is someone else's hook: left as it is. Add this repo's check (scripts/push-guard.sh) to it by hand."
    return
  fi
  want="$(sed -n 's/^guard_version=\([0-9][0-9]*\)$/\1/p' "$guard" | head -n 1)"
  have="$( { sed -n 's/^guard_version=\([0-9][0-9]*\)$/\1/p' "$hook" 2>/dev/null || true; } | head -n 1)"
  if [ "${have:-0}" -gt "${want:-0}" ]; then
    echo "  - git hook: a newer one from another checkout is installed already ($hook)."
    return
  fi
  mkdir -p "$hooks"
  # Written beside it and moved over it: a push running the old one keeps reading the file it started on.
  tmp="$(mktemp "$hooks/.pre-push.XXXXXX")"
  cp "$guard" "$tmp"
  chmod +x "$tmp"
  mv -f "$tmp" "$hook"
  echo "  - git hook: pushes to github.com/OrgoAI/bops only carry its own history ($hook)."
}

if [ "${1:-}" = "--hook" ]; then
  install_hook
  exit 0
fi

echo "Setting up $root"

# 1. Node and the dependencies.
command -v node >/dev/null || { echo "Install Node 22 or newer first (https://nodejs.org)." >&2; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || { echo "Node $(node -v) is too old: Bops needs 22 or newer." >&2; exit 1; }
npm install --no-audit --no-fund
echo "  - dependencies installed (Node $(node -v))."

# 2. .env.local.
if [ -f .env.local ]; then
  echo "  - .env.local is there; left as it is."
else
  cp .env.example .env.local
  echo "  - .env.local made from .env.example: fill in at least OPENAI_API_KEY and OPENAI_EXECUTOR_API_KEY,"
  echo "    or set BOPS_SELF_HOSTED=0 in it and sign in with Orgo, which needs no keys of your own."
fi

# 3. The relay agent, when this GitHub login can read Orgo's relay releases.
if [ -x vendor/orgo-relay/orgo-relay ]; then
  echo "  - relay agent: $(cat vendor/orgo-relay/VERSION 2>/dev/null || echo there)."
elif command -v gh >/dev/null && gh release view -R orgoai/orgo-relay >/dev/null 2>&1; then
  scripts/fetch-relay.sh >/dev/null && echo "  - relay agent fetched ($(cat vendor/orgo-relay/VERSION))."
else
  echo "  - relay agent skipped (Orgo's relay releases are private): everything works but \"Route through this Mac\"."
fi
# The ingot command for the bots' computers, likewise (skipped quietly: only Orgo's team works on apps).
if [ -x vendor/ingot/ingot-linux-amd64 ] && [ -x vendor/ingot/ingot-linux-arm64 ]; then
  echo "  - ingot: $(cat vendor/ingot/VERSION 2>/dev/null || echo there)."
elif command -v gh >/dev/null && gh release view -R orgoai/ingot >/dev/null 2>&1; then
  scripts/fetch-ingot.sh >/dev/null && echo "  - ingot fetched ($(cat vendor/ingot/VERSION))."
fi

# 4. The git hook.
install_hook

# Orgo's team.
main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
secrets="${BOPS_SECRETS:-$main/../bops-secrets}"
if [ -x "$secrets/scripts/dev-env.sh" ]; then
  secrets="$(cd "$secrets" && pwd)"
  echo "  - Orgo's bops-secrets is next to this repo: $secrets/scripts/dev-env.sh puts Orgo's development keys in .env.local."
fi

echo
echo "Next: npm run app (opens the app, which starts the server on port 3210)."
