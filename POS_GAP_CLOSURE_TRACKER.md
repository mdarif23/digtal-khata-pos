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
| 1 Checkout | Held sales (retrieve/share) | F→B incomplete → **Complete** | 2 ✅ | ✅ `held_sales` + TTL cleanup + audit | ✅ server-backed hold store (cross-register) | ✅ 0022 | integration 4/4 | — |
| 1 Checkout | Duplicate-submission prevention | B→F incomplete → **fixed** | **1** ✅ | ✅ replay + `onConflictDoNothing` | ✅ key sent, retry-safe | ✅ composite unique (0015) | unit 61/61, integration (see log) | — |
| 1 Checkout | Server-authoritative checkout totals (tax consistency) | Missing → **Complete** | **1** ✅ | ✅ `POST /sales/quote` | ✅ quote-backed totals hook, local fallback | — | integration | — |
| 1 Checkout | Cart expiry / cleanup, cart audit | Missing → **Complete (backend)** | 2 ✅ | ✅ HELD_SALES_TTL_HOURS + lazy + scheduled cleanup, hold audits | — | ✅ 0022 | integration | — |
| 1 Checkout | Active-cart recovery after refresh | **Defective** → **Complete** | 2 ✅ | n/a | ✅ write-through IndexedDB + restore-on-bootstrap (idempotency key persists) | n/a | ❌ (manual) | — |
| 2 Inventory | Adjustments / transfers / receiving | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 2 Inventory | Batch & serial tracking | Complete | — | ✅ FEFO locking | ✅ | ✅ | integration | — |
| 2 Inventory | Barcode stocktaking + cycle counts | Missing → **Complete** | 3 ✅ | ✅ sessions (whole-location or scoped cycle counts), variance-at-approval (counted − CURRENT, row-locked), movements + audit | ✅ Stock Counts page (scan/SKU entry, variance review, approve) | ✅ 0023 | integration 4/4 | Count-task assignment to staff (future refinement) |
| 2 Inventory | Replenishment / reorder suggestions | Missing | 3 | ❌ | ❌ | ❌ | ❌ | min/max/reorder config, suggestion engine |
| 2 Inventory | Aging, dead-stock, valuation reports | Partial → **Complete** | 3 ✅ | ✅ batch aging (receipt-date based, cost-valued buckets) + dead-stock (lookback window, never-sold detection) | ✅ Reports Hub tabs + nav | ✅ 0025 | integration 3/3 | — |
| 3 Payments | Manual methods (cash/card/bKash-QR), split, dues | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 3 Payments | Provider architecture for **sale** payments | Missing → **Partial** | **1** 🔄 | ✅ intent layer + per-business configs + SSLCommerz adapter + verify/IPN + reconciliation fields | ✅ due collection via QR/Card (gateway redirect → server-verified return) | ✅ 0018 | integration 10/9→10 | Provider admin UI; bKash/Nagad adapters (blocked on official docs + merchant credentials) |
| 3 Payments | Sale payment webhooks / reconciliation / settlement | Missing | **1** | ❌ | ❌ | ❌ | ❌ | — |
| 3 Payments | bKash / Nagad / ShurjoPay providers | Missing | **1** | ❌ | ❌ | ❌ | ❌ | Per official provider docs |
| 3 Payments | Payment reference uniqueness | **Defective** → **fixed** | **1** ✅ | ✅ ConflictError mapping updated | — | ✅ 0016 composite unique | integration | — |
| 4 Tax | Configurable tax engine (rates, product assignment, inclusive pricing) | Missing → **Complete** | **1** ✅ | ✅ rules engine (exclusive/inclusive/exempt, effective dates, location scope, server-side calc) | ✅ server-quoted checkout totals, per-line receipt tax, Tax Rates page, per-product assignment dialog | ✅ 0019 | integration 10/10 | Customer-specific treatment (future); location-scoped rates via API only |
| 4 Tax | Historical tax preservation | Partial → **Complete (backend)** | 1 ✅ | ✅ per-line snapshot (id/name/rate/mode/amount) | receipt carries breakdown | ✅ tax_detail | integration | — |
| 5 Returns | Full / partial returns, reasons, dispositions | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 5 Returns | Exchanges | Missing → **Complete** | **1** ✅ | ✅ atomic refund + linked replacement sale + difference settlement | ✅ exchange dialog (returns + replacement picker + live difference via quote) | ✅ 0020 | integration 8/8 | Serial-tracked replacements (v1 rejects) |
| 5 Returns | Refund methods (cash, provider refund, store credit) | Missing → **Complete** | **1** ✅ | ✅ cash + original_payment (ledger-first payout) + store_credit (credit ledger) | ✅ refund-method select | ✅ 0020+0021 | integration 7/7 | — |
| 6 Promotions | Sale-level fixed / % discounts | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 6 Promotions | Coupons | Missing → **Complete** | 4 ✅ | ✅ codes (windows, minimums, caps, usage + per-customer limits), server-validated at quote + sale time, redemption recorded per sale | ✅ Coupons page + checkout coupon input with live quote preview | ✅ 0028 | integration 7/7 | — |
| 6 Promotions | Scheduled auto-promotions, BOGO, category/customer rules, group pricing | Missing | 4 | ❌ future engine | ❌ | ❌ | ❌ | Auto-applied promotion engine on the coupon foundation (tracked, deliberately not faked) |
| 7 Loyalty | Points | Missing → **Complete** | 4 ✅ | ✅ ledger (earn on cash-equivalent paid, redeem with FOR UPDATE, refund clawback) + program config + history | ✅ payment method + balance in cart card | ✅ 0026 | integration 6/6 | Points expiry (FIFO sweep — future refinement); optional tiers |
| 8 Staff | Users / roles / permissions | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 8 Staff | Timeclock / attendance | Missing → **Complete** | 4 ✅ | ✅ clock in/out (immutable once out), breaks, manager approval, hours summary, audit | ✅ Attendance page (self-service + manager view) | ✅ 0029 | integration 5/5 | Shift scheduling + late/overtime baselines (future feature — honest deferral) |
| 9 Hardware | Browser printing + receipt settings | Complete | — | n/a | ✅ | n/a | ❌ | Fallback path done |
| 9 Hardware | ESC/POS, USB/Serial/BT, drawer, scale, customer display | Missing | 5 | n/a | ❌ | n/a | ❌ | Behind hardware abstraction layer |
| 10 Offline | Offline checkout + sync outbox | Missing → **Partial** | 2 🔄 | ✅ idempotent replay (no changes needed) | ✅ IndexedDB outbox + catalog cache + sync engine + status UI (cash/due only) | n/a | integration 3/3 | Service worker/background sync (optional); offline product search UX polish |
| 11 Multi-loc | Locations, transfers, registers, location RBAC/reports | Complete | — | ✅ | ✅ | ✅ | integration | — |
| 11 Multi-loc | Real-time register sync, activity monitoring | Missing → **Partial** | 2 🔄 | ✅ SSE streams (ticket auth, heartbeats, location-scoped publishes; sale/hold/register events) | ✅ EventSource client → revision-counter refreshes (stock, holds) | n/a | integration 3/3 | Register health dashboard UI; cross-location inventory overview |
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
- **2026-11-03** — Phase 4 slice 4 (attendance/timeclock) complete — **PHASE 4 DONE**:
  - Migration `0029`: `attendance_records` (immutable once clocked out — corrections go through manager approval, never edits) + `attendance_breaks` (one open break at a time). Location-scoped, UTC timestamps, client-local display. New attendance.view (self-service; cashiers seeded) / attendance.manage (managers) permissions.
  - Self-service: clock in (one open record per user — double-clock rejected), clock out (auto-closes any open break), break start/end. Managers see all records, approve (a signal, never a time edit — approve-once enforced), and read the per-user hours summary (worked vs break hours).
  - Clock events audited (attendance.clock_in/clock_out/approved).
  - Shift scheduling — and the late-arrival/overtime baselines it provides — is a separate future feature, deliberately not faked (no dead config fields).
  - Frontend: Attendance page (/attendance) — self-service status card + history; manager sections for all-records approval and the hours summary.
  - Verification: backend tsc clean, full suite 317/336 (same 19 pre-existing; +5 attendance tests green: flow, double-clock rejection, break rules, approve-once, hours summary); POS tsc + build green.
- **2026-11-03** — Phase 4 slice 3 (coupons) complete:
  - Migration `0028`: `coupons` (business-scoped codes; percentage/fixed; windows, order minimums, discount caps, total + per-customer usage limits) + `coupon_redemptions` (one per sale — reuse race-free, discount history inspectable). New promotions.view/manage permissions.
  - One evaluation engine drives BOTH the checkout quote and createSale — the cashier sees the exact discount before charging, and the sale-time rules are identical. The quote also enforces the v1 stacking rule (coupon excludes cart-level discount) so preview and charge can never diverge.
  - Redemption is recorded atomically with the sale (usage counter bumped in the same tx; per-customer limits enforced; replayed idempotent sales don't double-redeem — the redemption is unique per sale).
  - Frontend: Coupons page (/coupons, promotions.view/manage) with create + pause; checkout gains a coupon input whose discount shows live in the totals via the quote.
  - Auto-applied promotions (BOGO, category rules, scheduled campaigns, group pricing) are deliberately NOT faked — they need a real engine; tracked as future work on this foundation.
  - Verification: backend tsc clean, full suite 312/331 (same 19 pre-existing; +7 coupon tests green: case-insensitive codes, cap math, per-customer + total limits, windows, minimums, stacking rejection, inactive rejection, redemption history); POS tsc + build green.
- **2026-11-03** — Phase 4 slice 2 (gift cards) complete:
  - Migration `0027`: `gift_cards` (codes stored ONLY as SHA-256 hashes — the full code is shown exactly once at issue and never recoverable; last4 hint for display) + `gift_card_transactions` (pure ledger: + issue, − redeem; balance = SUM, reconciles by construction). `gift_card` added as a payment method.
  - Redemption at checkout: the cashier types the card code as the payment reference; the backend resolves the hash, locks the card + ledger FOR UPDATE inside the sale transaction (concurrent double-redemption impossible), honors expiry and active status, and an overdraft aborts the whole sale. The code is NOT stored on the payment row (reference NULL like cash — traceability lives in the card ledger via sale linkage), which also keeps the per-business payment-reference uniqueness from colliding across partial redemptions.
  - Endpoints: POST /api/gift-cards (issue — full code in this one response), POST /lookup (balance by code), GET /:id (detail + transactions), POST /:id/status (activate/deactivate). Gift-card-funded amounts also do not earn loyalty points.
  - Frontend: Gift card payment method (code entry, 8+ chars) + Gift Cards page (/gift-cards, nav) — issue dialog with show-once code, balance/status table, transaction history, activate/deactivate.
  - Verification: backend tsc clean, full suite 305/324 (same 19 pre-existing; +6 gift-card tests green: hash-only storage, partial redemption tracking, overdraft rollback, empty card, deactivated rejection, per-card ledger reconciliation); POS tsc + build green.
- **2026-11-03** — Phase 4 slice 1 (loyalty points) complete:
  - Migration `0026`: `loyalty_programs` (earn rate = points per currency paid, redeem value = currency per point, opt-in per business — no silent defaults) + `loyalty_ledger` (same pure-ledger pattern as store credit; balance = SUM, reconciles by construction).
  - Earn: on the CASH-EQUIVALENT paid amount only — dues earn nothing, and points/store-credit-funded portions do not earn points on themselves (a circularity the tests caught and the engine now excludes).
  - Redeem: `loyalty_points` payment method; ledger locked FOR UPDATE inside the sale transaction — overdraft aborts the whole sale.
  - Clawback: refunds reverse points earned on refunded value (balance may go negative when points were already spent — recorded honestly; redemption still cannot overdraw).
  - Endpoints: GET/PUT `/api/loyalty/program` (loyalty.manage — manager role), GET `/api/customers/:id/loyalty` (balance + history, customers.view). New permissions loyalty.view/manage auto-seeded.
  - Frontend: Loyalty points payment method (customer required) + live loyalty/store-credit balances on the cart's customer card.
  - Expiration deliberately NOT implemented (per-lot FIFO expiry is a sweep feature; a dead config field would violate the no-fake-implementations rule) — tracked as a future refinement.
  - Verification: backend tsc clean, full suite 299/318 (same 19 pre-existing; +6 loyalty tests green: config gating, earn/due distinction, redeem + overdraft rollback, clawback, ledger reconciliation); POS tsc + build green.
- **2026-11-02** — Phase 3 slice 3 (inventory aging + dead stock) complete — **Module 2 DONE**:
  - `GET /api/reports/inventory/aging`: batch-level aging bucketed 0-30/31-60/61-90/90+ days, valued at each batch's own cost; age sourced from the linked purchase receipt date (fallback: batch created_at).
  - `GET /api/reports/inventory/dead-stock?days=N`: stocked variants with no sales in the window (never-sold included), valued at remaining batch cost, sorted by value at rest.
  - Ops: fixed a real schema drift — `inventory_batches.created_at` existed in the ORM schema but no migration ever added it (migration `0025` applied to both databases with reconciled bookkeeping).
  - Frontend: Inventory Aging + Dead Stock report pages in the Reports Hub (new tabs + sidebar entries under Inventory reports).
  - Verification: backend tsc clean, full suite 293/312 (same 19 pre-existing; +3 report tests green: bucket math, batch-cost valuation, dead-stock detection/exclusion, never-sold flagging); POS tsc + build green.
- **2026-11-02** — Phase 3 slice 2 (automated replenishment) complete:
  - Migration `0024`: per-variant `reorder_point` / `reorder_quantity` config (products.edit permission; audited).
  - Suggestions are DERIVED at read time (never stored, always fresh): a variant is a candidate when current stock + OUTSTANDING purchase quantity has reached its point — in-flight orders are never double-ordered (proven by test: 5 stock + 25 on order > point 10 → no suggestion). Default order size = configured quantity, else the shortfall. Last purchase's supplier + unit cost prefill the conversion.
  - Conversion reuses the existing purchase-creation machinery end to end (`purchase.from_reorder` audited) — draft POs land in the normal purchases flow with prefilled prices.
  - Frontend: Reorder page (`/reorder`, Purchases nav group) — suggestions table with editable order quantities, inline reorder-point updates, supplier/cost hints, one-click PO creation.
  - Ops note: the 0024 migration had invalid CHECK syntax that made drizzle-kit silently skip it; fixed and applied to both databases with reconciled bookkeeping (verified: future migrate runs are clean).
  - Verification: backend tsc clean, full suite 290/309 (same 19 pre-existing; +3 reorder tests green); POS tsc + build green.
- **2026-11-02** — Phase 3 slice 1 (stock-count sessions) complete:
  - Migration `0023`: `stock_count_sessions` + `stock_count_lines` — whole-location stocktakes or variant-scoped cycle counts; expected quantities frozen at creation; partial counting is first-class (uncounted lines untouched).
  - **Concurrency-safe approval (the core invariant):** the applied variance is counted − CURRENT stock with rows FOR UPDATE at approval time — a sale or transfer between counting and approval cannot produce a wrong adjustment. Proven by a dedicated integration test (count 50 with a concurrent sale of 3 → +6 applied, movement recorded against the session).
  - Adjustments reuse the existing movement machinery (`movementType: "adjustment"`, `referenceType: "stock_count_session"`) so the shrinkage/movement reports reconcile; sessions audit as stock_count.created/approved/cancelled with counted_by vs approved_by separated.
  - Endpoints under `inventory.adjust` (location-scoped like sales): list/create/detail/counts/approve/cancel; `stock.changed` realtime event on approval.
  - Frontend: Stock Counts page (`/stock-counts`, Products nav group) — scan barcode/SKU/name to add lines, enter physical quantities, record, then approve with the variance summary.
  - Verification: backend tsc clean, full suite 287/306 (same 19 pre-existing; +4 stock-count tests green); POS tsc + build green.
- **2026-11-02** — Phase 2 slice 4 (real-time register updates) complete:
  - SSE-based push over the existing Express app (no new dependency; Module 11's "appropriate real-time mechanism"). Auth: authenticated `POST /api/realtime/ticket` mints a short-lived ONE-TIME ticket bound to the caller's business+location (EventSource cannot send headers); the stream consumes it and validates every connection. Heartbeats keep intermediaries open; the in-memory registry follows the documented single-instance stance.
  - Events: `sale.created` (createSale + exchanges — other registers at the location refresh stock within seconds, improving multi-cashier oversell protection), `held_sales.changed` (create/discard), `register.changed` (open/close). Location-scoped: a register never receives another location's events (verified by test).
  - Client: one EventSource per register page with one-time-ticket re-negotiation + backoff; events bump revision counters and the affected stores refresh through their NORMAL APIs — real-time signals never replace server-side validation (per the master prompt).
  - Verification: backend tsc clean, full suite 283/302 (same 19 pre-existing; +3 realtime tests green: no-ticket 401, one-time ticket replay rejected, same-location delivery + cross-location isolation); POS tsc + build green.
- **2026-11-02** — Phase 2 slice 3 (active-cart persistence) complete:
  - The register's active cart writes through to IndexedDB (debounced 300ms, scoped per user+business) and is restored at session bootstrap — a refresh or crash no longer destroys a checkout in progress.
  - The checkout idempotency key persists WITH the cart: a post-crash retry reuses the same key, so even a restored interrupted checkout cannot double-charge.
  - Restore only fills an empty cart (never overwrites an in-flight one); IDB schema bumped to v2 with a safe upgrade path.
  - Verification: POS tsc + vite build green (frontend-only change; no backend surface).
- **2026-11-02** — Phase 2 slice 2 (shared held sales) complete:
  - Migration `0022`: `held_sales` — holds move from localStorage to the server, scoped per business+location with a composite FK; slim serializable cart snapshot (prices/stock re-validated at sale time); `HELD_SALES_TTL_HOURS` (default 72, 0 = never) with lazy cleanup on list + a scheduler sweep (`heldSalesExpired` in the commerce sweeps); hold/discard audited.
  - Endpoints: GET/POST/DELETE `/api/held-sales` (pos.view / pos.create_sale), location-scoped like the sales routes.
  - Frontend: `useHoldCartStore` is server-backed under the same export names — the register clears the cart only after the hold is safely stored; the Held Items dialog refreshes on open (holds from other registers appear), resumes rebuild cart lines from LIVE catalog data and report unresolvable products instead of silently dropping them.
  - Verification: backend tsc clean, full suite 280/299 (same 19 pre-existing; +4 held-sales tests green: cross-location invisibility, same-location retrieval, discard, empty-hold rejection); POS tsc + build green.
- **2026-11-02** — Phase 2 slice 1 (offline-first core) complete:
  - IndexedDB foundation (`pos/src/features/pos/offline/db.ts`): dependency-free IDB wrapper — catalog caches (products/customers, scoped per user+business), durable `outbox` keyed by client sale id, bounded sync log, persistent-storage request. localStorage deliberately NOT used as the transaction DB (per the master prompt).
  - Offline sale recording: when the device is offline (or the connection drops mid-checkout), cash/due sales go to the outbox with a client-generated UUID that doubles as the backend idempotency key — **replays can never create duplicates** (proven by a dedicated integration test: 1 create + 3 replays → exactly 1 sale, 1 stock deduction; a stock-conflicted payload is rejected, never duplicated). Electronic payments/credits/due-without-customer keep the cart — they genuinely need connectivity.
  - Sync engine (`offlineStore.ts`): auto-sync on reconnect + backoff (5s→5min, resets on success), sequential replay in recorded order, network-failure entries stay pending, backend REJECTIONS become "review required" (never retried, never dropped) with the exact server reason; full history + event log visible to the cashier (`SyncStatus` indicator + history dialog in the register header; re-queue after review).
  - Catalog fallback: product/customer loads fall back to the IndexedDB cache on network failure with an "Offline mode" flag on the register.
  - Backend: ZERO changes needed — Phase 1's idempotent checkout is the sync-safety foundation.
  - Verification: backend tsc clean, full suite 276/295 (same 19 pre-existing; +3 offline-replay tests green); POS tsc + vite build green.
- **2026-11-01** — Phase 1 slice 9 (Phase 1 tail: store credit + tax settings UI) complete — **PHASE 1 DONE**:
  - Migration `0021`: `customer_credits` — a pure transaction ledger (positive rows grant, negative rows consume; balance = SUM(amount), reconciles by construction). Consumers lock the customer's rows FOR UPDATE, so concurrent checkouts cannot overspend. `store_credit` added to sale-payment and refund-method constraints.
  - Refunds settle as store credit transactionally (`grantStoreCreditInTx` inside the refund tx; requires a customer on the sale). Sales can PAY with store credit (`consumeStoreCreditInTx` inside the sale tx; insufficient balance aborts the whole sale with a clear message; balance endpoint `GET /api/customers/:id/store-credit`).
  - Frontend: refund-method select (cash / store credit / original payment) on the return dialog; "Store credit" payment method in checkout (customer required, disabled otherwise); Tax Rates management page (`/tax-rates`, taxes.view/manage) with create + deactivate; per-product tax assignment dialog in the products table.
  - Verification: backend tsc clean, full suite 273/292 (same 19 pre-existing; +7 credit-ledger tests green: grant→spend→partial+due, insufficient-balance rollback, customerless rejection, ledger reconciliation); POS tsc + build green.
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
