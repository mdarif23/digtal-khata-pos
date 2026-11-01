# POS Gap Closure Tracker

Live status of the ezPos gap-closure program (master prompt, Phase 0 audit done
2026-11-01). Audit basis: repo @ `1fb720f` on `development`; work happens on
`refactor/pos-gap`.

Status vocabulary: **Complete** · **Partial** · **Missing** · **Defective** ·
**B→F incomplete** (backend done, frontend unwired) · **F→B incomplete**.

| Module | Feature | Audit status | Phase | Backend | Frontend | Database | Tests | Remaining gap |
|---|---|---|---|---|---|---|---|---|
| 1 Checkout | Product search / SKU / barcode | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 1 Checkout | Cart, variants, discounts, checkout | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 1 Checkout | Held sales (retrieve/share) | F→B incomplete | 2 | ❌ localStorage only | ✅ | ❌ | ❌ | Server `held_sales` table + APIs; cross-register sharing |
| 1 Checkout | Duplicate-submission prevention | B→F incomplete → **fixed** | **1** ✅ | ✅ replay + `onConflictDoNothing` | ✅ key sent, retry-safe | ✅ composite unique (0015) | unit 61/61, integration (see log) | — |
| 1 Checkout | Cart expiry / cleanup, cart audit | Missing | 2 | ❌ | ❌ | ❌ | ❌ | — |
| 1 Checkout | Active-cart recovery after refresh | **Defective** (audit correction: only held carts persist) | 2 | n/a | ❌ main cart store not persisted | n/a | ❌ | Persist cart store (with Phase 2 offline work) |
| 2 Inventory | Adjustments / transfers / receiving | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 2 Inventory | Batch & serial tracking | Complete | — | ✅ FEFO locking | ✅ | ✅ | integration | — |
| 2 Inventory | Barcode stocktaking + cycle counts | Missing | 3 | ❌ | ❌ | ❌ | ❌ | `stock_count_sessions/lines`, approval flow |
| 2 Inventory | Replenishment / reorder suggestions | Missing | 3 | ❌ | ❌ | ❌ | ❌ | min/max/reorder config, suggestion engine |
| 2 Inventory | Aging, dead-stock, valuation reports | Partial | 3 | ❌ | 4 stock reports exist | — | ❌ | aging/dead-stock reports |
| 3 Payments | Manual methods (cash/card/bKash-QR), split, dues | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 3 Payments | Provider architecture for **sale** payments | Missing | **1** | ⚠️ exists for subscriptions only | ❌ | ❌ | ❌ | Generalize `PaymentProvider` layer to sales |
| 3 Payments | Sale payment webhooks / reconciliation / settlement | Missing | **1** | ❌ | ❌ | ❌ | ❌ | — |
| 3 Payments | bKash / Nagad / ShurjoPay providers | Missing | **1** | ❌ | ❌ | ❌ | ❌ | Per official provider docs |
| 3 Payments | Payment reference uniqueness | **Defective** | **1** | ⚠️ global UNIQUE across tenants | — | migration | ❌ | Composite `(business_id, method, reference)` |
| 4 Tax | Configurable tax engine (rates, product assignment, inclusive pricing) | Missing | **1** | ❌ (sale-level manual VAT only) | ❌ | ❌ | ❌ | `tax_rates` + `product_taxes`, server-side calc |
| 4 Tax | Historical tax preservation | Partial | 1 | ✅ snapshot on sale | ✅ | ✅ | — | Retain rule reference |
| 5 Returns | Full / partial returns, reasons, dispositions | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 5 Returns | Exchanges | Missing | **1** | ❌ | ❌ | ❌ | ❌ | Exchange tx type + difference settlement |
| 5 Returns | Refund methods (store credit, provider refund) | Missing | **1** | ❌ | ❌ | ❌ | ❌ | Depends on Ph1 payments |
| 6 Promotions | Sale-level fixed / % discounts | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 6 Promotions | Coupons, scheduled promos, BOGO, stacking, groups | Missing | 4 | ❌ | ❌ | ❌ | ❌ | — |
| 7 Loyalty | Points / gift cards | Missing | 4 | ❌ | ❌ | ❌ | ❌ | Ledger tables; transactional balances |
| 8 Staff | Users / roles / permissions | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 8 Staff | Timeclock / attendance / shifts | Missing | 4 | ❌ | ❌ | ❌ | ❌ | — |
| 9 Hardware | Browser printing + receipt settings | Complete | — | n/a | ✅ | n/a | ❌ | Fallback path done |
| 9 Hardware | ESC/POS, USB/Serial/BT, drawer, scale, customer display | Missing | 5 | n/a | ❌ | n/a | ❌ | Behind hardware abstraction layer |
| 10 Offline | Offline checkout + sync outbox | Missing | 2 (critical) | ❌ | ❌ | ❌ | ❌ | IndexedDB + SW + durable outbox; idempotent sync |
| 11 Multi-loc | Locations, transfers, registers, location RBAC/reports | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 11 Multi-loc | Real-time register sync, health monitoring | Missing | 2 | ❌ (no WS/SSE) | ❌ | ❌ | ❌ | — |
| 12 Omnichannel | Catalog, reservations, order sync, webhooks, entitlements | Complete (Ph9) | — | ✅ | ✅ | ✅ | integration | Customer sync pending |
| 12 Omnichannel | Shopify adapter | Missing | 6+ | ❌ | n/a | ❌ | ❌ | Adapter interface ready |
| 12 Omnichannel | Store URL validation (SSRF) | **Defective** | **1** | ❌ user-supplied URL unvalidated | — | — | ❌ | https-only + private-range block |
| 13 Restaurant | Menus, modifiers, tables, KDS | Missing | 7 | ❌ | ❌ | ❌ | ❌ | Greenfield module |
| 14 Notifications | Notification center | Missing | 5 | ❌ | ❌ | ❌ | ❌ | Event-driven generation |
| 15 Reports | 20 report pages incl. profit/tax/regr | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 15 Reports | Forecasting, CLV, channel reports, exports | Missing/Partial | 8 | ❌ | partial | — | ❌ | CSV/Excel export to verify |
| Security | RBAC + tenant isolation, encrypted credentials, webhook HMAC | Complete | — | ✅ | ✅ | ✅ | integration | — |
| Security | General audit log (beyond saasAdmin) | Missing | **1** | ❌ | ❌ | ❌ | ❌ | `audit_log` table + service |
| Security | Secrets in git history | **Defective** | 0.5 | — | — | — | — | Untracked in 0.5; history purge needs maintainer decision |
| Reliability | Concurrent idempotent replay returns 500 | **Defective** → **fixed** | **1** ✅ | ✅ `onConflictDoNothing` + refetch in both insert paths | — | ✅ 0015 | integration | — |

## Phase plan (adjusted after audit)

- **0.5** — repo hygiene: untrack `.env` + `node_modules`, rotate JWT secret. History purge deferred (needs force-push decision).
- **1** — financial reliability: sale-payment provider architecture, tax engine, exchanges/refund methods, audit log, POS idempotency wiring, replay-500 fix, payment-reference constraint fix, SSRF validation.
- **2** — offline POS (critical) + shared held sales + real-time registers.
- **3** — stocktaking, cycle counts, replenishment, inventory analytics.
- **4** — loyalty, gift cards, promotions, attendance.
- **5** — hardware abstraction + notification center.
- **6** — omnichannel remainder (customer sync; Shopify later). ~85% already shipped in Phase 9.
- **7** — restaurant module (greenfield).
- **8** — analytics, forecasting, hardening, production readiness.

## Progress log

- **2026-11-01** — Phase 0 audit complete (see conversation report). Branch `refactor/pos-gap` created. Tracker initialized.
- **2026-11-01** — Phase 0.5 complete: untracked `.env` + `node_modules` (5,073 files), rotated `AUTH_JWT_SECRET` locally. History purge deferred (needs coordinated force-push decision).
- **2026-11-01** — Phase 1 slice 1 (idempotent checkout) complete:
  - Migration `0015`: global `sales.idempotency_key` unique → composite `(business_id, idempotency_key)` (per-tenant keys no longer collide).
  - `sales.service.createSale`: accepts optional `idempotencyKey`, pre-check replay, `onConflictDoNothing` + refetch for the concurrent race; replay responses re-derive `paidAmount`/`change` from stored payments.
  - `orders.service.createOnlineOrder`: same conflict handling — concurrent duplicate now returns the original order instead of a 500.
  - POS frontend: `useCartStore.beginCheckout()` claims a UUID per checkout; retries reuse it; `resetCart()` clears it; `PosPage` sends the key on every submit.
  - Verification: backend tsc clean, unit 61/61, integration 227/246 — the 19 failures are pre-existing (reproduced without these changes; all in saas-admin/support/portal/storefront-subscription areas, none in sales/checkout). POS tsc clean, `vite build` green. Migration applied to local `ezPos` + `ezpos_test`.
  - Audit correction: active-cart recovery does NOT exist — only held carts persist to localStorage; the main cart store is memory-only. Tracked above, slated for Phase 2.
