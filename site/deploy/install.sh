#!/usr/bin/env bash
# Sets up the Bops VM once to serve the landing page at bops.bot: Caddy (from its own apt repository;
# it gets and renews the certificates) and a firewall that lets in SSH, HTTP and HTTPS only. The VM is
# "bops-prod-ash" (vm.small, Ashburn, Ubuntu 24.04) in Latitude's "bops" project. Run as root:
#   scp -r site/deploy root@<vm>:/tmp/ && ssh root@<vm> bash /tmp/deploy/install.sh
# Then scripts/site-deploy.sh puts the page and the Caddyfile in place.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Caddy from Caddy's signed apt repository (Ubuntu's package lags behind). Until site-deploy.sh
# installs the real Caddyfile it serves only the package's placeholder page on :80, so it asks for no
# certificate before bops.bot points here.
if ! command -v caddy >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
install -d -m 0755 /opt/bops/site

# Firewall: SSH, HTTP and HTTPS (with HTTP/3) only. SSH is allowed before the firewall goes on.
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for p in 22/tcp 80/tcp 443/tcp 443/udp; do ufw allow "$p" >/dev/null; done
ufw --force enable >/dev/null

echo "VM ready ($(caddy version | cut -d' ' -f1), firewall on). Now run scripts/site-deploy.sh."
