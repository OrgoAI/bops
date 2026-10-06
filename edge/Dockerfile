FROM node:22-alpine

RUN apk add --no-cache ca-certificates iptables ip6tables
# Pinned (1.98.x has an open deadlock, tailscale#21638).
COPY --from=docker.io/tailscale/tailscale:v1.102.5 /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=docker.io/tailscale/tailscale:v1.102.5 /usr/local/bin/tailscale /usr/local/bin/tailscale

WORKDIR /app
COPY server.mjs start.sh ./
COPY public ./public
RUN chmod +x start.sh

CMD ["/app/start.sh"]
