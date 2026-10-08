#!/usr/bin/env bash
# Deploys the landing page (site/) to bops.bot: the Bops VM (BOPS_SITE_BOX) serves it with Caddy.
# Copies the page's files and site/deploy/Caddyfile, reloads Caddy, and checks that bops.bot on the VM
# serves this index.html. The VM is set up once with site/deploy/install.sh. The backend API
# (bops.orgo.ai/api) is separate: scripts/cloud-deploy.sh. Run from the repo:
#   scripts/site-deploy.sh
# Needs SSH to the VM as root (default key: z-legacy-fleet's ci-staging.key; BOPS_SITE_SSH_KEY picks
# another).
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
set -a
. envs/prod/bops-public.env
set +a
: "${BOPS_SITE_BOX:?set BOPS_SITE_BOX (root@<address>) in envs/prod/bops-public.env}"

ssh_opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
# The legacy key sits next to the main checkout (this may be a worktree elsewhere).
main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
key="${BOPS_SITE_SSH_KEY:-$main/../z-legacy-fleet/.ssh/ci-staging.key}"
[ -f "$key" ] && ssh_opts+=(-i "$key" -o IdentitiesOnly=yes)
box() { ssh "${ssh_opts[@]}" "$BOPS_SITE_BOX" "$@"; }

dir=site url=https://bops.bot/

if [ -n "$(git status --porcelain -- site)" ]; then
  echo "site/ has uncommitted changes: commit them first, so bops.bot shows a known version." >&2
  exit 1
fi
rev="$(git rev-parse --short HEAD)"

echo "1/3 files ($rev)"
# Only what the page serves: not the deploy files, the old Fly setup or the README.
# site/90s stays off the box until its copy matches the app and its sign-up form keeps the emails.
rsync -az --delete -e "ssh ${ssh_opts[*]}" --exclude deploy --exclude Dockerfile --exclude fly.toml --exclude 90s \
  --exclude nginx.conf --exclude README.md site/ "$BOPS_SITE_BOX:/opt/bops/$dir/"
echo "$rev" | box "cat > /opt/bops/$dir-revision"

echo "2/3 Caddy"
rsync -az -e "ssh ${ssh_opts[*]}" site/deploy/Caddyfile "$BOPS_SITE_BOX:/etc/caddy/Caddyfile.new"
box 'caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/dev/null 2>&1 \
  && mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile && systemctl reload caddy'

echo "3/3 check"
# Asked of the VM itself (bops.bot may still resolve to the old host for a while after a DNS change),
# and compared with this index.html, so a stale copy elsewhere can't pass for it.
ip="${BOPS_SITE_BOX#*@}"
want="$(shasum -a 256 site/index.html | cut -d' ' -f1)"
for _ in $(seq 1 30); do
  got="$(curl -fsS --max-time 10 --resolve "bops.bot:443:$ip" "$url" 2>/dev/null | shasum -a 256 | cut -d' ' -f1)" || true
  [ "$got" = "$want" ] && break
  sleep 4
done
if [ "$got" != "$want" ]; then
  echo "$url on $ip doesn't serve this index.html yet (a new certificate can take a minute; see journalctl -u caddy)." >&2
  exit 1
fi
echo "$url shows $rev (from $ip)"
