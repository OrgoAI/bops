#!/bin/sh
set -e
mkdir -p /var/run/tailscale /var/lib/tailscale

# Tailscale with a real network interface (Fly machines have /dev/net/tun), so the relay reaches
# the Mac's tailnet address directly. Its login is kept on the volume.
tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock &

# First boot: no saved login, so this prints a link to approve the machine (in `fly logs`), or uses
# TS_AUTHKEY if that secret is set. Later boots reuse the saved login. In the background, so the
# relay answers health checks meanwhile.
tailscale up --hostname=bops-api --accept-dns=false ${TS_AUTHKEY:+--auth-key=$TS_AUTHKEY} &

exec node /app/server.mjs
