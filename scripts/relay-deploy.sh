#!/usr/bin/env bash
# Deploys the orgo-relay rendezvous to orgo-web's production box, where it runs next to Bops Cloud.
# It's what Orgo's "Use my device's IP" (and so Bops' "Route through this Mac") connects through:
# Macs dial it and hold a connection, and bot computers' browsers go out through them. This puts the
# release named by ORGO_RELAY_VERSION on the box with its secret and Caddy's certificate for
# RELAY_HOST, restarts it, and checks it answers at https://RELAY_HOST:8443. The box is set up once
# with cloud/deploy/install.sh; scripts/cloud-deploy.sh runs this too. Run from the repo:
#   scripts/relay-deploy.sh
# Needs: Orgo's private OrgoAI/bops-secrets next to this repo (BOPS_SECRETS points elsewhere) and sops,
# which decrypts its prod/bops-secrets.env; gh (orgo-relay's releases are private); and SSH to the box
# as root (default key: z-legacy-fleet's id_ed25519; BOPS_CLOUD_SSH_KEY picks another).
#
# ORGO_RELAY_SECRET has to be the same value as in orgo-web's envs/prod/web-secrets.env: orgo-web
# makes every device's and computer's credential from it, and the rendezvous checks them with it.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
# Orgo's prod settings and secrets sit next to the main checkout (this may be a worktree elsewhere).
main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
prod="${BOPS_SECRETS:-$main/../bops-secrets}/prod"
[ -f "$prod/bops-public.env" ] || { echo "No $prod/bops-public.env: clone OrgoAI/bops-secrets next to $main, or set BOPS_SECRETS." >&2; exit 1; }
set -a
. "$prod/bops-public.env"
set +a
: "${BOPS_CLOUD_BOX:?set BOPS_CLOUD_BOX (root@<address>) in bops-secrets prod/bops-public.env}"
: "${ORGO_RELAY_VERSION:?set ORGO_RELAY_VERSION (an orgo-relay release, like v0.0.3) in bops-secrets prod/bops-public.env}"
: "${RELAY_HOST:?set RELAY_HOST (the name Caddy has a certificate for) in bops-secrets prod/bops-public.env}"

ssh_opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
key="${BOPS_CLOUD_SSH_KEY:-$root/../z-legacy-fleet/.ssh/id_ed25519}"
[ -f "$key" ] && ssh_opts+=(-i "$key" -o IdentitiesOnly=yes)
box() { ssh "${ssh_opts[@]}" "$BOPS_CLOUD_BOX" "$@"; }

secret="$(sops -d "$prod/bops-secrets.env" | sed -n 's/^ORGO_RELAY_SECRET=//p')"
if [ -z "$secret" ]; then
  echo "   no ORGO_RELAY_SECRET in bops-secrets.env yet: rendezvous left as it is"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh release download "$ORGO_RELAY_VERSION" -R orgoai/orgo-relay -p orgo-relay-linux-amd64 -p SHA256SUMS -D "$tmp" >/dev/null
(cd "$tmp" && grep ' orgo-relay-linux-amd64$' SHA256SUMS | shasum -a 256 -c - >/dev/null)
rsync -az -e "ssh ${ssh_opts[*]}" "$tmp/orgo-relay-linux-amd64" "$BOPS_CLOUD_BOX:/usr/local/bin/orgo-relay.new"
box 'chmod 0755 /usr/local/bin/orgo-relay.new && mv /usr/local/bin/orgo-relay.new /usr/local/bin/orgo-relay'
printf 'ORGO_RELAY_SECRET=%s\nRELAY_HOST=%s\n' "$secret" "$RELAY_HOST" | box 'install -m 0640 -o root -g orgo-relay /dev/stdin /etc/orgo-relay/env'
# The certificate first (the rendezvous won't start without it), then the timer that picks up
# Caddy's renewals, then the rendezvous itself.
box 'systemctl start orgo-relay-cert.service && systemctl enable --now orgo-relay-cert.timer >/dev/null 2>&1 && test -s /etc/orgo-relay/tls/cert.pem && systemctl restart orgo-relay-rendezvous.service && sleep 2 && systemctl is-active orgo-relay-rendezvous.service'

health="$(curl -fsS --retry 5 --retry-delay 2 --retry-all-errors "https://$RELAY_HOST:8443/healthz")"
case "$health" in
  *"\"version\":\"$ORGO_RELAY_VERSION\""*) echo "   rendezvous $ORGO_RELAY_VERSION answers at https://$RELAY_HOST:8443 ($health)" ;;
  *) echo "The rendezvous answered, but not as $ORGO_RELAY_VERSION: $health" >&2; exit 1 ;;
esac
