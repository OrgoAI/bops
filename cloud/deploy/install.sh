#!/usr/bin/env bash
# Sets up Bops Cloud on orgo-web's production box (Ubuntu 24.04), as root, next to orgo-web. Safe to
# run again. Run on the box:
#   bash /opt/bops/cloud/deploy/install.sh
# Then scripts/cloud-deploy.sh (on a laptop) puts the code, the settings and the relay binary here.
#
# What it adds, and nothing else:
# - Node 24 (official build, checksum checked) under /usr/local/lib/nodejs.
# - Bops Cloud as bops-cloud.service (user bops, 127.0.0.1:8790), capped at 2 cores and 4 GB so it
#   can never starve orgo-web.
# - The orgo-relay rendezvous for "Route through this Mac" as orgo-relay-rendezvous.service (:8443,
#   its own TLS with a copy of the certificate Caddy already has for www.orgo.ai, as on staging).
# - Its own site in orgo-web's Caddy (/etc/orgo/web/Caddyfile; Caddy runs in Docker on the host
#   network): bops.orgo.ai, with /api/* going to 127.0.0.1:8790 (prefix stripped). A site of its own
#   leaves www.orgo.ai's block untouched. 127.0.0.1, never "localhost:<port>": orgo-web's deploy
#   rewrites every "reverse_proxy localhost:…" line to its own replicas.
set -euo pipefail
BOPS_SITE="${BOPS_SITE:-bops.orgo.ai}"
BOPS_CLOUD_PATH="${BOPS_CLOUD_PATH:-/api}"
NODE_MAJOR=24
CADDYFILE=/etc/orgo/web/Caddyfile
CADDY_CONTAINER="${CADDY_CONTAINER:-web-caddy-1}"
here="$(cd "$(dirname "$0")" && pwd)"

# Node 24 (the newest 24.x), the official build, checked against its published SHA-256.
if ! /usr/local/bin/node --version 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -o "node-v$NODE_MAJOR\.[0-9.]*-linux-x64\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
  rm -rf /usr/local/lib/nodejs && mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs --strip-components=1
  ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  ln -sf /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm
  rm -rf "$tmp"
fi

# Users and folders. Settings files are root-owned and readable by the service's group only.
id bops >/dev/null 2>&1 || useradd --system --home-dir /opt/bops --shell /usr/sbin/nologin bops
id orgo-relay >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin orgo-relay
install -d -m 0755 /opt/bops
install -d -m 0750 -o root -g bops /etc/bops-cloud
install -d -m 0750 -o root -g orgo-relay /etc/orgo-relay
install -d -m 0750 -o orgo-relay -g orgo-relay /etc/orgo-relay/tls

# The services: installed and enabled; scripts/cloud-deploy.sh starts them once code and settings are in.
install -m 0644 "$here/bops-cloud.service" "$here/orgo-relay-rendezvous.service" "$here/orgo-relay-cert.service" "$here/orgo-relay-cert.timer" /etc/systemd/system/
install -m 0755 "$here/orgo-relay-cert-sync.sh" /usr/local/sbin/orgo-relay-cert-sync
systemctl daemon-reload
systemctl enable bops-cloud.service orgo-relay-rendezvous.service orgo-relay-cert.timer >/dev/null 2>&1

# Caddy: Bops Cloud's own site (BOPS_SITE, with the API under BOPS_CLOUD_PATH), appended to orgo-web's
# Caddyfile and checked before Caddy reloads; anything wrong puts the old Caddyfile back. Caddy gets
# its certificate once the name points here.
if grep -q "^$BOPS_SITE {" "$CADDYFILE"; then
  echo "Caddy already serves $BOPS_SITE."
else
  backup="$CADDYFILE.bak-bops-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$CADDYFILE" "$backup"
  sed -e "s|BOPS_SITE|$BOPS_SITE|" -e "s|BOPS_CLOUD_PATH|$BOPS_CLOUD_PATH|" "$here/Caddyfile.template" >> "$CADDYFILE"
  if docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
     && docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    echo "Caddy now serves https://$BOPS_SITE$BOPS_CLOUD_PATH/ (backup: $backup)."
  else
    cp -p "$backup" "$CADDYFILE"
    docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
    echo "Caddy refused the new site; the old Caddyfile is back. Nothing changed." >&2
    exit 1
  fi
fi

echo "Box ready (Node $(/usr/local/bin/node --version)). Now run scripts/cloud-deploy.sh."
