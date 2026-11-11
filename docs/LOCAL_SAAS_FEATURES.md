# Running Online Store, Integrations and Webhooks on localhost

This guide covers the three omnichannel features of ezPos on a single
development PC:

1. **Online Store** — the hosted storefront (`ezPosStorefront`, port 3002)
   that shoppers browse and order from.
2. **Integrations** — WooCommerce connection (product/order sync).
3. **Webhooks** — outbound, HMAC-signed order events delivered to any URL.

All three are gated per-plan and per-business-mode; everything enforces
server-side, so the steps below include the exact backend behavior to expect.

---

## 0. Prerequisites

| Requirement | Where to set it | Notes |
|---|---|---|
| Active subscription on a plan **with the features** | SaaS Admin → `/saas-admin/plans` → edit plan → Features | The **pro** plan ships with every feature on. `basic` has none. Required keys: `storefrontApi` + `hostedStorefront` (online store), `woocommerceIntegration` (WooCommerce), `advancedWebhooks` (webhooks) |
| Subscription status `active` or `trialing` | — | Expired/canceled plans are read-only. A plan change on a lapsed business raises a **pending invoice** — pay it from **Account → Billing → Pay now**; the backend verifies server-side and only then reactivates |
| Business **mode** = `omnichannel` (or `online_only`) | Account → Integrations → business mode selector | `physical_only` blocks storefront ordering and integrations. Switching to `omnichannel` auto-creates an `Online Store` location |

Backend `.env` extras for local work:

```env
# Opt-in: allow connecting WooCommerce stores on private/loopback hosts
# (your local WordPress). NEVER set in production — this disables part of
# the SSRF guard for the store URL.
ALLOW_PRIVATE_STORE_URLS=1
```

---

## 1. Online Store (hosted storefront)

**Apps:** backend :3000 + `ezPosStorefront` renderer :3002.

### Steps

1. **Create the store** — Account → Online store → pick a theme, choose a
   subdomain (e.g. `akhmu`), create. Status starts as *draft*.
2. **Publish** — the storefront only resolves for shoppers once published
   (the backend keeps draft and published versions separate; publish
   snapshots are re-validated at publish time).
3. **Run the renderer** — in `ezPosStorefront/`:

   ```bash
   npm install
   # .env (already local): BACKEND_URL + STOREFRONT_RENDERER_TOKEN must match
   # the backend's values; add the dev subdomain line:
   echo "STOREFRONT_DEV_SUBDOMAIN=akhmu" >> .env
   npm run dev        # serves on http://localhost:3002
   ```

4. **Browse as a shopper** — open `http://localhost:3002/`. The renderer's
   edge (`src/proxy.ts`) sees a localhost host, swaps in
   `STOREFRONT_DEV_SUBDOMAIN`, and asks the backend
   (`GET /api/internal/storefront/resolve?host=…`, authenticated by
   `x-internal-token`) which tenant it is. Unresolved hosts land on a
   branded parked page — never another tenant's store.
5. **Place a test order** — add a product to the cart, pick store pickup or
   a delivery zone (fees are computed server-side), check out. The order is
   created with status *pending* and stock is reserved.
6. **Fulfill** — Account → Orders: the online order appears alongside POS
   sales. Confirm it (stock is deducted and the reservation released), mark
   it paid (COD) or process the payment, or cancel it (reservation released).

### Notes

- The storefront catalog comes from the POS catalog — products must be
  `active` with online-visible stock.
- A batch-tracked product needs inventory batches, or checkout fails with an
  availability error (by design).
- Without `STOREFRONT_DEV_SUBDOMAIN` set, `localhost:3002` cannot resolve a
  tenant and will show the parked page.

---

## 2. WooCommerce Integration

**Requires:** a running WooCommerce store (WordPress + the WooCommerce
plugin) with REST keys (read/write), and `ALLOW_PRIVATE_STORE_URLS=1` on the
backend when the store runs on a private host.

### Local WooCommerce in one command (Docker)

```bash
docker run -d --name ezpos-woo -p 8080:80 \
  -e WORDPRESS_DB_HOST=ezpos-woo-db \
  -e WORDPRESS_DB_USER=wp -e WORDPRESS_DB_PASSWORD=wp-pass \
  -e WORDPRESS_DB_NAME=wp \
  --network ezpos-woo-net wordpress:latest
docker network create ezpos-woo-net 2>nul
docker run -d --name ezpos-woo-db --network ezpos-woo-net \
  -e MYSQL_DATABASE=wp -e MYSQL_USER=wp -e MYSQL_PASSWORD=wp-pass \
  -e MYSQL_ROOT_PASSWORD=root-pass mysql:8
# Finish WP setup at http://localhost:8080, install + configure WooCommerce,
# then create REST keys: WooCommerce → Settings → Advanced → REST API
# (permissions: Read/Write).
```

### Connect

1. Account → Integrations → business mode `omnichannel` (selector at the top).
2. Enter the store URL, consumer key and consumer secret → **Connect**.
   The backend validates the credentials against the real store **before**
   persisting anything, registers an `order.updated` webhook on the WC side,
   and encrypts the secrets (AES-256-GCM).
3. **Sync products** — pushes unmapped POS products to WooCommerce and keeps
   stock in sync (push runs every ~5 minutes; failures retry with backoff).

### Order flow

- A WooCommerce order webhook (`order.updated`, HMAC-verified over the raw
  body with the per-integration secret) creates a *pending* ezPos sale and
  reserves stock; `processing` webhooks confirm immediately.
- Refunds sync OUT to WooCommerce automatically (full refund → WC order
  status `refunded`).
- Customer matching is by normalized phone, then email.

---

## 3. Webhooks (outbound)

**Requires:** the `advancedWebhooks` plan feature. Events currently fire on
the online-order lifecycle: `order.created`, `order.paid`, `order.cancelled`.

### Steps

1. **Stand up a receiver** — anything that answers `POST` with 2xx. For a
   quick local listener:

   ```bash
   node -e "require('http').createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{console.log(req.headers['x-ezpos-signature']);console.log(JSON.parse(b).event?.type ?? b);res.end('ok')})}).listen(9090)"
   ```

   (Or use webhook.site and paste its URL.)
2. Account → Webhooks → **Create endpoint** → paste the URL, select events
   (`order.created`, `order.paid`, `order.cancelled`). The signing secret is
   shown **once** — store it.
3. **Trigger** — place a test online order (storefront or WooCommerce). The
   backend enqueues a signed delivery per subscribed event.
4. **Verify the signature** — `X-Ezpos-Signature: sha256=<hex>` is HMAC-SHA256
   over the raw request body with the endpoint's signing secret:

   ```js
   const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");
   ```

5. **Inspect deliveries** — Account → Webhooks → endpoint → deliveries (each
   shows attempts, response status, last error). Failures retry 5 times with
   exponential backoff, then dead-letter.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Integrations/Webhooks page shows a warning banner | Plan feature gate (403) | Add the feature keys to the plan (SaaS Admin → Plans) |
| `change-plan`/`renew` 404 on Account → Subscription | The subscription was swept to `expired`/`canceled` and is no longer "open" | Fixed in the current code — the lapsed-recovery path raises the invoice and reactivates on payment. If you still see 404, the backend hasn't reloaded |
| WooCommerce connect fails with "must point at a public host" | SSRF guard rejects private/loopback hosts by default | Set `ALLOW_PRIVATE_STORE_URLS=1` on the backend (dev only) |
| WooCommerce connect fails with DNS/resolve errors | WordPress container not reachable at the URL you entered | Use the Docker network name (`http://ezpos-woo:80`) or `http://localhost:8080` as appropriate |
| Storefront shows the parked page | Host not resolved, or store not published | Publish the store; set `STOREFRONT_DEV_SUBDOMAIN` in `ezPosStorefront/.env`; check the backend is on :3000 |
| Storefront checkout fails on availability | No batches for batch-tracked products, or no stock | Give the variant opening stock or batches via POS |
| Webhook deliveries dead-letter | Receiver not answering 2xx | Check the receiver; deliveries retry 5× then dead-letter (visible in the endpoint view) |

---

## Environment variable reference (local)

| App | Variable | Purpose |
|---|---|---|
| backend | `ALLOW_PRIVATE_STORE_URLS=1` | Dev-only: allow private/loopback WooCommerce URLs |
| backend | `STOREFRONT_BASE_DOMAIN` | Base domain shopper subdomains live under (default `ezpos.store`) |
| backend | `STOREFRONT_RENDERER_TOKEN` | Shared secret for `/api/internal/*` (renderer + Caddy). Dev fallback exists; required in production |
| backend | `JOBS_ENABLED` / `JOBS_INTERVAL_MINUTES` | Subscription/checkout sweeps |
| storefront | `BACKEND_URL` | Backend the renderer talks to (default `http://localhost:3000`) |
| storefront | `STOREFRONT_RENDERER_TOKEN` | Must match the backend value |
| storefront | `STOREFRONT_DEV_SUBDOMAIN` | Subdomain used when browsing via localhost:3002 |
| storefront | `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN` | Informational base domain |
