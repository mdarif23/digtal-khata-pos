# Caddy edge with a DNS-01 plugin for the *.ezpos.store wildcard certificate.
# The DNS provider plugin is a build arg so the image can be rebuilt for a
# different provider without touching this file (see docs/STOREFRONT-DEPLOYMENT.md).
ARG DNS_PLUGIN=github.com/caddy-dns/cloudflare
FROM caddy:2-builder AS builder
ARG DNS_PLUGIN
RUN xcaddy build --with ${DNS_PLUGIN}

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
