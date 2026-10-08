#!/usr/bin/env bash
# Deploys Bops Cloud to its box (orgo-web's production box, where it runs next to orgo-web): the code
# (cloud/, db/), its settings, and the orgo-relay rendezvous; then restarts both and checks the cloud
# answers. The box is set up once with cloud/deploy/install.sh. Run from the repo:
#   scripts/cloud-deploy.sh
# Needs: sops (decrypts envs/prod/bops-secrets.env), gh (fetches orgo-relay from its private
# releases), and SSH to the box as root (default key: z-legacy-fleet's id_ed25519; BOPS_CLOUD_SSH_KEY
# picks another).
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
set -a
. envs/prod/bops-public.env
set +a
: "${BOPS_CLOUD_BOX:?set BOPS_CLOUD_BOX (root@<address>) in envs/prod/bops-public.env}"

ssh_opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
key="${BOPS_CLOUD_SSH_KEY:-$root/../z-legacy-fleet/.ssh/id_ed25519}"
[ -f "$key" ] && ssh_opts+=(-i "$key" -o IdentitiesOnly=yes)
box() { ssh "${ssh_opts[@]}" "$BOPS_CLOUD_BOX" "$@"; }

if [ -n "$(git status --porcelain -- cloud db)" ]; then
  echo "cloud/ or db/ has uncommitted changes: commit them first, so the box runs a known version." >&2
  exit 1
fi
rev="$(git rev-parse --short HEAD)"

echo "1/4 code ($rev)"
rsync -az --delete -e "ssh ${ssh_opts[*]}" --exclude node_modules --exclude test cloud db "$BOPS_CLOUD_BOX:/opt/bops/"
echo "$rev" | box 'cat > /opt/bops/REVISION'
box 'cd /opt/bops/cloud && npm install --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error >/dev/null'

echo "2/4 settings"
# Only what the cloud uses: the public settings above, and of the secrets only the provider keys,
# Slack's signing secret, the database and the sealing key (not Stripe, Latitude or the Orgo admin token).
{
  grep -E '^(BOPS_CLOUD_PUBLIC_URL|BOPS_CLOUD_PORT|BOPS_ORGO_ORIGIN|OPENAI_SIP_URI|BOPS_VERIFY_EMAIL|BOPS_SLACK_APP_ID|BOPS_COMPOSIO_AUTH_CONFIGS|BOPS_AI_CREDITS|BOPS_PLAN_LIMITS|BOPS_MAIL_DOMAIN|BOPS_PHONE_AREA|BOPS_TELEMETRY)=' envs/prod/bops-public.env
  sops -d envs/prod/bops-secrets.env | grep -E '^(BOPS_DATABASE_URL|BOPS_CLOUD_SECRET|OPENAI_API_KEY|OPENAI_EXECUTOR_API_KEY|OPENAI_WEBHOOK_SECRET|AGENTPHONE_API_KEY|AGENTMAIL_API_KEY|HONCHO_API_KEY|COMPOSIO_API_KEY|TYPESAFE_API_KEY|TREG_TOKEN|BOPS_SLACK_SIGNING_SECRET|BOPS_CLOUD_PLAN_SECRET|TWILIO_[A-Z_]+)='
} | box 'install -m 0640 -o root -g bops /dev/stdin /etc/bops-cloud/env'

echo "3/4 relay ($ORGO_RELAY_VERSION)"
scripts/relay-deploy.sh

echo "4/4 restart and check"
box 'systemctl restart bops-cloud.service && sleep 3 && systemctl is-active bops-cloud.service'
curl -fsS --retry 5 --retry-delay 2 --retry-all-errors "$BOPS_CLOUD_PUBLIC_URL/health"
echo
echo "Bops Cloud $rev is live at $BOPS_CLOUD_PUBLIC_URL"
