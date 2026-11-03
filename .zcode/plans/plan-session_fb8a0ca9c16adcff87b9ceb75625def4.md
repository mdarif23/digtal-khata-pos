# ezPos Hosted Storefront Builder & Website Platform — Architecture & Stage Plan

## 0. Architecture inspection summary (what exists vs what's new)

**Reusable as-is (built in Phase 9 / SaaS work):**
- Multi-tenant middleware (`requireBusinessAccess`, membership verification, app-level scoping, composite FKs), per-business RBAC.
- Entitlements service (`services/entitlements.ts`) with plan `features`/`limits` jsonb and `requireFeature()`/limit asserts — already contains `storefrontApi`, `customStorefront`, `multipleOnlineStores` flags.
- **Storefront API v1** (`/api/v1/storefront/*`) with scoped `ezpos_pk_/sk_` keys, per-key rate limiting, Origin allowlists.
- **Unified online orders** (`modules/commerce/orders.service.ts`): `sales.channel='custom_storefront'`, two-phase inventory (reservations → confirm consumes FIFO stock), server-side price computation, idempotency keys. Portal orders admin already exists.
- SSLCommerz `PaymentProvider` abstraction (`initiateSession/verifyPayment`) + IPN handling (currently subscription-only).
- `businesses.slug` (unique) — natural subdomain key; `businesses.mode` includes `online_only` (online-only acceptance criterion already supported).
- Jobs scheduler, SaaS audit log, docker-compose + nginx edge, Vitest (website) & node:test (backend) suites (255 backend + 13 website tests green).

**Net-new (no foundation exists):** hosted rendering app, theme system, hostname→tenant resolution, custom-domain verification + automated SSL, media/object storage, storefront cart/checkout UI, shopper-facing pages, per-tenant SEO (sitemap/robots), online-order payment capture, storefront analytics.

**Approved decisions:** Caddy edge on existing VPS (on-demand TLS) · S3-compatible storage, MinIO container first, R2/S3 switchable by env · new Next.js 16 `ezPosStorefront` app in-repo · 4 real themes at launch (Fashion, Electronics, Grocery, General Retail).

## 1. Target architecture

```
                 ┌── Caddy (edge, TLS automation) ────────────────────────────┐
 ezpos.com / api / app.*  →  existing website / backend / pos (unchanged)
 *.ezpos.store + verified custom domains  →  ezPosStorefront:3002
                                             │
                                             ▼ internal token auth
                 ezPosBackend (+ new modules)  →  Postgres  →  MinIO (S3 API)
```

**New app `ezPosStorefront/`** (Next.js 16 App Router, port 3002, separate Dockerfile):
- `middleware.ts` — hostname → tenant resolution (cached in-memory, short TTL; falls back to a parked page for unknown hosts). Host validation rejects non-tenant hosts (host-header attack defense).
- `src/core/tenant/` — resolution + published-config loading; `src/themes/` — registry + 4 themes; `src/components/sections/` — shared section engine; `src/modules/` — catalog, cart, checkout, seo, analytics.
- Pages: home, products list/detail, category, search, cart, checkout, order confirmation + tracking, contact/about/policy content pages. SSR everywhere; per-tenant `generateMetadata`, `sitemap.ts`, `robots.ts` scoped to resolved tenant.
- Renderer ↔ backend: internal endpoints under `/api/internal/storefront/*` authenticated by `STOREFRONT_RENDERER_TOKEN` (mutual shared secret, only renderer may call). Tenant resolution, published config, catalog reads, order creation all go through it — no per-tenant API keys to manage, no renderer DB access.

**New backend modules** (existing conventions: routes/controller/service/validation):
- `storefronts` — site CRUD + config (draft), publish/unpublish (version snapshot), subdomain management, status lifecycle (draft/preview/published/suspended/archived).
- `storefrontDomains` — add custom domain → issue verification token → TXT/CNAME check → verified; primary domain selection; removal; provisioning status surfaced to Caddy.
- `storefrontMedia` — presigned S3 upload flow (POST /presign → client uploads to MinIO → metadata row). Validation: mime allowlist (jpeg/png/webp/svg-later), size caps, per-business key prefix `businesses/{id}/…`, storage quota limit. Optional sharp-based resize later.
- `storefrontAnalytics` — beacon insert endpoint (unauthenticated, rate-limited, tenant-scoped) + portal aggregates.
- Extend `commerce` — checkout endpoint for storefront orders: revalidates prices/stock server-side, creates reservation + `sales` row (`channel='custom_storefront'`), COD confirmation; gateway path in stage 5. Idempotency required.
- `internal` router — token-gated: tenant-by-host lookup, domain allowlist for Caddy's `ask` endpoint.

**New DB migrations** (Drizzle, one file per table, `drizzle/0017…`):
- `storefronts` (business_id FK, subdomain unique, status, theme_id, draft_config jsonb, published_version_id, seo jsonb, deleted_at)
- `storefront_publish_versions` (immutable config snapshots, version n, published_at, published_by)
- `storefront_domains` (storefront_id, domain unique, kind subdomain|custom, verification_token, status pending|verified|failed|removed, is_primary, ssl_status, last_error)
- `storefront_pages` (storefront_id, slug, title, blocks jsonb, seo)
- `storefront_product_visibility` (business_id, product_id, published, featured, seo_title, seo_description, website_images jsonb)
- `storefront_media` (business_id, object_key, mime, bytes, width/height, sha256 dedup)
- `storefront_delivery_zones` (storefront_id, name, areas text[], rate, free_threshold; pickup toggle on storefronts)
- `storefront_payment_methods` (storefront_id, method enum cod|sslcommerz, enabled, config jsonb)
- `storefront_analytics_events` (storefront_id, type, path, product_id nullable, shopper ref, ts) — partitioned/rolled up later
- `shoppers` + `shopper_sessions` + `shopper_orders` (end-consumer accounts; built in stage 5, guest checkout is the default before that)
- Migration for online-order gateway payments (see stage 5; touches `sale_payments` check-constraint area — noted in project quirks, handle with care).

**Entitlements** — new plan features: `hostedStorefront`, `storefrontCustomDomains`, `premiumThemes`, `storefrontAnalytics`; limits: `maxStorefronts`, `maxCustomDomains`, `maxMediaStorageMb`. Enforced only in `entitlements.ts` + route gates; plan editor already renders arbitrary feature/limit keys. Suspension: storefront stopped (parked page) on business suspension or plan downgrade; data retained; reactivation restores.

## 2. Theme system

- `ThemeDefinition` interface: id, name, category, description, version, preview images, `configSchema` (zod), `defaults`, `sections` manifest (hero, announcement, featured-categories, featured-products, best-sellers, new-arrivals, promo-banners, testimonials, newsletter, footer variants), layout/typography skin (CSS-variable tokens: colors, fonts, radius, container width, card style).
- Registry (`themes/registry.ts`) — server-only; admin can enable/disable per plan. Theme config stored as validated JSON (draft + published snapshot) — **no customer code execution anywhere**.
- Shared section engine renders ordered, toggleable homepage sections from config; each theme supplies its own skin + section variants. New categories later = new theme package, no platform rewrite.

## 3. Edge, domains & SSL (Caddy)

- Caddy replaces nginx as edge (nginx conf preserved for reference/rollback): `on_demand_tls` with `ask https://api.ezpos.com/api/internal/tls/ask` (token-gated, returns 200 only for `*.ezpos.store` + verified `storefront_domains`).
- `*.ezpos.store` wildcard via DNS-01 (Caddy DNS plugin for the platform's DNS provider — needs one API token in env). Custom domains via on-demand HTTP-TLS after verification.
- Domain flow: customer adds domain → backend generates verification token → DNS instructions shown (CNAME) → backend polls/verifies → status becomes `verified` → Caddy `ask` allows it → cert issued on first request. Status never claimed "connected" before verification + issued cert. Primary-domain redirects handled in renderer middleware (only to verified own domains).

## 4. Media

MinIO container in docker-compose (single volume), S3 API. `storefrontMedia` service: presigned PUT, server-side validation + quota check, public read via Caddy `cdn.ezpos.store` → MinIO (cache headers) or presigned GET. Env swap to Cloudflare R2 later = S3 endpoint/keys change only.

## 5. Implementation stages (verify-then-commit after each: tests, tsc, builds, migration check, changed-file list, unresolved issues)

**Stage 1 — Backend foundation.** Architecture doc (`docs/STOREFRONT-PLATFORM-ARCHITECTURE.md`), all migrations above, `storefronts` module (CRUD, subdomain availability/naming rules, publish/versioning, entitlement + limit enforcement), media service + presigned endpoints (MinIO in compose), product-visibility endpoints, delivery zones, payment-method config, internal token router + domain-allowlist endpoint. Backend integration tests: CRUD, entitlements/limits, tenant isolation (business A cannot read/write B's storefront/media/domains), publish snapshots.

**Stage 2 — Portal "Online Store" section** (ezPosWebsite `/account/online-store/*`, NAV entry, API client per conventions): Store Overview dashboard (status, URL, domain, template, orders, product count, last published), Create Store wizard (template picker + preview), Customize (theme config editor: tokens + homepage sections reorder/toggle/edit, image pick from media library), Pages editor, Products publishing (visibility/SEO per product), Navigation, Domain Settings (instructions + status), Payment & Delivery settings, SEO Settings, Store Settings. Vitest for API clients + pure logic.

**Stage 3 — Storefront renderer + themes.** App scaffold, tenant middleware + resolution caching, theme engine + 4 themes, all shopper pages, cart (localStorage-persisted, server-revalidated), checkout (COD; stock/price revalidation server-side; reservation → order), order confirmation + lookup/tracking, per-tenant SEO (metadata, sitemap, robots, Product/Breadcrumb JSON-LD), image handling, preview mode (draft config behind signed preview token). Responsive/mobile-first.

**Stage 4 — Publishing, domains, SSL.** Publish/unpublish flow (never auto-publish), version restore, suspension/parked pages, subdomain change with availability check, custom-domain verification loop, Caddy integration + wildcard cert, HTTPS enforcement, domain status surfacing.

**Stage 5 — Online payments + shoppers.** Extend PaymentProvider use to orders: SSLCommerz order sessions, server-side verify, IPN/callback handling, payment-status sync on sales (migration for `sale_payments`/order payments), no paid-without-verification. Optional shopper accounts (`shoppers` tables) + guest-vs-account toggle per storefront.

**Stage 6 — Analytics, SaaS admin, hardening.** Analytics beacon + portal dashboard (visits, product views, orders, conversion, best sellers, revenue — labeled tracked vs estimated), saas-admin storefronts list/suspend/reactivate/domain errors/theme management (all audited), rate limiting review, cross-tenant security test pass, load smoke test, docs (runbook, DNS, costs), CI wiring for the new app.

## 6. Cost & scaling notes

Marginal infra on the current single VPS: ~2–4 GB extra RAM (storefront app + MinIO) — likely needs the VPS upgraded to 8 GB tier; wildcard cert free via DNS-01; no paid services until R2/CDN later. Scaling constraints documented honestly: single-host Postgres/MinIO, in-memory rate limits, single renderer instance (Next.js scales horizontally behind Caddy when needed; shared-state moves to Redis then).

## 7. Guardrails (from the brief)

POS app and existing backend behavior untouched (255-test suite is the regression gate); ezPos business stays source of truth (no second catalog); no cost/supplier data exposure through storefront endpoints; no arbitrary HTML/JS from customers (structured blocks only); nothing marked connected/paid without verification; POS functionality verified unaffected at every stage.