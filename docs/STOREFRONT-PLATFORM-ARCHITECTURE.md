# ezPos Hosted Storefront Platform — Architecture

Status: approved 2026-11-03 (plan approved by product owner). This document is the
implementation contract for the hosted storefront builder & website platform — a
separate product capability inside the ezPos ecosystem. It is NOT Phase 10 and is
NOT the Storefront API / WooCommerce integration work (both already exist and are
reused here).

## 1. Product goal

ezPos customers create, customize, publish, and manage hosted online shops
(`abc-fashion.ezpos.store`, later `www.abcfashion.com`) without writing code.
Every storefront belongs to an existing ezPos business — the business remains the
single source of truth for products, prices, inventory, and orders. No second
catalog, no per-tenant database, no duplicated order logic.

Approved platform decisions:

| Decision | Choice |
| --- | --- |
| Edge / TLS | Caddy on the existing single-VPS Docker Compose stack; on-demand TLS for custom domains, DNS-01 wildcard for `*.ezpos.store` |
| Media storage | S3-compatible API; MinIO container first, Cloudflare R2/S3 later via env swap |
| Renderer | New `ezPosStorefront` Next.js App Router app in-repo (port 3002) |
| Launch themes | 4 real themes (Fashion, Electronics, Grocery, General Retail) on a shared section engine |

## 2. System layout

```
                 ┌── Caddy (edge, automated TLS) ─────────────────────────────┐
 ezpos.com / api.ezpos.com / app.ezpos.com → website:3001 / backend:3000 / pos (unchanged)
 *.ezpos.store + verified custom domains   → ezPosStorefront:3002
                                             │  internal token auth
                                             ▼
                 ezPosBackend (new modules) → Postgres → MinIO (S3 API)
```

- Existing apps are untouched apart from additive backend modules and a new
  "Online Store" section in the customer portal (`ezPosWebsite`).
- The renderer never touches Postgres and never holds customer credentials. It
  calls backend **internal endpoints** authenticated by a shared secret
  (`STOREFRONT_RENDERER_TOKEN`). No per-tenant API keys to manage in the renderer.

## 3. Tenant resolution

`storefronts.subdomain` is the subdomain key under the base domain
(`STOREFRONT_BASE_DOMAIN`, default `ezpos.store`). The renderer middleware:

1. Normalizes the incoming hostname (strip port, lowercase, drop `www.` only for
   the base domain, never for custom domains).
2. Resolves host → tenant via the internal endpoint (in-memory cache, short TTL,
   negative caching for unknown hosts).
3. Loads the **published** storefront version (immutable snapshot) — draft edits
   never affect the live site.
4. Unknown host / not published / suspended → branded parked page. No error leak,
   no cross-tenant content.

Host-header attacks are neutralized because resolution is a strict lookup: any
host that does not match a verified domain or the base domain renders the parked
page. Primary-domain redirects may only target domains verified for the SAME
storefront.

## 4. Data model (new tables, Drizzle, one file per table)

| Table | Purpose |
| --- | --- |
| `storefronts` | Per business: name, unique `subdomain`, `status` (draft/preview/published/suspended/archived), `theme_id`, `draft_config` jsonb, `published_version_id`, SEO, pickup/analytics/indexing flags, `deleted_at` |
| `storefront_publish_versions` | Immutable published config snapshots (version number, config, published_by/at) for diff-free rollback |
| `storefront_domains` | `kind` subdomain/custom, unique domain, `verification_token`, `status` (pending/verified/failed/removed), `is_primary`, `ssl_status`, `last_error` |
| `storefront_pages` | Content pages (about, policies…): slug, title, structured `blocks` jsonb (no arbitrary HTML/JS), SEO |
| `storefront_product_visibility` | Per storefront per product: published, featured, SEO title/description, website images |
| `storefront_media` | Upload metadata: object key, mime, bytes, dimensions, sha256 dedup, per-business S3 prefix |
| `storefront_delivery_zones` | Zones (areas text[]), rate, free-delivery threshold; store pickup on `storefronts` |
| `storefront_payment_methods` | Enabled methods (cod / sslcommerz) + per-storefront config |
| `storefront_analytics_events` | Lightweight beacon events (visit, product view) — rolled up later |

End-consumer tables (`shoppers`, `shopper_sessions`, `shopper_orders`) are added
in the payments/shoppers stage; guest checkout is the default until then.

Tenant integrity follows the existing pattern: composite scoping in queries plus
`business_id` FKs with cascade; the renderer's reads are scoped to published
snapshots only.

## 5. Theme system

- `ThemeDefinition`: id, name, category, description, version, preview images,
  zod `configSchema`, defaults, sections manifest, CSS-variable design tokens
  (colors, typography, radius, container width, card style).
- Theme registry is server-side (renderer) + metadata served to the portal;
  theme availability per plan is admin-managed.
- Homepage = ordered list of section instances (announcement, hero,
  featured-categories, featured-products, best-sellers, new-arrivals,
  promo-banners, testimonials, newsletter). Sections are enabled/disabled,
  reordered, and edited through the portal editor; the config is validated by
  the theme's zod schema on every write, and again at publish.
- Customers never supply executable code — structured config only.

## 6. Domains, DNS, SSL (Caddy)

- Caddy replaces nginx as the edge (nginx config kept for rollback). `on_demand_tls`
  asks `GET /api/internal/tls/ask?domain=…` (token-gated) which allows only
  `*.ezpos.store` and `status='verified'` custom domains.
- Wildcard cert for `*.ezpos.store` via DNS-01 (Caddy DNS provider plugin + API token).
- Custom domain flow: add → backend issues TXT token
  (`_ezpos-verify.<domain>` TXT record) → customer adds DNS → backend verifies →
  status `verified` → Caddy may issue a cert on first request → HTTPS enforced.
  Nothing is ever reported "connected" before verification and issuance.
- Subdomains: validated (DNS-safe naming, reserved words blocked), availability
  checked, changeable while unpublished or on request; duplicates impossible
  (unique index).

## 7. Media

Presigned-upload flow (no proxying bytes through Express):

1. Portal requests `POST …/storefronts/media/presign` (filename, content type, size).
2. Backend validates mime allowlist (jpeg/png/webp), size cap, and the business's
   storage quota (`maxMediaStorageMb`), then returns a SigV4 presigned PUT URL and
   the final object key (`businesses/{id}/storefront/{uuid}.{ext}`).
3. Browser uploads directly to MinIO; the portal then registers the object
   (metadata row) and can attach it to config.
4. Public reads go through the CDN host (`cdn.ezpos.store` → MinIO) with long
   cache headers. Keys are unguessable (uuid); listing/scoping is enforced in the API.

The S3 client is a small dependency-free SigV4 implementation
(`services/objectStorage.ts`) — presign PUT/GET and DeleteObject only. Swapping
MinIO for R2/S3 later is an env change (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL`).

## 8. Commerce & checkout

- The storefront cart is client-side (localStorage) and always revalidated:
  checkout posts line items to the backend, which recomputes prices from the
  catalog, checks availability, creates inventory reservations, and creates a
  `sales` row with `channel='custom_storefront'` through the existing
  `createOnlineOrder` flow (idempotency key required; overselling prevented).
- COD first. Online payment capture (SSLCommerz order sessions, server-side
  verification, IPN handling, `sale_payments` migration) lands in the
  payments stage; orders are never marked paid without trusted verification.
- Delivery charges come from the storefront's zones config, evaluated
  server-side at checkout (never trusted from the client).

## 9. Entitlements & lifecycle

New plan features: `hostedStorefront`, `storefrontCustomDomains`, `premiumThemes`,
`storefrontAnalytics`. New limits: `maxStorefronts`, `maxCustomDomains`,
`maxMediaStorageMb`. All enforced server-side through `services/entitlements.ts`
(advisory-lock pattern for count checks) — the portal UI only hides buttons.

Lifecycle: create → draft → preview → publish (explicit action only) →
suspend (admin or subscription expiry: parked page, data retained) → reactivate →
archive. Expiry suspends storefront serving but never deletes data.

## 10. Security invariants

- Storefront data is isolated per business; every portal route re-derives the
  business from the verified membership (never from client input alone).
- Internal endpoints require the shared token; the TLS-ask endpoint allows only
  verified domains; redirects only to same-storefront verified domains.
- Shopper-facing surface is unauthenticated but rate-limited and read-only
  against published snapshots; beacon endpoint is fire-and-forget and capped.
- Uploads: mime/size allowlist, per-business prefix, quota enforcement; no
  server-side execution of customer content; CSP on the renderer.
- SaaS admin actions on storefronts (suspend/reactivate/theme toggles) are
  audited in `saas_admin_audit`.

## 11. Implementation stages

1. **Backend foundation** — this doc, migrations, `storefronts`/domains/media/
   visibility/zones/payment-methods modules, internal router, entitlements,
   integration tests.
2. **Portal "Online Store" section** — overview, create wizard, customize editor,
   pages, products, navigation, domains, payment/delivery, SEO, settings.
3. **Renderer + themes** — `ezPosStorefront` app, tenant middleware, theme engine,
   4 themes, shopper pages, cart, COD checkout, per-tenant SEO, preview mode.
4. **Publishing, domains, SSL** — version restore, suspension, Caddy cutover,
   custom-domain verification loop, HTTPS.
5. **Online payments + shoppers** — SSLCommerz order capture, payment-status sync,
   optional shopper accounts.
6. **Analytics, SaaS admin, hardening** — beacon + dashboard, admin storefront
   management, security/load passes, runbook, CI.

Every stage ends with: test suites, `tsc`, production builds, migration check,
changed-file list, unresolved issues — then a commit.

## 12. Cost & scaling

Marginal infra on the current single VPS: storefront app + MinIO ≈ 2–4 GB extra
RAM (8 GB tier recommended). Wildcard cert free (DNS-01). No paid services until
R2/CDN is warranted. Scaling constraints: single-host Postgres/MinIO, in-memory
rate limits and resolution cache; the renderer scales horizontally behind Caddy;
shared state moves to Redis when a second renderer instance is added.
