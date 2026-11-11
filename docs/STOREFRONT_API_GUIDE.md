# Using the ezPos Storefront API from a Custom Website

This guide explains how to connect **your own website** (not the hosted
storefront) to ezPos: show products, check stock, and submit orders through
the public Storefront API v1, and receive order events via webhooks.

Everything here is verified against the backend code
(`ezPosBackend/src/modules/storefront/`, `src/modules/webhooks/`).

---

## 1. Prerequisites (all enforced server-side)

| Requirement | Where to set it | What fails otherwise |
|---|---|---|
| Plan feature `storefrontApi` ON | SaaS Admin → `/saas-admin/plans` → edit plan → Features (the **pro** plan ships with it; **basic** does not) | Key creation → 403 |
| Business mode `online_only` or `omnichannel` | Account → Integrations → mode selector | Every v1 call → 403 "not configured for online sales" |
| Subscription `active` or `trialing` | Account → Billing | Key management → 403 (read-only) |
| `advancedWebhooks` feature ON (only if you also want webhooks) | Same plans editor | Webhook endpoints → 403 |

---

## 2. Create your API keys

In the portal (**Account → Integrations → API keys**), or with the API:

```
POST /api/businesses/{businessId}/storefront/keys
Authorization: Bearer <your portal access token>
X-Business-Id: {businessId}
{ "name": "my website", "scopes": ["products:read","inventory:read","orders:read","orders:write"] }
```

Response — **the secret is shown exactly once** (only a SHA-256 hash is
stored; losing it means creating a new key):

```json
{ "success": true, "data": { "id": 7, "publishableKey": "ezpos_pk_…", "secretKey": "ezpos_sk_…" } }
```

Two key types, and the backend enforces the split:

| | Publishable `ezpos_pk_…` | Secret `ezpos_sk_…` |
|---|---|---|
| Where it lives | In the browser (your React/Vue/HTML JS) | On your server only — never in browser code |
| Allowed scopes | `products:read`, `inventory:read` **only** (hard-coded, regardless of what you select) | All four scopes |
| For | Catalog + stock display | Order submission + order status |
| Extra | Optional `allowedDomains` (max 10) — requests whose `Origin`/`Referer` doesn't match are rejected 403 | — |

Other key operations: `GET …/storefront/keys` (list), `POST …/storefront/keys/{keyId}/revoke`
(revocation is immediate — every request re-reads the key row).

---

## 3. Call the API

Base URL: `http://localhost:3000/api/v1/storefront` (backend).
Auth header on every call: `Authorization: Bearer ezpos_pk_…` or `ezpos_sk_…`.

All responses use the envelope `{ "success": true, … }`; failures are
`{ "success": false, "message": "…" }` with **no** `data` key.

### 3.1 Catalog (publishable key is enough)

```
GET /products?search=mug&categoryId=3&brandId=1&sort=price_asc&page=1&pageSize=20
GET /products/{productId}
GET /categories
GET /brands
```

- `sort` ∈ `newest | price_asc | price_desc | name`; `pageSize` max 50.
- Only products with status `active` are returned.
- List response: `{ success, products: [...], total, page, pageSize }`;
  single/category/brand responses use `{ success, data: ... }`.

### 3.2 Live stock (publishable key)

```
GET /inventory?variantIds=12,13,14
```

Response: `{ "success": true, "data": { "availability": { "12": 5, "13": 0 } } }`
— available-to-sell numbers (stock minus active reservations; channel
allocations apply if the key belongs to a WooCommerce integration).
Max 200 variant ids per call. Order by these ids, not by product id.

### 3.3 Submit an order (secret key, from your server)

```
POST /orders
Authorization: Bearer ezpos_sk_…
Idempotency-Key: 9f1c2a34-77ab-4c2e-9d30-1f6e0a55b123     ← REQUIRED, 8–120 chars
Content-Type: application/json

{
  "lines": [ { "variantId": 12, "quantity": 2 } ],
  "customer": { "name": "Karim Uddin", "phone": "01712345678", "address": "Dhanmondi, Dhaka" },
  "paymentMethod": "cash_on_delivery",
  "note": "Ring the bell twice",
  "externalOrderId": "my-site-1042",
  "locationId": 2
}
```

Rules and responses:

- `Idempotency-Key` is **mandatory**. Retrying the same key returns the same
  order with `"duplicated": true` — so network retries never create double
  orders. Generate one UUID per checkout attempt (retry the SAME one on
  timeout/5xx).
- `quantity` is an integer 1–999 per line; `variantId` must be a variant, not
  a product id.
- `paymentMethod`/`note`/`externalOrderId`/`locationId` are optional.
- `201` → `{ "data": { "orderId": 523, "invoiceNumber": "INV-…", "status": "pending", "total": "1450.00", "currency": "BDT", "duplicated": false } }`
- `409` → insufficient online stock (message names the variant) — show it and
  let the shopper adjust.
- `400` → serial-tracked items cannot be sold through the API; also
  batch-tracked items need available batches or you get the stock error.
- What happens inside: the order is created **pending** and the stock is
  **reserved** (two-phase). You (the merchant) confirm it in **Account →
  Orders** — confirmation deducts stock; cancelling releases the reservation.

### 3.4 Order status (secret key)

```
GET /orders/{orderId}      →  { "data": { "id":523, "invoiceNumber":"INV-…", "status":"pending",
                                "paymentStatus":"unpaid", "fulfillmentStatus":"unfulfilled",
                                "total":"1450.00", "createdAt":"…" } }
```

Only orders created through channels `custom_storefront` / `woocommerce` are
visible here — POS sales are never exposed.

---

## 4. Recommended architecture for a custom website

```
Browser (shopper)                      Your server                    ezPos backend
─────────────────                      ───────────                    ─────────────
catalog/inventory  ── ezpos_pk_… ─────────────────────────────────▶  /products /inventory
checkout form ──────▶ POST /api/checkout ── ezpos_sk_… + Idempotency-Key ─▶ POST /orders
webhook receiver ◀──────────────────────────────────────────────────  POST your URL (signed)
```

1. Browser page loads catalog with the **publishable** key (optionally
   restricted with `allowedDomains` to your domain).
2. On checkout, the browser calls **your** server; your server validates the
   cart server-side and submits the order with the **secret** key.
3. You confirm/fulfill the order in the ezPos portal; your webhook receiver
   gets `order.created`, `order.paid`, etc. to update the customer's order
   page.

Minimal Node server for step 2 (Express):

```js
app.post("/api/checkout", express.json(), async (req, res) => {
  const idempotencyKey = req.body.checkoutToken; // one UUID per attempt, reused on retry
  const r = await fetch("http://localhost:3000/api/v1/storefront/orders", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.EZPOS_SECRET_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ lines: req.body.lines, customer: req.body.customer }),
  });
  const body = await r.json();
  if (!body.success) return res.status(r.status).json(body); // 409 stock → show message
  res.json({ orderId: body.data.orderId, total: body.data.total });
});
```

---

## 5. Webhooks — get notified of order changes

1. Run a receiver that answers `POST` with any 2xx within 10 seconds.
2. **Account → Webhooks → Create endpoint**: paste the URL, pick events —
   `order.created`, `order.paid`, `order.cancelled`, `order.shipped`,
   `order.delivered` (or `*` for all). The **signing secret is shown once**.
3. ezPos POSTs this envelope; the signature covers the **raw** request body:

```
X-Ezpos-Event: order.paid
X-Ezpos-Signature: sha256=8f4a…        ← HMAC-SHA256(rawBody, endpointSecret)

{ "event": "order.paid", "data": { "orderId": 523, … }, "timestamp": "2026-11-11T…" }
```

Verify before trusting:

```js
const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-ezpos-signature"]))) {
  return res.status(401).end();
}
```

Also check `timestamp` is recent (e.g. 5 minutes) on your side — signature
authenticates the body, freshness is your check.

4. Delivery behaviour: attempts up to 5 (per endpoint), exponential backoff
   15s → 30s → … capped at 1 hour; after the last failure the delivery is
   dead-lettered and the business is notified. Inspect every attempt in
   **Account → Webhooks → endpoint → deliveries** (`GET …/webhooks/{endpointId}/deliveries`).
   `POST …/webhooks/{endpointId}/test` sends a sample `order.created` to
   verify your wiring end to end.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 401 "A storefront API key is required" | Missing/garbled `Authorization: Bearer` header | Send the full `ezpos_pk_/ezpos_sk_` value |
| 401 "invalid or has been revoked" | Key revoked, or secret mistyped (hash never matches twice) | Create a new key |
| 403 "does not have the 'orders:write' scope" | Used the publishable key for orders | Publishable keys can never order — use `ezpos_sk_…` from your server |
| 403 "origin is not allowed" | `allowedDomains` set and the site's Origin doesn't match | Add the exact domain, or clear the restriction |
| 403 "not configured for online sales" | Business mode is `physical_only` | Account → Integrations → switch mode |
| 400 "Idempotency-Key header … required" | Header missing or shorter than 8 chars | Send a UUID |
| 409 insufficient online stock | Not enough sellable stock after reservations | Restock or lower quantity; message names the variant |
| 429 | >600 requests/min on one key | Raise `STOREFRONT_RATE_LIMIT_PER_MINUTE` on the backend, or back off |
| Webhook never arrives | `JOBS_ENABLED` off, receiver not 2xx, or feature not on plan | Backend jobs must run for deliveries to be processed; check the deliveries tab |

## 7. Localhost notes

- All URLs above assume the backend on `http://localhost:3000`.
- The `environment` field you may see on keys (test/live) is **not used yet** —
  one key set serves both for now.
- Rate limiting is in-memory per backend process — restarting the backend
  resets counters (dev convenience, known production limitation).
