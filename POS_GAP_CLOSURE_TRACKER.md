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
| 1 Checkout | Server-authoritative checkout totals (tax consistency) | Missing → **Complete** | **1** ✅ | ✅ `POST /sales/quote` | ✅ quote-backed totals hook, local fallback | — | integration | — |
| 1 Checkout | Cart expiry / cleanup, cart audit | Missing | 2 | ❌ | ❌ | ❌ | ❌ | — |
| 1 Checkout | Active-cart recovery after refresh | **Defective** (audit correction: only held carts persist) | 2 | n/a | ❌ main cart store not persisted | n/a | ❌ | Persist cart store (with Phase 2 offline work) |
| 2 Inventory | Adjustments / transfers / receiving | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 2 Inventory | Batch & serial tracking | Complete | — | ✅ FEFO locking | ✅ | ✅ | integration | — |
| 2 Inventory | Barcode stocktaking + cycle counts | Missing | 3 | ❌ | ❌ | ❌ | ❌ | `stock_count_sessions/lines`, approval flow |
| 2 Inventory | Replenishment / reorder suggestions | Missing | 3 | ❌ | ❌ | ❌ | ❌ | min/max/reorder config, suggestion engine |
| 2 Inventory | Aging, dead-stock, valuation reports | Partial | 3 | ❌ | 4 stock reports exist | — | ❌ | aging/dead-stock reports |
| 3 Payments | Manual methods (cash/card/bKash-QR), split, dues | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 3 Payments | Provider architecture for **sale** payments | Missing → **Partial** | **1** 🔄 | ✅ intent layer + per-business configs + SSLCommerz adapter + verify/IPN + reconciliation fields | ✅ due collection via QR/Card (gateway redirect → server-verified return) | ✅ 0018 | integration 10/9→10 | Provider admin UI; bKash/Nagad adapters (blocked on official docs + merchant credentials) |
| 3 Payments | Sale payment webhooks / reconciliation / settlement | Missing | **1** | ❌ | ❌ | ❌ | ❌ | — |
| 3 Payments | bKash / Nagad / ShurjoPay providers | Missing | **1** | ❌ | ❌ | ❌ | ❌ | Per official provider docs |
| 3 Payments | Payment reference uniqueness | **Defective** → **fixed** | **1** ✅ | ✅ ConflictError mapping updated | — | ✅ 0016 composite unique | integration | — |
| 4 Tax | Configurable tax engine (rates, product assignment, inclusive pricing) | Missing → **Partial** | **1** 🔄 | ✅ rules engine (exclusive/inclusive/exempt, effective dates, location scope, server-side calc) | ✅ checkout shows server-quoted totals + per-line tax on receipts | ✅ 0019 | integration 10/10 | Tax-rate settings UI + product-tax assignment UI; customer-specific treatment (future) |
| 4 Tax | Historical tax preservation | Partial → **Complete (backend)** | 1 ✅ | ✅ per-line snapshot (id/name/rate/mode/amount) | receipt carries breakdown | ✅ tax_detail | integration | — |
| 5 Returns | Full / partial returns, reasons, dispositions | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 5 Returns | Exchanges | Missing → **Complete** | **1** ✅ | ✅ atomic refund + linked replacement sale + difference settlement | ✅ exchange dialog (returns + replacement picker + live difference via quote) | ✅ 0020 | integration 8/8 | Serial-tracked replacements (v1 rejects) |
| 5 Returns | Refund methods (cash, provider refund) | Missing → **Partial** | **1** 🔄 | ✅ cash + original_payment (ledger-first, retryable payout; mock + SSLCommerz documented API) | ❌ UI pending | ✅ refund_method/provider_refund_id | integration | Store credit + customer balance (credit ledger — follow-up slice) |
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
| 12 Omnichannel | Store URL validation (SSRF) | **Defective** → **fixed** | **1** ✅ | ✅ `assertPublicStoreUrl` at connect (https-required in prod, private-range + DNS checks) | — | — | unit | — |
| 13 Restaurant | Menus, modifiers, tables, KDS | Missing | 7 | ❌ | ❌ | ❌ | ❌ | Greenfield module |
| 14 Notifications | Notification center | Missing | 5 | ❌ | ❌ | ❌ | ❌ | Event-driven generation |
| 15 Reports | 20 report pages incl. profit/tax/regr | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 15 Reports | Forecasting, CLV, channel reports, exports | Missing/Partial | 8 | ❌ | partial | — | ❌ | CSV/Excel export to verify |
| Security | RBAC + tenant isolation, encrypted credentials, webhook HMAC | Complete | — | ✅ | ✅ | ✅ | integration | — |
| Security | General audit log (beyond saasAdmin) | Missing → **Partial** | **1** 🔄 | ✅ `audit_log` + `services/audit.ts`; wired: sale.create, sale.refund_item, sale.refund_sale, subscription.payment.verified | ❌ no viewer UI yet | ✅ 0017 | integration (22 entries in test run) | Wire register close, stock adjustments, integration changes; portal viewer |
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
- **2026-11-01** — Phase 1 slices 2-4 complete:
  - **Slice 2 — payment references per business** (migration `0016`): global `UNIQUE(payment_method, reference)` on `sale_payments` → composite `(business_id, payment_method, reference)`. Resolves the pending policy decision documented in the schema: two tenants recording the same gateway reference is legitimate (their own merchant accounts); duplicates within a business are still rejected. `isDuplicatePaymentReferenceError` updated to the new constraint name.
  - **Slice 3 — SSRF guard** (`utils/validateStoreUrl.ts` + tests): WooCommerce `storeUrl` validated at connect — http/https only, https required in production, private/loopback/link-local IP literals rejected, hostnames resolved and every address must be public. Harness bypass only when `INTEGRATION_TESTS=1` (mock stores on loopback; the suite fail-closes on the `ezpos_test` DB).
  - **Slice 4 — audit log foundation** (migration `0017` + `services/audit.ts`): general `audit_log` table written transactionally with the operation it describes. Wired into `sale.create`, `sale.refund_item`, `sale.refund_sale`, `subscription.payment.verified`. Metadata is non-sensitive (no references/secrets). Refund services now accept `actorUserId` from the controllers.
  - Verification: backend tsc clean; full suite 238/257 (same 19 pre-existing failures, none new; +11 new SSRF unit tests all green); audit_log verified populated in the integration run; migrations applied to `ezPos` + `ezpos_test`.
- **2026-11-01** — Phase 1 slice 5 (sale payment provider architecture, backend) complete:
  - Migration `0018`: `payment_provider_configs` (per-business merchant accounts, AES-256-GCM encrypted credentials, sandbox/live mode) + `sale_payment_intents` (status machine pending→captured/failed/cancelled, idempotency key doubling as the gateway tran_id).
  - `sslcommerzProviderFor(creds)`: SSLCommerz parameterized per merchant; the env-config singleton (subscriptions) delegates to it — behavior unchanged.
  - `services/payments/saleProviders.ts`: provider resolution per business; bKash/Nagad/ShurjoPay named but deliberately unimplemented (no official docs/credentials — no fake implementations; they fail loudly).
  - `saleIntents.service`: createIntent (due-validated, idempotent replay, gateway session initiated OUTSIDE transactions), verifyIntent (server-side provider verification → amount check → sale_payments row + due update + audit, all in one tx, row-locked), cancelIntent, plus an unauthenticated IPN endpoint (form-encoded, tran_id lookup, always 200, rate-limited).
  - Manual cashier payment rows remain a separate unchanged flow — verified electronic payments layer on top, per Module 3's separation requirement.
  - Verification: tsc clean; full suite 247/266 (same 19 pre-existing, zero regressions incl. the SSLCommerz refactor); new `saleIntents.integration.test.ts` 9/9 — capture, replay, double-verify, over-amount, gateway-invalid, cross-tenant 404, cancel semantics, IPN capture, unknown-tran IPN; audit_log shows 16 captures / 32 created / 4 failed / 4 cancelled from the run.
  - Remaining for Module 3: POS payment-dialog UI wiring, provider config admin UI, reconciliation report, bKash/Nagad adapters.
- **2026-11-01** — Phase 1 slice 6 (tax engine, backend) complete:
  - Migration `0019`: `tax_rates` (percent with exclusive/inclusive mode, optional location scope, effective dates, soft-deactivation only) + `product_taxes` (many-to-many assignment) + `sale_items.tax_amount` / `tax_detail` historical snapshots. New `taxes.view`/`taxes.manage` permissions (manager: both; cashier: view).
  - Rules engine in `cartPricing.ts` (`getCartTotalsWithTaxRules`): pro-rata cart-discount allocation, exclusive tax added on top, inclusive tax extracted (combined-rate split), per-rule amounts. When ANY line has rules, the legacy cart-wide `vatPercent` is not applied (mixing would double-tax); unassigned products are exempt; no rules anywhere → legacy fallback unchanged.
  - `resolveTaxRulesForSale` resolves active rates by location + effective date at transaction time; snapshots (id, name, rate, mode, amount) written per line — editing/deactivating a rate never rewrites history (verified by test).
  - Tax rate CRUD + product assignment endpoints (`/api/tax-rates`, `/api/products/:id/tax-rates`), permission-gated, audited (`tax_rate.created/updated`, `product.taxes_assigned`); receipts now carry `taxAmount`/`taxDetail` per line.
  - Fix: `validatePayments` mis-mapped two client errors (due-without-customer, payments-must-equal-total) as 404 — now 400.
  - Verification: tsc clean; full suite 257/276 (same 19 pre-existing; +10 tax tests green): exclusive 100+15=115, inclusive 115→extract 15, exempt+mixed carts ignore legacy VAT, legacy fallback intact, rate-change history preservation, future-dated rates, sales.vat = Σ line tax reconciliation.
- **2026-11-01** — Phase 1 slice 8 (POS frontend wiring) complete:
  - Backend support: `POST /api/sales/quote` — server-authoritative cart totals (trusted prices + tax rules, read-only, pos.view) and `POST /api/sales/payment-intents/verify` (verify by gateway tran_id — the provider redirect carries val_id + tran_id but not our intent id).
  - **Checkout taxes:** the POS totals hook now displays the server quote (debounced 250ms) with instant local-math fallback — the cashier always sees exactly what createSale will charge, including product tax rules; the VAT line labels rules-mode vs percent-mode.
  - **Receipts:** per-line tax amount + rule names rendered on the receipt template (historical snapshot from the backend).
  - **Exchanges:** `ExchangeDialog` on the sale-details screen — pick returnable items, search-add replacements, live difference estimate via the quote endpoint; backend settles exact numbers and any mismatch is surfaced. Store/API plumbing added.
  - **Due collection via QR/Card:** `PaymentIntentDialog` (amount ≤ due, method, provider) → gateway redirect → `/payment/return` page verifies server-side by tran_id before anything is recorded; cancel/fail paths say so explicitly.
  - Verification: backend tsc clean, full suite 266/285 (same 19 pre-existing; +1 verify-by-tran test green); POS tsc clean, `vite build` green.
- **2026-11-01** — Phase 1 slice 7 (exchanges + refund methods, backend) complete — Phase 1 backend DONE:
  - Migration `0020`: `sales.exchange_of_sale_id` (composite FK to the original sale — tenant-safe link) + `sale_refunds.refund_method` / `provider_refund_id`.
  - Exchange (`POST /api/sales/:id/exchange`, `sales.return` permission): in ONE transaction — `applySaleRefund` (same allocation/ceiling/serial/restock machinery as returns), replacement sale with trusted DB prices + tax-engine snapshots + stock consumption at the original's location, and difference settlement: up-exchange requires additional payments to exactly cover the difference (cash portion attributed to the register session); down-exchange refunds the surplus (cash, or original_payment via the provider); even exchange settles against itself. Idempotent via the replacement sale's idempotency key. Serial-tracked replacements rejected in v1. Audited (`sale.exchange`).
  - Refund methods: `refundMethod` on the existing refund endpoints; `original_payment` uses the provider's refund capability — interface extension + mock (deterministic) + SSLCommerz Merchant Refund API (documented public API). Ledger-first: the refund commits, the payout fires after commit and is retryable — `provider_refund_id` stays NULL until success, outcome returned to the cashier and audited (`sale.refund.provider_paid/rejected/error`). Store credit + customer balance deferred to a dedicated credit-ledger slice.
  - Fix: refund endpoints now return `refundTotal` + `providerPayout` (previously dropped by the controller).
  - Verification: tsc clean; full suite 265/284 (same 19 pre-existing; +8 exchange tests green): even exchange (stock nets to zero, original → refunded, replacement linked), up/down exchanges with exact settlement validation, double-refund + refunded-item guards, provider payout via captured mock intent, idempotent replay.
