# Storefront Platform — Deployment Runbook

Covers the hosted-storefront platform pieces on top of the base stack in
`docs/DEPLOYMENT.md`. Read that first for Postgres/backend/website/POS basics.

## 1. DNS records (at your DNS provider)

| Record | Name | Value | Purpose |
| --- | --- | --- | --- |
| A | `ezpos.com` (and `www`) | server IP | Platform site |
| A | `api.ezpos.com` | server IP | Backend |
| A | `app.ezpos.com` | server IP | POS app |
| A | `cdn.ezpos.com` | server IP | Media CDN (MinIO reads) |
| A | `ezpos.store` | server IP | Storefront apex (redirects/landing) |
| A | `*.ezpos.store` | server IP | ALL tenant subdomains (one record serves every store) |

Customer custom domains: the customer adds a `CNAME` from
`www.theirdomain.com` → `<their-subdomain>.ezpos.store` (or an A record to
the server IP) and a TXT record `_ezpos-verify.<their-domain>` with the
token shown in the portal. The portal walks them through both steps.

## 2. Environment

Add to `.env` (see `.env.production.example`):

- `STOREFRONT_RENDERER_TOKEN` — shared secret between backend, renderer and
  the edge (`openssl rand -base64 48`).
- `STOREFRONT_BASE_DOMAIN` — defaults to `ezpos.store`.
- `S3_*` + `MINIO_*` — object storage (MinIO runs in compose).
- `ACME_EMAIL` — certificate notice email.
- `DNS_PROVIDER_API_TOKEN` — API token at your DNS provider with DNS edit
  rights on `ezpos.store` (wildcard certificate, DNS-01 challenge).
- `CADDY_DNS_PLUGIN` — only if your provider is not Cloudflare.

## 3. Caddy DNS provider plugin

The edge image is built with a DNS-01 plugin (required for the wildcard
certificate; HTTP-01 cannot prove `*.ezpos.store`). Default: Cloudflare.
For another provider set `CADDY_DNS_PLUGIN` and the matching env token, e.g.:

| Provider | Plugin | Token env |
| --- | --- | --- |
| Cloudflare | `github.com/caddy-dns/cloudflare` | `CLOUDFLARE_DNS_API_TOKEN` |
| DuckDNS | `github.com/caddy-dns/duckdns` | `DUCKDNS_API_TOKEN` |
| Route 53 | `github.com/caddy-dns/route53` | AWS creds |
| DigitalOcean | `github.com/caddy-dns/digitalocean` | `DO_AUTH_TOKEN` |

Non-Cloudflare providers need a matching `tls dns <provider>` line in
`caddy/Caddyfile` — adjust it when changing the plugin, and pass the token
env through the `caddy` service in `docker-compose.yml`.

## 4. First deployment / migration from nginx

1. **Stop nginx** on the host (it owns ports 80/443):
   `docker compose stop nginx && docker compose rm -f nginx`
   (Keep `nginx/ezpos.conf` — rollback is `docker compose up -d nginx` after
   stopping caddy.)
2. `docker compose build caddy storefront`
3. `docker compose up -d` — Caddy obtains the wildcard + platform certs on
   first start (DNS-01 needs the API token to work; check
   `docker compose logs caddy`).
4. Migrations: `docker compose run --rm backend npm run db:migrate`
   (0017 creates all storefront tables).
5. Verify: `https://ezpos.com` (cert ok), any `https://<subdomain>.ezpos.store`
   (wildcard cert ok; unassigned subdomains show the parked page).

Rollback to nginx: `docker compose stop caddy && docker compose up -d nginx`.
Certificates issued by Caddy are unaffected (stored in the `caddy-data`
volume); certbot renews resume on the next nginx run.

## 5. Tenant domain lifecycle (what happens automatically)

1. Customer creates a store → subdomain `<name>.ezpos.store` is reserved,
   served by the wildcard cert immediately after publish.
2. Customer adds a custom domain → backend issues a TXT verification token
   and the portal shows DNS instructions.
3. Customer clicks **Verify** → backend checks DNS. Verified ≠ connected.
4. First HTTPS visit → Caddy asks the backend (`/api/internal/tls/ask`,
   token-authenticated) which allows only VERIFIED domains → on-demand
   certificate issued → the renderer reports issuance back
   (`/api/internal/storefront/ssl-reported`) → portal badge becomes
   **Connected** (verified + SSL issued). Anything less shows honest
   intermediate states.
5. Primary domain selection: every non-primary host of a tenant 301s to the
   primary (handled in the renderer proxy).
6. Suspension (platform admin or subscription expiry): resolution stops →
   parked page; data retained; reactivation restores instantly.

## 6. Media pipeline

- Portal uploads go **directly** browser → MinIO via presigned PUT.
  `MINIO_API_CORS_ALLOW_ORIGIN` must include the portal origin.
- Public reads: `cdn.ezpos.com → minio:9000` with immutable cache headers;
  the bucket has an anonymous download policy (set by the `minio-init`
  one-shot service).
- Migrating to Cloudflare R2/S3 later: point `S3_*` env at the provider and
  repoint the CDN host — no code changes.

## 7. Monitoring checklist

- `docker compose logs caddy` — certificate issuance errors, ask-endpoint
  failures.
- `docker compose logs storefront` — resolution failures (backend down
  shows as parked pages: alert on parked-page rate).
- Backend `/healthz` — DB liveness (Caddy has no backend health gating;
  a DB outage surfaces as renderer errors).
- Certificate expiry: Caddy renews automatically; wildcard renews via
  DNS-01 30 days before expiry.
