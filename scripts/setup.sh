#!/usr/bin/env bash
# Sets up this checkout for development, and says what's left. Run it again any time: it only adds what's
# missing, and never overwrites your .env.local.
#   1. Node 22 or newer, and the dependencies (npm install).
#   2. .env.local from .env.example, when there's none: fill in your keys (see "Run it yourself" in the
#      README), or leave it as it is and sign in with Orgo.
#   3. The relay agent (scripts/fetch-relay.sh), when your GitHub login can read Orgo's relay releases.
#      Without it everything works but "Route through this Mac".
#   4. A git hook that refuses to push history that isn't this repo's to github.com/OrgoAI/bops. (A clone
#      made before Orgo's private repo was renamed still holds its history, and its old address now
#      reaches this public repo.)
# Orgo's team: with the private OrgoAI/bops-secrets cloned next to this repo, it also says how to put
# Orgo's development keys in .env.local.
#
#   npm run setup                 (or scripts/setup.sh)
#   scripts/setup.sh --hook       only the git hook
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"

# Everything in OrgoAI/bops descends from its first commit, and nothing of the private repo's does.
public_root=7ce4136c68a2a6e1c5c93f0be68aa82e55aac4de

install_hook() {
  local hooks hook
  hooks="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
  hook="$hooks/pre-push"
  if [ -f "$hook" ] && ! grep -q 'bops-public-history-guard' "$hook"; then
    echo "  - $hook is someone else's hook: left as it is. Add this repo's check to it by hand (see scripts/setup.sh)."
    return
  fi
  mkdir -p "$hooks"
  cat > "$hook" <<EOF
#!/usr/bin/env bash
# bops-public-history-guard, installed by scripts/setup.sh: refuses to push history that isn't OrgoAI/bops's
# to it. Everything in that repo descends from its first commit, $public_root.
shopt -s nocasematch
[[ "\$2" =~ github\\.com[:/](orgoai/bops|orgoai/bops-oss|nickvasilescu/bops)(\\.git)?/?\$ ]] || exit 0
# A shallow clone can't see that far back; it can only be a clone of the public repo.
[ "\$(git rev-parse --is-shallow-repository)" = true ] && exit 0
while read -r local_ref local_sha _ _; do
  [ "\$local_sha" = 0000000000000000000000000000000000000000 ] && continue
  if ! git merge-base --is-ancestor $public_root "\$local_sha" 2>/dev/null; then
    echo "Not pushing \$local_ref to \$2: it isn't OrgoAI/bops's history (it may be Orgo's private repo's)." >&2
    echo "Work in a fresh clone of https://github.com/OrgoAI/bops (or a branch made from its main)." >&2
    exit 1
  fi
done
exit 0
EOF
  chmod +x "$hook"
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
