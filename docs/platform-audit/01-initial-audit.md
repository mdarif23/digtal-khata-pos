# ezPos Platform — Initial Audit Report (STEP 1–7)

**Date:** 2026-11-10 · **Branch:** `fix/testing-and-fixing` · **Mode:** READ-ONLY (no code, schema, or data changes in this phase)
**Method:** 5 parallel deep code audits (POS frontend, Website/SaaS-admin, backend endpoints+DB, inventory consistency, financial accuracy) + live verification already performed in the preceding session + accumulated bug register.

---

## 1. Platform inventory (what exists)

| App | Scale | Verdict |
|---|---|---|
| **POS frontend** (`pos/`) | **67 routes, ~75 page components, 28 report components, ~84 distinct mutation operations** | Feature-complete; no stubs, no TODO markers; every module wired to real APIs |
| **Website + SaaS admin** (`ezPosWebsite/`) | ~40 routes (marketing, auth, onboarding, /account portal ×9 areas, /saas-admin ×8, payment returns) | All 90+ frontend API calls resolve to real backend endpoints — **zero path mismatches** |
| **Backend** (`ezPosBackend/`) | **~370 endpoints** across 60 routers; **162 tables**, 64 migrations; 8 scheduled job sweeps | Uniform tenancy, permission and subscription middleware |
| **Tests** | Backend: 963/964 pass incl. all 94 integration suites (fixed this session); POS: 265 vitest + Playwright e2e; Website: 3 unit test files | Backend coverage strong; POS e2e covers checkout/workflows; website tests minimal |

Modules discovered (POS): Dashboard · POS terminal (held carts, split payments, offline sync/PWA) · Products (+variants, UOM packaging, import/export, barcodes) · Categories/Brands/Units · Stock adjustments/counts/transfers · Sales history (returns/exchange/refunds, due collection via gateway) · Purchases (orders, partial receiving, discrepancies, returns, landed cost) · Procurement (price monitoring/checks, reorder) · Customers/Suppliers · Due management (ledger, payments, messaging) · Expenses (+payments, attachments, recurring templates, budgets) · Coupons · Gift cards · Tax rates · Loyalty/store credit · Online orders (fulfillment) · Pricing engine (rules, promotions, customer groups, bulk, proposals, auto-update, history, reports) · 28 reports · Finance & Growth (overview+activation wizard, growth, cash-flow, balance-sheet, 10 finance reports, owner capital, profit allocations, payroll, loans, assets, journal/periods/reconciliation/audit) · Locations · Users/Roles · Attendance · Cash registers · Hardware/terminals · Receipt settings · Backups · Notifications · Offline sync · Support tickets · Storefront builder (via website) · WooCommerce integration · Outbound webhooks · Subscriptions/billing.

**No module is "not implemented" — everything found is wired. The gaps are correctness/consistency issues below.**

---

## 2. Architecture verdicts (the three owner priorities)

### 2.1 Inventory consistency — **SOLID core, 3 real defects**
The equation `opening + receipts + adjustments − sales − supplier-returns − deductions = closing` **holds in every online flow**: all stock mutations are transactional, row-locked (FOR UPDATE from validation through deduction — no validate-then-deduct window), FIFO batch consumption, idempotent checkout (idempotency key + payload hash + unique constraint), over-receive policy enforced server-side, purchase returns fail closed on batch-pool mismatch, transfers are atomic with partial-receive shrinkage as a documented deliberate decision. UOM packaging is DB-authoritative with a whole-base invariant (10 boxes × 12 → 120 base units provable).

| # | Finding | Evidence | Severity |
|---|---|---|---|
| INV-1 | **Partial refund logs a full-line movement**: movement row writes `item.quantity` instead of `returnedQuantity` — restocking 2 of 12 logs a 12-unit movement. Stock/money correct; audit ledger overstates. | `sales.service.ts:1939-1948` | **P2** |
| INV-2 | LAN sync-agent `pullStock` overwrites stock/batches non-transactionally, no movement rows; a sale in flight during a pull can lose its stock effect locally (gated by push-before-pull). | `sync/sync.agent.ts:751-767` | **P2** (LAN deployments) |
| INV-3 | Backup **restore** is not transactional (chunked upserts); crash mid-restore can mix old/new stock. Mitigated by mandatory pre-restore safety backup + verification report. | `backupRestore.service.ts:505-532` | **P2** (operational) |
| INV-4 | Count-approval shrink can silently consume more batches than exist (batch ledger drifts below stock row). | `stockCount.service.ts:367-382` | P3 |
| INV-5 | Product-create opening stock writes no movement row (import path does) — silent audit-trail start. | `addProduct/product.service.ts:455-468` | P3 |

### 2.2 Financial classification — **the money spine is correct**
Verified end-to-end with file:line evidence: owner investment → **DR cash / CR 3010** (never revenue); withdrawal AND realized distribution → **DR 3020 / CR cash, classified "financing"** (never an operating expense); salary → 5020 operating expense; sales → 4010 net of VAT/delivery; COGS → 5010 from `cost_at_sale` snapshots. `calculateProfit` reads **only** posted GL balances (operational tables cannot double-count). Expenses hit operational tables exactly once and GL exactly once (idempotent source keys; settlements debit 2010, not the expense; void reverses). Cash flow splits financing correctly. Reconciliation ties GL↔operational (1050↔batches, 1040↔sales dues, 2010↔purchase dues, 2030↔payroll). **No investment-as-revenue, withdrawal-as-expense, or payment×item fan-out double counting exists.**

### 2.3 Dashboard/report accuracy — **the weakest area (this is where "numbers don't match" comes from)**

| # | Finding | Evidence | Severity |
|---|---|---|---|
| FIN-1 | **Systemic timezone split**: dashboard + reports use UTC windows (`CURRENT_DATE`, `new Date()`); Finance-Growth uses Asia/Dhaka business-local dates. For UTC+6, ~6h of every business day lands in the wrong bucket; POS "today" and Finance "today" disagree every night. | `dashboardMatrix.service.ts:28-37`, `reports.service.ts:18-70` vs `finance.overview.service.ts:26-33` | **P1** |
| FIN-2 | Dashboard mixes calendars inside itself: sales filtered by UTC `created_at`, expenses by business-local `expense_date` → daily net profit skews. | `dashboardMatrix.service.ts:416-421,469-474` | P1 |
| FIN-3 | Refund attribution inconsistent across widgets: profit-by-category & sales-overview chart count refunded sales without netting (top-items nets them); Sales Summary nets; cross-period refunds hit the original sale's month in the Profit Report but the refund's month in the dashboard — the three never agree. | `dashboardMatrix.service.ts:115-134,75-91`, `reports.service.ts:498-520 vs 121-137` | **P1** |
| FIN-4 | Stock Report with a location filter generates `p.location_id` — a column that doesn't exist on products → runtime SQL error. | `reports.service.ts:748` | **P1** (broken feature) |
| FIN-5 | Sales-by-Invoice report has **no status filter** — pending/held/cancelled sales render as invoices. | `reports.service.ts:237-291` | P2 |
| FIN-6 | Customer-receivables report: rows are location-scoped but the totals line is business-wide → totals ≠ Σ rows. | `reports.service.ts:696-725` | P2 |
| FIN-7 | Product-sales report counts refunded units/money without netting. | `reports.service.ts:326-366` | P2 |
| FIN-8 | Supplier payment cap ignores purchase returns → supplier can be overpaid after a return (balance flips to credit). | `receive.calculations.ts:56-70` | P2 |
| FIN-9 | Documented gap: Finance-Growth P&L ≠ POS dashboard net profit (GL excludes VAT; dashboard subtracts full refund money incl. VAT; GL-only items like shrinkage never reach the dashboard) — with **no surface explaining the difference**. | `sales.ledger.ts:142-169` | P2 (UX/expectation) |
| FIN-10 | Payables reconciliation shows variance whenever unpaid expenses exist (GL 2010 carries them; operational payables counts purchases only). | `expenses.ledger.ts:115-123` | P3 |

### 2.4 Security / tenancy — **strong**
- Tenant isolation: `requireBusinessContext` re-resolves membership + permissions from DB per request; 403 indistinguishable from "not found"; audited queries follow a consistent scoped-fetch-then-update-by-PK pattern — **no unguarded cross-business query found**.
- Unauthenticated surfaces are all deliberately protected: payments IPN (gateway val_id verified server-side), WooCommerce webhook (HMAC over raw body), storefront v1 (hashed per-key API secrets + scopes), internal renderer endpoints (timing-safe shared token), sync agent (terminal secrets), SaaS admin (platform role).
- Gaps (P3): `POST /api/support/contact` is public with only a rate limit (spam surface); payment-success page can 401-verify if the browser session isn't restored (relies on IPN/retry — recoverable).

---

## 3. Confirmed frontend bugs (already fixed this session, committed in `6214055` — included for the record)

| Bug | Severity | Fix |
|---|---|---|
| Finance module called the API with **raw axios** — no baseURL/auth/business header → every finance page got HTML from Vite and rendered empty. The single reason "Finance & Growth didn't work". | **P0** | `finance.api.ts` + `FinanceReportsPage.tsx` now use the configured instance (58 call sites) |
| GrowthPage crashed on open (`changeBadge is not defined` — helper referenced out of scope) | **P1** | badge renderer moved to module scope |
| JournalPage crashed on open (`useInvalidateFinance is not defined` — missing import) | **P1** | import added |
| Profit-allocations report rendered a zero-column table (backend omitted `columns`) | P2 | columns added to `getAllocationReport` |
| PayslipDialog fetched inside a `useState` initializer (render-phase side effect) | P2 | converted to `useEffect` |
| Journal manual entry: rows with an account but no amounts passed UI checks, 400'd on submit | P2 | empty-amount rows filtered client-side |

Website findings (not yet fixed — need approval per this phase's rules): dead link `/saas-admin/businesses/:id` (no such route) · payment outcome reporting dead code (`/payment/failed|canceled` never report to the backend) · no business switcher UI in the portal while half the pages ignore the unused hook · payment-success verify races session restore.

POS findings (not yet fixed): hardcoded QR number in PaymentModal · "Clear Hold Carts" deletes all holds with no confirm · several mutating buttons behind route-guard only (sales refunds, coupons, tax rates, users toggle/reset, pricing proposals) — backend permissions still enforced, so this is UX-consistency, not a security hole.

---

## 4. Bug register (merged, severity-ranked, fix pending approval)

**P1 (5)** — FIN-1 timezone split (systemic dashboard/report windows) · FIN-2 dashboard calendar mix · FIN-3 refund attribution inconsistencies · FIN-4 stock-report location SQL error · plus the two P0-class frontend crashes already fixed above.
**P2 (11)** — INV-1 partial-refund movement · INV-2 sync pullStock · INV-3 restore transactionality · FIN-5..FIN-10 · website items above.
**P3 (8)** — INV-4, INV-5, FIN-10, support/contact rate limiting, hardcoded QR, unconfirmed destructive buttons, permission-button consistency, payables recon variance.

**Readiness per the report framework: NOT READY FOR PRODUCTION** — P1 financial-accuracy bugs remain (the fixes are small, targeted SQL/window changes; inventory and GL cores are sound).

---

## 5. Proposed implementation plan (Phases B–H, after approval)

**Wave 1 — correctness fixes (all P1 + selected P2, ~1–2 sessions)**
1. Timezone unification: introduce one business-local day-window helper (Dhaka) used by dashboard + all reports (FIN-1/2).
2. Refund netting policy applied consistently: pick the documented rule (refund attributed to refund date, netted in every sales/profit widget) and align dashboard + reports (FIN-3, FIN-5, FIN-7).
3. Stock-report location filter fix (FIN-4); receivables totals scope (FIN-6); supplier payment cap vs returns (FIN-8).
4. INV-1 movement quantity one-liner; count-shrink shortfall guard (INV-4).
5. Regression tests for each (backend integration tests in the existing suites).

**Wave 2 — empirical verification (Phase C/D)**
6. Seeded reconciliation run: script that inserts known transactions (sale w/ variants+discount+VAT+split payment, partial purchase receive, return, exchange, transfer, expense, owner capital) then compares dashboard, reports, GL balances, and DB invariants against independently computed values — the Report-4 reconciliation table with real numbers.
7. UOM workflow test (10 boxes × 12 → sell box + 2 pieces → 106 expected).
8. Role matrix test (owner/manager/cashier × representative mutations, UI + direct API).
9. Concurrency test (two terminals selling last unit; duplicate idempotency replay).

**Wave 3 — SaaS lifecycle (Phase C workflow 11)**
10. Full subscription journey in browser: signup → trial → POS gating → payment (mock gateway) → admin change-plan/suspend → verify POS effects.

**Wave 4 — UX/consistency sweep (P2/P3)**
11. Website dead link + payment outcome reporting + business switcher decision; POS PermissionButton consistency + confirm dialogs + QR setting.

**Wave 5 — regression + reports**
12. Full automated suite re-run, update `pos/e2e` for new flows, deliver Reports 1–10 (final readiness decision).

---

## 6. Approval requested

1. Approve Wave 1 fixes (P1 financial-accuracy + INV-1) — backend-only, no schema changes.
2. Approve Wave 2 empirical reconciliation (creates test data only in `ezpos_test`).
3. Confirm the refund-attribution policy (refund date vs sale date) before Wave 1 item 2.
4. Confirm whether Finance-Growth vs dashboard variance should be surfaced as an in-app explainer (FIN-9) or unified — this is a product decision.


---

## 7. Wave 2 empirical reconciliation — EXECUTED 2026-11-10 (ALL 32 CHECKS PASSED)

Isolated backend on :3005 against ezpos_test; script ran as a real user: business+location → ledger activation (opening capital 10000) → PO 10 ordered, receive 6 (partially_received) then 4 (received), unpaid (payable 400) → sales with 10% discount (180), VAT 10% + split cash/due (110, due 50) → due collection → partial refund 1-of-2 restock → expense 50 → owner investment 10000 + withdrawal 2000 → cashier/manager role matrix → two-terminal parallel all-stock sale (one 201, one 404, stock 0, no negative) → idempotent replay (same sale id, stock deducted once).

| Metric | Expected | Actual | Result |
|---|---:|---:|---|
| Stock conservation (10−3+1, then −6 winner sale) | 0 | 0 | PASS |
| Customer due after collection | 0 | 0.00 | PASS |
| Supplier payable (10×40 unpaid) | 400 | 400.00 | PASS |
| GL 4010 revenue (ex-VAT) | 1080 | 1080 | PASS |
| GL 4020 refund contra | 90 | 90 | PASS |
| GL 5010 COGS (net of restock credit) | 400 | 400 | PASS |
| GL 3010 owner capital (opening+investment) | 20000 | 20000 | PASS |
| GL 3020 drawings | 2000 | 2000 | PASS |
| GL cash 1010 | 18950 | 18950.00 | PASS |
| Finance netRevenue (GL, ex-VAT) | 990 | 990.00 | PASS |
| Finance net profit | 540 | 540.00 | PASS |
| Dashboard net sales (incl VAT) | 1000 | 1000.00 | PASS |
| Sales report net sales / refunds | 1000 / 90 | 1000 / 90 | PASS |
| Roles: cashier users 403, manager capital 403, dashboard 200, cashier sale 201 | as stated | as stated | PASS |
| Concurrency: parallel oversell 1 win/1 loss, no negative stock | as stated | as stated | PASS |
| Idempotent replay: same sale, single deduction | as stated | as stated | PASS |

FIN-9 variance observed exactly as documented: dashboard net sales 1000 vs GL 990 = S2 VAT 10.
Every GL account reconciled to the poisha; books balance to zero.


---

## 8. SaaS subscription journey — EXECUTED IN BROWSER 2026-11-10 (WORKFLOW 11)

Real browser run on the dev stack: sign-up → business created → trial active → /account/subscription → trial expired via jobs sweep (POST /api/saas/jobs/run expired 1) → **lapsed state correctly rendered** ("Free trial expired") → Renew now → **status active, period +1 month** (lapsed-recovery fix verified) → plan switch → prorated invoice INV-2026-000001 pending → Billing → Pay now → **mock gateway redirect → /payment/success → server-side verify → "Payment confirmed"** → DB: subscription active, invoice paid, payment succeeded → **POS opens with the active session**.

Note: the plan-switch button ordering selected the 0-cost plan (invoice BDT 0) — mechanics verified end-to-end; plan-grid targeting is a cosmetic UX note. Browser session: saasj3…@test.local / business 16 / INV-2026-000001.
