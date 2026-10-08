#!/bin/sh
# Copy Caddy's certificate for the relay name to orgo-relay, and restart the rendezvous when it
# changed. Installed as /usr/local/sbin/orgo-relay-cert-sync; run by orgo-relay-cert.service.
set -eu
: "${RELAY_HOST:?RELAY_HOST is not set in /etc/orgo-relay/env}"
# orgo-web's Caddy runs in Docker with its data at /var/lib/caddy (CADDY_CERTS overrides).
d="${CADDY_CERTS:-/var/lib/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory}/$RELAY_HOST"
[ -s "$d/$RELAY_HOST.crt" ] || { echo "no certificate for $RELAY_HOST yet"; exit 0; }
if cmp -s "$d/$RELAY_HOST.crt" /etc/orgo-relay/tls/cert.pem 2>/dev/null; then exit 0; fi
install -d -m 0750 -o orgo-relay -g orgo-relay /etc/orgo-relay/tls
install -m 0644 -o orgo-relay -g orgo-relay "$d/$RELAY_HOST.crt" /etc/orgo-relay/tls/cert.pem
install -m 0600 -o orgo-relay -g orgo-relay "$d/$RELAY_HOST.key" /etc/orgo-relay/tls/key.pem
systemctl try-restart orgo-relay-rendezvous.service
echo "certificate for $RELAY_HOST updated"
