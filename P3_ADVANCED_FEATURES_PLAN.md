# P3_ADVANCED_FEATURES_PLAN.md

**Program:** ezPos — P3 Advanced Features and Future Verticals
**Status:** PLAN DELIVERED — awaiting explicit approval. No application code, migrations, or schema changes have been made.
**Date:** 2026-11-14
**Branch:** `feature/add-feature` (clean, even with `origin/development` tip `fc9a4fc3`)

---

## 0. Verified current state (Step 1 evidence)

Everything below was re-verified on this machine today; none of it is taken from the historical claims in the program prompt.

### 0.1 Git

| Item | Verified value |
|---|---|
| Branch | `feature/add-feature`, working tree **clean** |
| Position | Contains `b32d7d39` (P0/P1 fix work) and merge `fc9a4fc3` (PR #75, `fix/ui-and-ux`) — P0/P1 changes **are** in this tree |
| Remotes | `origin` = `https://github.com/mdarif23/digtal-khata-pos.git` (+ duplicate `upstream`) |
| Local branches | `development`, `feature/add-feature`, `main` |
| Push performed | **None.** Nothing was pushed, fetched, pulled, or amended during verification. |

`pos/cj-tmp.txt` does **not exist** on this Linux checkout (it is an artifact of the Windows machine). The rule stands: if it ever appears, it is never opened, printed, copied, staged, or committed.

### 0.2 Runtime, migrations, database

| Item | Verified value |
|---|---|
| Node | System `v20.20.2`; Node **22.23.4** available via nvm (`.nvmrc` = 22). All checks/tests below ran on Node 22. |
| Migrations | `ezPosBackend/drizzle/` through **`0079_serial_in_transit.sql`**; journal has 80 entries (idx 0–79); **next migration number is `0080`** — matches the prompt's expectation. Journal `when` values are monotonic (checked explicitly — the drizzle migrator applies by `when > max stored created_at`, so renumbering must keep this invariant). |
| Test DB | `ezpos_test` **exists**. `.env` `DATABASE_URL` was verified in memory to point at `ezpos_test` (`SELECT current_database()` = `ezpos_test`). It was **16 migrations behind** (64 of 80 applied); `db:migrate` was run **against `ezpos_test` only** (target re-verified immediately before) and now reports **80/80 applied**. |
| Secrets | `.env` values were read only in memory by a script that printed database names/booleans; no URL, password, or token was ever displayed. |

### 0.3 Baselines captured today (see §L.4 for caveats)

| Gate | Command | Result |
|---|---|---|
| Backend TypeScript | `npx tsc --noEmit` (ezPosBackend) | **pass (exit 0)** |
| Frontend TypeScript | `npx tsc --noEmit` (pos) | **pass (exit 0)** |
| Frontend Vitest | `npx vitest run` (pos) | **24 failed / 269 passed (293)** while the full backend integration suite ran concurrently — durations up to 80 s indicate timeout pressure, not product defects. A clean serial re-run is required before implementation; the exact failing list will be recorded then (§L.4). |
| Backend suite | `npm test` + `INTEGRATION_TESTS=1`, Node 22, `ezpos_test` (migrated 64→80 first) | **1035/1035 pass, 0 fail, 0 skipped, 152 suites** — fully green baseline; the prompt's historical "1057/1058 with 1 skip" no longer reflects this tree. |

Backend test harness facts: node:test via tsx (`"test": "tsx --test --test-force-exit \"src/**/*.test.ts\""`), 106 suite files, integration suites self-skip unless `INTEGRATION_TESTS=1 && DATABASE_URL`, and `src/test/helpers/db.ts` **fails closed** unless `current_database() == "ezpos_test"`. Frontend: vitest + jsdom + MSW (`pos/vitest.config.ts`, `pos/src/test/setup.ts`).

### 0.4 The P0/P1 base the program builds on (verified in code)

The tree already contains, confirmed by file/line evidence during this audit: tax-rule engine (`getCartTotalsWithTaxRules`, `ezPosBackend/src/modules/sales/utils/cartPricing.ts:325`), group pricing + promotions + coupon + minimum-price floors in quote and sale paths, offline allocations + sync-conflicts ledger (`ezPosBackend/src/modules/offline/`), terminal context middleware, manager-approval service (`ezPosBackend/src/services/managerApproval.ts`, `approval_required` config already containing a **`sale_cancel` key** — `ezPosBackend/src/db/schema/posSettings.ts:18-23`), commission reversals (migration 0077), fractional refund precision (0078), serial in-transit (0079), sales-team BI (0076), landed cost, backup/restore, UOM conversions, batch consumption audit rows (`sale_item_batch_consumptions`).

---

## A. Phase breakdown

### Phase 1 — Register money and financial capabilities

Five independent features; **no sale void in this phase**.

| Feature | New backend API | New/changed tables | New permissions | Frontend surface |
|---|---|---|---|---|
| F1 Additional sale charges | none new (extended payloads) | `sale_charges` (new child table) | none | cart charges editor, receipt/CFD rows |
| F2 Customer credit limits | none new (guard inside `POST /api/sales`) | `customers.credit_limit` column | none (edit covered by `customers.edit`) | customer dialog + profile card, POS customer card |
| F3 Gift card reload | `POST /api/gift-cards/:id/reload` | `gift_card_transactions` CHECK extended (`'reload'`) | none (reuses `pos.create_sale` like issue) | GiftCardsPage reload dialog + history |
| F4 Store-credit expiry | none new (sweep + read changes) | `customer_credits.expires_at` + CHECK extended (`'expiry'`); `pos_settings.store_credit_expiry_months` | none | customer store-credit display already exists |
| F5 Generalize split payments | none new | none | none | `PaymentModal.tsx` builder generalization |

Shared Phase-1 touchpoints (verified):

- Pricing choke point (both sides must stay in lockstep): `pos/src/features/pos/cartPricing.ts:41-77` (client fallback) and `ezPosBackend/src/modules/sales/utils/cartPricing.ts:94-213, 325-519` (authoritative). Server evaluator returns `finalTotal` used by `validatePayments` (`ezPosBackend/src/modules/sales/sales.validation.ts:163-259` — paid + due must equal final total in poisha).
- Quote endpoint: `POST /api/sales/quote` → `salesExchangeController.quote` (`sales.routes.ts:39-44`) → `salesService.quoteSaleTotals` (`sales.service.ts:3569`), which mirrors `createSale` (`sales.service.ts:938`) evaluator-for-evaluator. Quote schema lives in `salesExchange.controller.ts:93-137`; create schema in `sales.schema.ts:74-110`.
- PaymentModal consumes **only** `finalTotal` (`quotedFinalTotal` prop, `PaymentModal.tsx:253-268`) and never re-prices client-side — the architecture the prompt mandates is already in place and will be preserved.
- Refund engine: `applySaleRefund` (`sales.service.ts:2004-2542`) already pro-rata-allocates the header-vs-lines delta (VAT − cart discount) by line total (`2044-2057`); a header-level charge automatically falls into this delta. This is the hook Phase 1 F1 uses for refund shares.
- Ledger: `postSaleLedgerEntry` (`sales.ledger.ts:50-211`) currently posts `CR 4010 = final_total − vat − delivery_fee`, `CR 2020 = vat`, `CR 4030 = delivery_fee`. `FINANCE_SOURCE_TYPES` (`services/ledger.ts:56-80`) is the whitelist; journal idempotency via partial unique index `journal_entries_source_posted_uq` (`journalEntries.ts:96-99`).
- Drawer: transaction-safe helpers `recordCashSaleInTx`, `recordCashRefundInTx`, `recordDueCollectionInTx`, `recordGiftCardIssueCashInTx`, `findOpenSessionForAttribution` (`cashRegisters.service.ts:1282-1476`); movement idempotency via `register_transactions_reference_uq` (`registers.ts:259-263`).

### Phase 1 F5 — Generalize split payments (design detail)

Verified hardcoding in `PaymentModal.tsx` (905 lines):

- `buildPayments(method, finalTotal)` (`:51-78`) switch — the `split` case seeds **exactly three fixed rows** `[{cash}, {bangla_qr, reference:""}, {due}]` (`:69-74`).
- `SplitPayment` maps rows **positionally** (`payments.0`=cash, `payments.1`=digital, `payments.2`=due, `:682-872`), and the digital slot's ToggleGroup offers **only** `bangla_qr | card` (`:766-767`).
- Mode is derived from array length (`getMode`, `:81-83`), so any multi-row payment array renders the fixed 3-row UI.
- Backend officially permits 7 methods (`PAYMENT_ROW_METHODS`, both schemas: cash, bangla_qr, card, due, store_credit, loyalty_points, gift_card) with a distinct-method constraint (`validatePayments`, `sales.validation.ts:172-176`) and the paid+due = finalTotal poisha identity (`:232-236`).

Design (F5):

1. Replace the positional 3-row builder with an **arbitrary ordered list of payment rows** (add/remove rows; per-row method picker over all 7 methods minus methods already used — preserving the distinct-method constraint in the UI); `getMode` becomes `payments.length > 1 ? "split" : method` (unchanged semantics for single methods).
2. Reuse the existing live pre-checks unchanged: `useTenderBalances` (`:114-162` — store-credit, loyalty balance, loyalty config endpoints), `storeCreditIssue`/`loyaltyIssue` validators (`:165-205`), gift-card code entry (≥ 8 chars, `:195-202` backend).
3. Fill-to-remaining (`fill`, `:698-702`) generalized to any row; rows summing ≠ `finalTotal` invalid (`isPaymentValid` generalized, same exact-equality rule `:231-243`); due row still requires a customer; overpay still impossible (sum ≤ finalTotal when no due).
4. Failed-tender safety stays server-side: each tender is re-validated and consumed inside the sale transaction (row-locked balance re-checks, `sales.service.ts:1732-1784`); a failed tender aborts the whole sale transaction — no partial capture exists anywhere today, and none is introduced.
5. No new tender types, no gateway changes, backend untouched (its validation is already complete).

Existing `PaymentModal.test.tsx` (15 tests) is the regression harness; new tests cover store-credit/loyalty/gift-card rows inside split and multi-row allocations.

### Phase 2 — Batch management and FEFO at the POS register

Depends on Phase 1 being committed (stable money layer), and deliberately precedes void.

| Item | New backend API | New/changed tables | New permissions | Frontend surface |
|---|---|---|---|---|
| Batch picker | `GET /api/variants/:variantId/batches` | none | none — mirrors serial endpoint's `requireAnyPermission(["pos.create_sale","inventory.view"])` (`sales.routes.ts:86`) | `BatchPickerDialog.tsx` modeled on `SerialPickerDialog.tsx` |
| Payload + backend processing | extended sale item schema | none (provenance table **already exists**: `sale_item_batch_consumptions`, written at sale time by `insertSaleItemConsumptions`, `sales.service.ts:342-362`) | none | cart line batch chip/selector |
| FEFO default | none | none | none | — |
| Expired-batch policy | none | `pos_settings.expired_batch_policy` column | decision D7 (approval mechanism vs new permission) | settings UI row |
| Expiry notifications | none | none | none | notification center already exists |
| Returns/exchanges provenance | none | none | none | — |
| Offline behavior | none | catalog cache extension (batches) | none | offline gate for batch items |

Key verified facts:

- Current consumption is **FIFO by batch id, with no expiry awareness**: `consumeStockFifo` (`sales.service.ts:364-450`) orders `asc(inventoryBatches.id)` (line 377-402) and never compares `expiryDate` (selected at line 390, only for cost context). Expired batches are consumed like any other today.
- Batches table `inventory_batches` (`inventoryBatches.ts:19-82`): `batchNumber`, `purchasePrice`, `landedCostPerUnit` (generated), `quantityReceived/quantityRemaining` (doublePrecision), `manufacturedDate`, `expiryDate` (date), **no status column** — lifecycle is `quantityRemaining > 0`.
- Tracking flag: `products.trackingType` ∈ `none | batch | serial` (`products.ts:38`, schema `product.schema.ts:70-75`) — product-level, read from DB in `validateVariants` (`sales.validation.ts:45-87`, `.for("update")`).
- Provenance: every sale already writes `sale_item_batch_consumptions` rows (`saleId, saleItemId, batchId, variantId, quantity, unitCostAtConsumption`, `saleItemBatchConsumptions.ts:36-89`). **The Phase 2.6 provenance requirement is already half-satisfied**; Phase 2's job is to *consume* it on returns instead of the current `RETURN-<refundId>-<itemId>` new-batch behavior (`sales.service.ts:2379-2390`).
- Serial precedent: `GET /api/variants/:variantId/serials` with `requireAnyPermission(["pos.create_sale","inventory.view"])` (`sales.routes.ts:78-88`) and `SerialPickerDialog.tsx` (no client-side permission gate; server-side enforcement).
- Only existing batch listing: `GET /api/reports/inventory/batches` (`reports.routes.ts:117-122`, permission `reports.inventory.view`) — report-scoped, not POS-scoped; not reusable for the picker without loosening a report permission (rejected).
- Offline: serial-tracked lines are **hard-blocked** offline (`offline.service.ts:365-370`); offline sales run `createSale` with `{ channel: "offline", allowNegativeStock: true }` and batch shortfalls become `sync_conflicts` rows with reason `batch_shortfall` (`offline.service.ts:392-406`). Payload carries no batch fields today (`sales.schema.ts:20-71`).
- Transfers: `consumeStockFifoAtLocation` (`stockTransfers.service.ts:500-582`) also FIFO-by-id; receive creates `TRF-…` new batches (674-683). Keep separate from FEFO, but align ordering for consistency (decision D8).
- Existing expiry surfaces: batch expiry report (`reports.service.ts:906-955`, status CASE at 933-938) and 7-day `sweepExpiringInventory` job (`commerceJobs.ts:94-133`) with notification dedupe `expiring:<batchId>` (`notifications.ts:119-134`).

### Phase 3 — Sale void with batch-aware restoration

Depends on Phase 2's provenance-based return behavior (same restore machinery).

| Item | New backend API | New/changed tables | New permissions | Frontend surface |
|---|---|---|---|---|
| Sale void | `POST /api/sales/:id/cancel` | `sales.cancelled_by_user_id / cancelled_at / cancel_reason` | **`sales.void`** (backend + frontend mirror + manager template) | Sales page void action + reason dialog |

Verified reversal building blocks that already exist and will be reused (not re-invented):

- Refund/reversal machinery: `applySaleRefund` restock + serial-disposition + due-reduction block (`sales.service.ts:2247-2492`); `reverseLoyaltyPointsInTx` + `restoreRedeemedPointsInTx` (`services/loyalty.ts:771-897`); `reverseCommissionsForRefundInTx`; `postRefundLedgerEntry` (`sales.ledger.ts:248-349`).
- Ledger exact-reversal primitive: `reverseEntry(tx, params)` (`services/ledger.ts:630-766`) — swaps lines, marks original `reversed`, blocks duplicate reversals.
- Drawer: `recordCashRefundInTx` pattern (`cashRegisters.service.ts:1320-1347`) + reference-unique index.
- Locking/idempotency precedents: sale row `.for("update")` (`sales.service.ts:2032`), `saleStatusEnum = ["pending","completed","held","cancelled","refunded"]` (`sales.ts:30-36`) — **`cancelled` already exists in the enum**, so no enum migration is needed.
- Invoice numbers are per-business unique (`sales_business_invoice_unique`, `sales.ts:206-209`) and remain attached to the voided row — never reused. The counter participates in the caller's transaction (`nextDocumentNumber`, `sales.service.ts:1232-1238`), so failed operations never consume a number.
- Approval config: `pos_settings.approval_required.sale_cancel` key **already exists in the type** (`posSettings.ts:18-23`) and `isApprovalRequired(businessId, "sale_cancel")` is the existing gate pattern (`managerApproval.ts:330-342`, used in `createSale` at `sales.service.ts:1133`).

Report/status-predicate review for §3.4 will enumerate every sale-status filter (reports service, dashboard matrix, commissions, cashier/salesperson BI, loyalty, financial statements) before touching any predicate — see §G.4 for the working list.

### Phase 4 — Receipt and customer display depth

| Feature | New backend API | New tables | New permissions | Frontend surface |
|---|---|---|---|---|
| Receipt share link | `POST /api/sales/:id/receipt-link` (create/revoke) + public `GET /api/public/receipts/:token` | `receipt_share_tokens` | none (owner-gated; public route is token-only) | share button in SaleSuccessDialog / Sales page |
| USB receipt Unicode | none | none | none | fallback notice in `usePrintReceipt.ts` flow |
| Multi-display CFD | `POST /api/cfd/push` accepts multiple displayIds (or client fans out) | none | none | CFD target multi-select in `CfdManageDialog.tsx` |

Verified infrastructure:

- `renderReceiptHtml` (`pos/src/features/receipt-settings/renderers/receiptHtml.ts:44`) is **frontend-only**; backend `getSaleReceipt` (`sales.service.ts:574-796`) supplies `SaleReceiptData`. Branding via `DocumentBranding` + `documentSettings` config. Print = iframe `window.print()` (`usePrintReceipt.ts:92-128`); client PDF today exists only for barcode labels (jsPDF, `pos/src/features/barcodes/labelPdf.ts:30`).
- ESC/POS non-ASCII → `?` mapping is explicit at `pos/src/hardware/escpos.ts:42-52` (comment even says Bengali stays on browser-print fallback). Transport is **WebUSB only** (`pos/src/hardware/usb.ts`, printer class code 7); hardware store `useHardwareStore` (`deviceManager.ts:39-69`).
- CFD: pairing = one-time 8-char code (SHA-256 hashed, 10-min TTL) → 48-hex display token stored hashed in `cfd_displays` (`cfd.service.ts:30-102`); SSE at `GET /api/cfd/stream?token=` (`cfd.routes.ts:106-136`); **in-memory fan-out registry holds ONE client per displayId** (`cfd.service.ts:139-147`) — multi-display needs a registry keyed to allow several streams per display (or several displays registered per register); POS target stored in localStorage `"ezpos.cfd.pushDisplayId"` (`CfdManageDialog.tsx:36`, read in `PosPage.tsx:412-423`). Push schema `discountTotal/vatTotal/grandTotal/paidTotal/dueTotal` (`cfd.routes.ts:140-159`).
- Realtime module precedent for multi-client SSE + one-time 30-second tickets: `realtime.service.ts:36-67` — reusable for the receipt-share token design.

### Phase 5 — Bangla localization infrastructure

| Item | Notes |
|---|---|
| Dependency | `react-i18next` + `i18next` (no backend change) |
| Files | `pos/src/i18n/index.ts` (init), `pos/src/i18n/locales/{en,bn}/{common,pos,payment,saleSuccess,register}.json` — resource-per-feature namespaces |
| Screens (initial scope only) | `PosPage`, `CartItems`, `PaymentModal`, `SaleSuccessDialog`, register (open/close drawer) dialog |
| Language control | persisted localStorage key `"ezpos.lang"` (matches existing `ezpos.*` key precedents); selector in header/settings |
| Formatting | money stays `formatCurrency` (`pos/src/lib/format.ts:23`, deterministic `Intl.NumberFormat("en-US")` + `৳` — BDT semantics preserved); dates via `formatDate/formatDateTime` (`format.ts:42-49`) with locale-aware option; receipt formatters stay as-is in Phase 5 |
| SW interaction | `pos/public/sw.js` v2 is network-first for navigations and cache-first only for hashed `/assets/*` — translation JSON imported through the bundle (hashed) automatically busts cache; no SW change needed (verified `sw.js:16-67`) |
| Fallback | `fallbackLng: "en"`; `react-i18next` returns the English string for missing keys — no raw key paths can render (dev-only `saveMissing`/console logging during the program) |

No i18n machinery exists today (verified: no i18next deps, no locale files, ~340 .tsx files with inline English literals).

### Phase 6 — Platform maintenance (NOT included in this program's approval)

TanStack Query migration and large-file refactoring are **excluded** from this plan's approval request, per the prompt. They will be planned separately if you approve them.

### Future verticals — NOT approved scope

Purchase-draft editing, open/custom items, tips, layaway, card terminals, restaurant, tables/KDS, appointments, fiscalization, delivery integrations, webhooks, auto-POs, hardware verification — all out of scope.

---

## B. Additional sale charges — design

### B.1 Data model (proposed)

New child table `sale_charges` (mirrors `sale_payments`/`sale_items` child-table pattern; keeps header lean and makes per-charge auditing/refunds first-class):

```
sale_charges(
  id            serial PK,
  business_id   int NOT NULL FK businesses,
  sale_id       int NOT NULL FK sales ON DELETE CASCADE,
  label         varchar(120) NOT NULL,      -- e.g. "Delivery", "Service fee"
  amount        numeric(10,2) NOT NULL CHECK (amount >= 0),
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz DEFAULT now()
)
-- index (business_id, sale_id); amount in DB stays >= 0; rounding at write time via roundMoney()
```

Rejected alternative: a jsonb `charges` column on `sales` — simpler migration but weaker for refunds/audit/report joins and inconsistent with the codebase's child-table convention (`sale_payments.ts:20-76`, `sale_items.ts:19-129`).

`sales.finalTotal` continues to be the single authoritative inclusive number; charges are components of it (like `deliveryFee` is today for storefront orders — `sales.ts:141-145`).

### B.2 Payload, pricing, and quote parity

1. `charges?: [{ label: string(1..120), amount: number(>=0) }]` added to **both** `quoteSchema` (`salesExchange.controller.ts:93-137`) and `createSalePayloadSchema` (`sales.schema.ts:74-110`), and to the frontend `cartSchema` (`cart.schema.ts:20-63`) + cart store. Zod: label trimmed non-empty, amount finite ≥ 0, max 20 charges, max total charge sanity cap (e.g. ≤ final base — enforced server-side during evaluation, not by magic constant).
2. Server evaluation (single choke point): `chargesTotal = roundMoney(Σ amounts)`; `finalTotal = roundMoney(afterDiscount + vat + chargesTotal)` in **both** `getCartTotals` (`utils/cartPricing.ts:211`) and `getCartTotalsWithTaxRules` (`utils/cartPricing.ts:516`). The quote response gains `chargesTotal` and per-charge echo. `validatePayments` is untouched — paid + due still must equal `finalTotalWithCoupon` (charges are inside it).
3. Client evaluator (`pos/src/features/pos/cartPricing.ts:41-77`) gets the identical formula so the offline/fallback display matches; the server remains authoritative (existing convention, `quote.api.ts:4-9`).
4. **Quote equals checkout** is preserved by construction: `quoteSaleTotals` and `createSale` share the same evaluators; PaymentModal keeps charging `quotedFinalTotal` only.
5. Persistence: sale header insert gains no new money column; `sale_charges` rows are inserted in the sale transaction; `deliveryFee` stays untouched (storefront-only semantics — POS charges must **not** be written into `deliveryFee`, which online profitability treats as shipping income).

### B.3 Tax treatment — **decision for approval (D1)**

Presented options; no tax behavior invented:

| Option | Meaning | Risk |
|---|---|---|
| **A (recommended)** | Charges are **non-taxable, post-VAT additive**. `finalTotal = afterDiscount + vat + Σcharges`. Cleanest parity story; matches typical BD counter-sale delivery/service fees; refund pro-rata is exact. | A business that must VAT its delivery fee can't today. |
| B | Per-charge `taxable` flag (default false); taxable charges join the VAT base before `afterDiscount × vatPercent`. | Touches both evaluators' tax math and inclusive-tax extraction; materially larger blast radius. |
| C | Business-level setting "tax charges" applying to all charges. | Coarse; still needs B's evaluator changes when on. |

Schema headroom: if Option A is approved, `sale_charges` still records `label/amount` only; a future `taxable`/`tax_detail` column can be added later without data rework.

### B.4 Refunds

- `applySaleRefund`'s header delta (`finalTotal − Σ lineTotal`, `sales.service.ts:2044-2048`) automatically includes Σ charges, and its existing pro-rata-by-line-total allocation distributes the charge share across returned lines — so a partial refund refunds the proportional charge share, and a full-return refunds all charges. No separate per-charge refund rows are proposed (decision D2: pro-rata now; explicit charge-level refund selection deferred).
- Cap logic (`refundTotal ≤ finalTotal − prior refunds`, `2127-2139`) already keeps cumulative refunds from exceeding the charged total including charges.
- Refund ledger: `postRefundLedgerEntry` reverses VAT pro-rata as documented approximation (`sales.ledger.ts:263-270`); charges ride the same entry (see B.5).

### B.5 Ledger and reports

- `postSaleLedgerEntry` credit split becomes: `CR 4010 = final_total − vat − delivery_fee − chargesTotal`, `CR 2020 = vat`, `CR 4030 = delivery_fee` (unchanged), plus charges credit. **Decision D3**: charges credit to (a) **4010 Sales Revenue (recommended** — no chart-of-accounts change; POS charges are revenue) or (b) a new `4040 Other Charges Income` account for finer statements. Refund path mirrors under 4020.
- Product gross-margin/profit reports are safe by construction: `getProfitReport`, `getProductSalesReport`, `getGroupProfitabilityReport`, `getProfitByCategory` all aggregate from `sale_items` (verified: `reports.service.ts:524-657, 324-407, 2260-2350`; `dashboardMatrix.service.ts:173+`), so header charges never inflate product revenue or cost. `getSalesSummaryReport` reads `SUM(s.final_total)` for gross sales — charges *should* appear there as revenue (no change needed; noted so nobody "fixes" it later).
- Refund reporting: refund rows already carry the charge share inside `refundTotal`; no new report columns required.

### B.6 Receipt, CFD, offline

- Receipt: new per-charge rows + `Charges` summary row between Discount/VAT block and `FINAL PAYABLE` (`receiptHtml.ts:185-189`); `SaleReceiptData` gains `charges[]` + `chargesTotal`; `getSaleReceipt` selects the new rows (`sales.service.ts:574-796`). A4 invoice renderer mirrors (`invoiceHtml.ts:210-225`).
- CFD: `pushSchema` gains optional `chargesTotal` (default 0) and `buildCfdCartPayload`/`buildCfdPaidPayload` populate it (`cfdPayload.ts:25-104`, schema `cfd.routes.ts:140-159`); `grandTotal` stays the authoritative payable.
- Offline: payload carries `charges[]` verbatim (no client totals exist in the payload by design); `createSale` re-prices at sync, so charges re-apply server-side. Cash/due-only offline payments that no longer match a re-priced total surface through the **existing** payment-mismatch → failed-op/conflict path (`offlineStore.ts:227-250`) — same behavior as any stale-price offline sale today, documented as a known edge, not silently "fixed".
- Held sales: `held_sales` jsonb snapshot gains charges (round-trip through resume).

### B.7 Acceptance (Phase 1 F1)

Quote and checkout agree with charges (parity test); PaymentModal charges exact `finalTotal`; receipts + A4 + CFD show charges; partial refund allocates charge share correctly (ledger + drawer verified); product profitability unchanged; offline sync preserves amounts; idempotent retry (same `idempotencyKey`) does not double-insert charges.

---

## C. Customer credit limits — design

### C.1 Semantics — **decision for approval (D4)**

| Rule | Proposed meaning |
|---|---|
| `credit_limit = NULL` | **Unlimited** — every existing customer (column starts NULL) keeps today's behavior; no backfill. |
| `credit_limit = 0` | **No due allowed** — any sale creating due > 0 is rejected. |
| `credit_limit > 0` | Max allowed **outstanding** (see formula). |
| Scope | One limit per customer, shared across all locations (customers are business-scoped, `customers.ts:15-61`; no per-location credit exists anywhere today). |

Available credit = `credit_limit − customerOutstanding` where `customerOutstanding` uses the **authoritative recomputation** already used by due-management — `final_total − SUM(sale_payments) − SUM(sale_refunds.refund_total)` over non-cancelled sales (`dueManagement.service.ts:273-275`, same formula as summary at 91-106) — not the denormalized `sales.dueAmount` alone (the two are known to be dual truths; the recomputed figure is what the business sees on the due screens).

### C.2 Backend enforcement (no trust in frontend)

Inside `createSale`'s existing transaction, immediately after `validatePayments` (which already guarantees due ≥ 0 and due-requires-customer, `sales.validation.ts:217-236`):

1. `if (dueAmount > 0)`: `SELECT ... FROM customers WHERE id = :customerId AND business_id = :businessId FOR UPDATE` (new lock — customer rows are not locked today; precedent for row-lock + advisory patterns exists at `storeCredit.ts:82-91`, `entitlements.ts:181-186`).
2. Compute `customerOutstanding` for that customer (single aggregate query over sales/payments/refunds).
3. If `credit_limit IS NOT NULL AND customerOutstanding + dueAmount > credit_limit + 0.005` → `throw new ConflictError(...)` → HTTP **409** `{ success:false, message: "Credit limit exceeded for <name>: limit ৳L, already outstanding ৳O, this sale would add ৳D." }` (exact convention: `ConflictError` → 409 via `app.ts:231-233` / `sendSafeError`, as with insufficient store credit, `storeCredit.ts:96-98`).
4. Because the check is inside the sale transaction with the customer row locked, **concurrent due purchases serialize** — two cashiers cannot collectively push a customer past the limit (this is the same serialization argument documented for due collection, `dueManagement.service.ts:505-520`).

The same guard wraps the other due-creating path where relevant (`saleIntents.service.ts:417-463` online partial payments) — flagged during implementation and covered by tests.

### C.3 Restoration paths (already existing, verified)

- Due collection (`POST /api/due-management/customer-payment`) reduces `sales.dueAmount` under a sale-row lock → available credit restores automatically.
- Refunds reduce due for unpaid/partial sales (`applySaleRefund`, `sales.service.ts:2427-2442`) → credit restores proportionally; fully-paid sales don't affect outstanding.
- No new ledger postings are introduced: a credit limit is a policy gate, not money (the existing double-entry stays untouched).

### C.4 Frontend

- `CustomerDialog.tsx` (create/edit): optional `creditLimit` field (empty = unlimited), zod schema extended (`CustomerDialog.tsx:21-26`); backend `createCustomer`/`updateCustomer` extended (`customers.service.ts:17-67`).
- Customers table + POS `CartCustomerInfo` (`CartItems.tsx:165-268`): show `Outstanding / Limit / Available` when a limit is set; overdue indicator when available ≤ 0.
- PaymentModal due row: when the customer has a limit, show available credit next to the due tender and let the 409 message surface verbatim on failure (backend authoritative).

### C.5 Acceptance

Cannot exceed limit (409 with clear message); dues restore credit; concurrent due purchases cannot bypass (two parallel requests test); NULL-limit customers unaffected; refund reduces outstanding; `0` blocks all due sales.

---

## D. Gift-card reload — design

### D.1 API and flow

`POST /api/gift-cards/:id/reload` — route in `giftCards.routes.ts` with the **same stack as paid issuance** (`write` + `requireLocationAccess` + `requirePermission("pos.create_sale")`, `giftCards.routes.ts:25-31`). Request schema: `{ amount: number > 0, paymentMethod: "cash" | "bangla_qr" | "card", reference?: string ≤ 100 }` (same tender set as issuance, `giftCards.controller.ts:8-17`).

Service `reloadGiftCard` (new, in `services/giftCards.ts`) inside one `db.transaction`, strictly following the `issueGiftCard` paid-issuance sequence (`giftCards.ts:75-140`):

1. Lock card row `.for("update")` (same as `redeemGiftCardInTx:244`); reject `status !== "active"` and expired cards (same checks as redeem, `246-251`); reject non-positive amount (roundMoney, `63-65` pattern).
2. Insert `gift_card_transactions` row `{ amount: +amount, sourceType: "reload", sourceId: null, note }` — **this row's id becomes the idempotency anchor** for steps 3–4.
3. `isLedgerActivatedInTx` guard (`103` pattern) → `resolveCashAccountForMethod` (`104-108` pattern) → `postJournalEntry` with `sourceType: "gift_card_reload"`, **`sourceId: giftCardTransactionId`** and lines `DR cash/bank / CR 2040` (liability, mirroring issuance `110-126`).
   - Important: issuance uses `sourceId = giftCardId`, and the journal partial-unique index would silently *reuse* any second posting for the same card (`ledger.ts:464-483`). Using the per-reload transaction id as `sourceId` is what makes reload idempotent without colliding with issuance.
4. Cash reloads: new `recordGiftCardReloadCashInTx` in `cashRegisters.service.ts` cloning `recordGiftCardIssueCashInTx` (`1389-1414`) with `referenceType: "gift_card_reload"`, `referenceId: giftCardTransactionId` → drawer idempotency via `register_transactions_reference_uq` (`registers.ts:259-263`); no-op when no open session (same honest-GL behavior as issuance).
5. Duplicate-reference protection: today's `issueGiftCard` accepts `reference` but never uses it (verified gap, `giftCards.ts:58`). Reload adds `reference` handling: when supplied, a repeat reload with the same `(businessId, giftCardId, reference)` is rejected — implemented via the transaction `note`/reference column on `gift_card_transactions` (see migration J.3) + pre-insert existence check inside the lock, mirroring `isDuplicatePaymentReferenceError` conventions. This also fixes the issue-path gap only if you approve it (D5 — otherwise reload-only).

### D.2 Backend contract changes

- `FINANCE_SOURCE_TYPES` (`services/ledger.ts:56-80`) gains `"gift_card_reload"`.
- `gift_card_transactions_source_valid` CHECK extended to `('issue','redeem','reload')` (migration J.3).
- No new permission (reuses `pos.create_sale` — same as issue/status; **D5** confirms).

### D.3 Frontend

`GiftCardsPage.tsx`: **Reload** action per active card (dialog: amount, payment method cash/bangla_qr/card, optional reference) calling the new endpoint; detail view already lists transactions (`loadDetail`, `GiftCardsPage.tsx:77-84`) — reload rows appear in history and balance updates come from the same `SUM` computation (`giftCards.ts:294-297`).

### D.4 Acceptance

Balance increases exactly once per reload; ledger `DR cash / CR 2040` reconciles; cash reload moves the drawer once (`gift_card_reload` reference); duplicate request (same reference or retried HTTP) adds value zero times; inactive/expired cards rejected; complimentary-style reload (no payment method) is **not** offered (money must be taken — matches paid-issuance-only design).

---

## E. Store-credit expiry — design

### E.1 Policy storage — **decision for approval (D6)**

`pos_settings.store_credit_expiry_months INT NULL` (NULL = no expiry; default for all businesses). Rationale: `pos_settings` is the established per-business singleton with sanitizer conventions (`posSettings.ts:38-90`, `posSettings.service.ts:96-198`), already edited through `PATCH /api/pos-settings` (`settings.edit`). Alternative rejected: a new `store_credit_settings` table — duplicative of the singleton pattern for one policy value.

Refund-generated store credit (`grantStoreCreditInTx` from `applySaleRefund`, `sales.service.ts:2162-2174`) stamps `expiresAt = now + policy months` when a policy is set; NULL policy → NULL expiry (today's behavior).

### E.2 Ledger model (keeps the ledger authoritative)

`customer_credits` gains `expires_at timestamptz NULL` and its CHECK gains `'expiry'` as a source type (migration J.4). Balance stays a pure `SUM(amount)` over rows — **no parallel balance column is introduced**, satisfying "ledger and parallel tracking must not diverge" by construction.

Expiry is recorded as an **explicit negative `expiry` ledger row per customer per sweep** (one aggregated row, mirroring the loyalty sweep's design, `loyalty.ts:971-1029`):

- `consumeStoreCreditInTx` (`storeCredit.ts:64-109`) continues to insert negative `sale_payment` rows unchanged; consumption allocation is **oldest-expiry-first, then oldest-created** — the same FIFO order loyalty redemption uses (`loyalty.ts:704-740`, `ORDER BY expires_at ASC NULLS LAST, earned_at ASC`).
- The sweep computes, per customer, the expired-but-unconsumed amount by **deterministic replay** of that customer's rows (ordered `created_at, id`): grants (positive rows) carry `expires_at`; consumption rows (negative `sale_payment`) and prior negative `expiry` rows consume oldest-expiring grant value first. Any positive grant value that (a) is still unconsumed after replay and (b) has `expires_at < now()` is expired → one negative row `{ amount: -expired, sourceType: "expiry", note: "Store credit expired (sweep <date>)" }` is inserted inside a transaction with the customer's rows `.for("update")` (same lock discipline as consume, `82-91`).
- **Idempotency**: the replay treats prior `expiry` rows as consumption, so re-running the sweep finds nothing left to expire — repeated sweeps cannot double-expire. Concurrent sweep vs checkout is safe via the row locks + `FOR UPDATE SKIP LOCKED` per-customer selection (loyalty sweep precedent, `loyalty.ts:974-986`).

### E.3 Redemption & reads

- `consumeStoreCreditInTx` balance check becomes `SUM` over **unexpired** value after replay-allocation: since the sweep has already converted expired value into explicit negative rows, the plain `SUM` remains correct between sweeps too — but to prevent redeeming not-yet-swept expired credit, the consume path performs the same replay computation inline (cheap: few rows per customer, already locked) rather than a raw `SUM`. This keeps "expired credit cannot be redeemed" true at any moment, not just post-sweep.
- `getStoreCreditBalance` (`storeCredit.ts:18-34`) gets the same replay-based computation so every displayed balance (customer card `CartItems.tsx:189-194`, PaymentModal pre-check `PaymentModal.tsx:114-162`, `GET /customers/:id/store-credit`) is consistent.
- Grant validation: `grantStoreCreditInTx` accepts `expiresAt` (computed from policy at call sites) — `manual`/`sale_payment` sources also stamp policy expiry.

### E.4 Sweep scheduling + audit

- New `runStoreCreditExpirySweep()` added to the scheduler's `Promise.all` job list (`jobs/scheduler.ts:33-45`), following the `runLoyaltyExpirySweep(null)` all-businesses pattern (`scheduler.ts:42`); gated by `JOBS_ENABLED` like the rest.
- Audit: the sweep inserts rows via the store-credit service (audited by the existing audit conventions used by financial services); expired totals are returned like loyalty's `{ customersAffected, storeCreditExpired }`.
- In-app notification: `notifyInTx` with a new `NotificationKind` entry (union `notifications.ts:21-34`) e.g. `store_credit_expired`, dedupe key `store_credit_expiry:<customerId>:<sweepDay>` — the established day-stuffed dedupe (`notifications.ts:47-51`).

### E.5 Acceptance

Credit redeemable before expiry; expired credit never redeemable (mid-window consume test); sweep inserts exactly one expiry row per affected customer and is idempotent (repeat sweep = 0 changes); refund-generated credit carries policy expiry; balances identical across all read paths; ledger stays balanced (expiry rows are customer-credit-ledger entries, not journal postings — the 2050 liability was already amortized… **note for approval (D6b)**: expired store credit was posted as `CR 2050` liability at grant-consumption time; the liability entry is *not* reversed on expiry unless you want a journal adjustment. Proposed default: no journal posting on expiry (the liability remains until consumed by purchase; writing it off is an accountant action via the existing `adjustment` source type). Alternative: sweep posts a `DR 2050 / CR 4010` write-off journal entry with a new `store_credit_expiry` finance source type. Recommendation: **no journal posting** — simplest, conservative, reversible later.)

---

## F. Batch management and FEFO — design

### F.1 Batch picker (POS)

- New endpoint `GET /api/variants/:variantId/batches` in `sales.routes.ts` with the **exact serial-endpoint precedent**: `requireAnyPermission(["pos.create_sale", "inventory.view"])` (`sales.routes.ts:78-88` pattern). Returns for that variant+business+**location** (serial endpoint has no location filter — the batch picker *will* filter by the caller's location to satisfy "do not expose unauthorized batches"; batches are location-scoped, `inventoryBatches.ts:22-25`): `{ id, batchNumber, quantityRemaining, expiryDate, expiryStatus: "valid"|"expiring_soon"|"expired"|"no_expiry" }` reusing the report's status CASE logic (`reports.service.ts:933-938`), ordered FEFO (§F.3), only `quantityRemaining > 0`.
- Frontend `BatchPickerDialog.tsx` modeled directly on `SerialPickerDialog.tsx` (search + list + confirm; no client-side permission gate — server enforces), opened from product add-to-cart / cart line when `trackingType === "batch"` (`ProductList.tsx:436` / `CartItems.tsx:446` insertion points). Near-expiry highlighted; expired rows shown **only** when policy allows override (§F.4), marked and requiring the approval flow.

### F.2 Sale payload + backend validation

- Sale item schema (both quote and create) gains optional `batchId?: number` (only meaningful when the DB says `trackingType === "batch"`; ignored otherwise, like `serialNumbers` for non-serial). Frontend cart item payload mirrors (`cart.schema.ts:68-103`).
- Validation in the sale transaction (before `consumeStockFifo`): batch exists, belongs to `variantId` + `businessId` + `locationId`, `quantityRemaining` covers the line's demand (combined with other lines via the same per-variant demand aggregation `validateStock` uses, `sales.validation.ts:88-144`), and is not expired per policy. Cross-location access is impossible by construction of the WHERE clause. Duplicate batch rows across lines are aggregated, not double-deducted — deduction happens exactly once per line in the consumption step.
- Manual selection **takes precedence** over FEFO: when every batch-tracked line with explicit `batchId`s is satisfied from the selected batches, the remainder (none, in the enforced case) falls back to FEFO — partial manual selection is rejected for clarity ("Batch B has 3 of the 5 units requested") rather than silently split (decision D9).

### F.3 FEFO default consumption

- `consumeStockFifo` ordering changes from `asc(inventoryBatches.id)` (`sales.service.ts:377-402`) to `expiryDate ASC NULLS LAST, id ASC` — earliest valid expiry first, never-expiring batches last, expired batches excluded from the candidate set entirely (WHERE gains `AND (expiry_date IS NULL OR expiry_date > now() OR <policy allows>)`).
- Applies only where batch expiry semantics make sense: batch-tracked products consume FEFO; for `trackingType "none"` products the single AUTO-batch has NULL expiry so ordering degenerates to the current id order — behavior-identical, kept uniform on purpose (one code path, verified harmless).
- `consumeStockFifoAtLocation` (transfers, `stockTransfers.service.ts:500-582`) gets the same ordering + expired-exclusion so transfer truth matches sale truth (**D8**: align transfers in the same commit; transfers of expired stock remain possible via stock-count adjustments, not by silent transfer).
- Serial consumption (`consumeSerials`, `451-556`) is untouched — serials already link to batches and their workflow is distinct; FIFO/FEFO concepts stay separate as required.

### F.4 Expired-batch policy — **decision for approval (D7)**

`pos_settings.expired_batch_policy VARCHAR(20) DEFAULT 'block'` ∈ `'block' | 'allow_with_approval'`:

- `'block'` (default): expired batches are excluded from FEFO candidates, rejected for manual selection, and invisible in the picker (except a muted "expired stock exists" hint so cashiers know why quantity is short). **An expired batch can never be silently sold.**
- `'allow_with_approval'`: expired batches appear flagged; selecting one requires the manager-approval flow — `isApprovalRequired(businessId, "sale_cancel")`-style gate extended with a new op key `"sale_expired_batch"` in `approval_required` (`posSettings.ts:18-23` map, `managerApproval.ts:317-342`), `approvalToken` on the payload (schema already has the field, `sales.schema.ts:102`), and an audit record with actor + reason. No blanket permission is added (approval-based, matching how refunds and below-minimum pricing work).

### F.5 Expiry notifications

Extend the existing sweep rather than adding a new one: `sweepExpiringInventory` (`commerceJobs.ts:94-133`, currently a fixed 7-day window, notification kind `expiring_inventory`, dedupe `expiring:<batchId>`) gains (a) a configurable near-expiry window from `pos_settings` (default 7 days, preserving current behavior) and (b) a complementary **expired** notification (`kind: "expired_inventory"`, dedupe `expired:<batchId>`, per business/location scope — the sweep already groups by business, `123-131`). No real customer messages are involved — in-app notification center only (`notifications.routes.ts`).

### F.6 Returns, exchanges, provenance (the critical part)

- Returns change from "new `RETURN-…` batch" to **restore the original batches recorded in `sale_item_batch_consumptions`** (`sales.service.ts:2379-2390` replaced): per returned quantity, allocate back across the consumed batches (largest-consumption-first) under `.for("update")` locks, incrementing `quantityRemaining` and `inventory_stock` exactly as today. Movements keep `movementType: "return"` but now carry the **original** `batchId`s.
- Fallback: if an original batch no longer exists or is fully consumed (e.g., stock was transferred out mid-lifecycle), the remainder goes to the existing `RETURN-<refundId>-<itemId>` batch at `costAtSale` (current mechanism retained as the escape hatch) — the refund never fails because provenance is incomplete; a note is recorded on the refund row.
- Serials: restock flips serial status per disposition (`2247-2252`) and re-points serials to their **original** batch when that batch was restorable (instead of unconditionally to the RETURN batch, `2391-2410`).
- Exchanges: `createSaleExchange` reuses `applySaleRefund` (`3138`) and consumes replacements via `consumeStockFifo` (`3302`) — both sides automatically inherit provenance restore + FEFO; serial-tracked replacements remain rejected (`3166-3172`).
- **Void-readiness (2.6)**: `sale_item_batch_consumptions` is the shared provenance Phase 3's void will replay. Phase 2 implements and tests restoration-through-refund on that table; void adds no new provenance structure.

### F.7 Offline behavior — **decision for approval (D10)**

- Cached batch info: the offline catalog cache (`offline/catalog.ts`, IndexedDB store `catalog_products`) gains a per-variant batch snapshot (batchId, batchNumber, qty, expiry, status) captured at `prepareOffline` time alongside allocations (`offline/allocations.ts:35-48`).
- Add-to-cart offline: batch-tracked variants require a cached batch selection; `checkAllowance` semantics extend to the selected batch's cached qty.
- Stale data: offline sale payloads carry `batchId`s; at sync, `createSale` re-validates against live batches (location, ownership, availability, expiry policy). Failures surface through the existing machinery: shortfall → `sync_conflicts.reason "batch_shortfall"` (`offline.service.ts:392-406`); expired-selection → new conflict reason `"expired_batch_selected"` added to `OfflineConflictReason` (`offline.ts:98-102`).
- Quantities: offline still allowed for batch products with cached info; if the cache has **no batch rows** for a batch-tracked variant (cache too old), add-to-cart is blocked offline (same conservative stance as serial-tracked hard-block, `offline.service.ts:365-370`). No unsafe silent consumption — verified claims only after implementation.

### F.8 Acceptance (the prompt's matrix, mapped to tests)

Multi-batch FEFO ordering; manual selection honored; expired blocked (or approval-gated); partial return restores original batches (provenance assert); full return restores; exchange moves old/new batches correctly; concurrent sales don't oversell a batch (parallel requests, row locks); offline per policy D10 with conflict reasons; serial behavior intact (existing suites); non-batch behavior unchanged (AUTO-batch degenerate case).

---

## G. Sale void with batch-aware restoration — design

### G.1 Permission and API

- New permission `sales.void` (backend `PERMISSION_CATALOG` under a `// Sales` group, `permissions.ts:18-232`; mirror in `pos/src/lib/rbac.ts`; added to `DEFAULT_ROLE_PERMISSIONS.manager` — following the landed-cost template commit `ed304294`). Enforced with `requirePermission("sales.void")` on the route — UI visibility is not authorization.
- `POST /api/sales/:id/cancel` body `{ reason: string(3..500), approvalToken? }`, route stack `write` + `requireLocationAccess` + `requirePermission("sales.void")` (mirrors refund routes, `sales.routes.ts:52-63`).

### G.2 Business rules

- Only `status = "completed"` sales with **zero existing `sale_refunds` rows** may be voided (decision D11 — voiding partially-refunded sales composes badly with refund-derived credit/loyalty reversals; v1 blocks it with a clear 409). `held`/`pending`/`refunded`/already-`cancelled` are rejected.
- Void is same-business + same-location enforced (the sale row is fetched with both predicates).
- Approval: `isApprovalRequired(businessId, "sale_cancel")` from `approval_required` config (key already typed, `posSettings.ts:18-23`) + `approvalToken` verification via `managerApproval.ts` (refund-path precedent). Wiring needed: `CONFIG_KEY_BY_OP` (`managerApproval.ts:317-324`) gains `"sale.cancel" → "sale_cancel"`, and `APPROVAL_OPS` (`:37-42`) maps the op to the approver permission (`sales.void`). Frontend reuses the existing PIN dialog `ManagerApprovalDialog.tsx` (`pos/src/features/cashRegisters/components/`, `verifyPinApi`) — note refunds today don't yet pass `approvalToken` from the UI; void ships with it wired from day one.
- Reason required; recorded on new columns `sales.cancel_reason`, `sales.cancelled_by_user_id`, `sales.cancelled_at` (migration J.6) — plus the existing audit service records the operation.
- Status flips to `cancelled` (enum value already exists, `sales.ts:30-36`); `invoiceNumber` is preserved forever (per-business unique index keeps the number reserved — `sales.ts:206-209`).
- Double-void protection: status check + sale-row `.for("update")` lock inside the transaction (prevents simultaneous duplicate voids — second transaction sees `cancelled` and fails, the `applySaleRefund:2032` locking precedent). Also note: the terminal/offline client cannot void — no offline op type is added.

### G.3 Atomic reversal (single transaction, every reversal exactly once)

Order inside one `db.transaction`:

1. Lock sale `.for("update")`; re-validate status/refunds/approval.
2. **Inventory restore from provenance**: replay `sale_item_batch_consumptions` rows for the sale → increment `quantityRemaining` on each original batch (`.for("update")`, fallback `RETURN`-style batch only if a batch row vanished — same escape hatch as F.6) → increment `inventory_stock.quantity` per variant → insert `inventory_movements` with a new `movement_type` value? No — reuse existing enum: `movementType: "return"`, `referenceType: "sale_cancel"`, `referenceId: saleId` (enum extension avoided; the movement type set `inventoryMovements.ts:19-26` stays untouched). Serials: all serials with `saleItemId` in the sale → `status: "in_stock"`, `saleItemId: null`, batch re-pointed to the restored original batch.
3. **Drawer**: for each cash payment on the sale, insert `register_transactions` `{ type: "cash_out", referenceType: "sale_cancel", referenceId: saleId }` — `cash_out` is a confirmed value of `registerTransactionTypeEnum` (`registers.ts:47-59`, DECREASING direction). New helper `recordSaleVoidCashOutInTx` cloned from `recordCashRefundInTx` (`cashRegisters.service.ts:1320-1347`) with the same no-open-session honesty fallback (audit `cash.unattributed`, `1287-1299`). Reference-unique index prevents duplicates (`registers.ts:259-263`).
4. **Loyalty**: `reverseLoyaltyPointsInTx` + `restoreRedeemedPointsInTx` (earned points removed, redeemed points returned — `loyalty.ts:771-897`, refund-path reuse).
5. **Coupons/promotions**: release usage counts the way refunds do (the exact release functions used by `applySaleRefund` will be enumerated from its code at implementation; promotions usage counters are decremented in the same transaction).
6. **Commissions**: `reverseCommissionsForRefundInTx` reuse (commission reversal uniqueness was fixed by migration 0077, so reversal entries are safe).
7. **Ledger**: `reverseEntry` on the sale's posted journal entry (`services/ledger.ts:630-766`) — a true mirrored reversal entry, original marked `reversed`, duplicates blocked; **no silent deletion**. `sourceType` of the reversal stays the ledger's own `reversal` semantics; the audit trail keeps both entries. (Alternative — a hand-built `sale_cancellation` FINANCE_SOURCE_TYPE entry — rejected: `reverseEntry` is the exact-reversal primitive already present and tested.)
8. **Due/credit-limit interplay**: a voided sale has no due (only completed sales void; if it had due it wouldn't be `paymentStatus: "paid"`… note: completed ≠ fully paid — a completed sale *can* carry due; void of a due-carrying sale removes its outstanding → available credit restores via the recomputed-outstanding formula, no extra code).
9. Mark `status = "cancelled"` + audit + columns from G.2. Transaction commits atomically; any failure rolls back everything.

### G.4 Reports and dashboards — verified: mostly already void-safe

**Key verified finding:** every sales-status predicate in the codebase filters on `completed` (+ sometimes `refunded`) — never on `cancelled`. Enumerated exhaustively (file:line list held in the audit notes): 18 report functions in `reports.service.ts` (sales summary, by-invoice, product sales, customer sales, refunds, profit, receivables, hourly, tax reconciliation, register close, location comparison, dead stock, channel, CLV, retention, staff performance, forecast, group profitability), the dashboard matrix (`dashboardMatrix.service.ts` — overview, payment breakdown, net profit, return summary), `getSalesData` (`sales.service.ts:239`), due-management reads (`dueManagement.service.ts:104,222,279,1024` + guard `:525`), commissions (`commission.service.ts:547,590` — completed-only), finance statements (`finance.reports.service.ts:609`, `finance.overview.service.ts:488`), reorder demand (`reorder.service.ts:90`), online profitability (`onlineProfitability.service.ts:272,470`), sync + comms filters. Loyalty and customers modules have **no** sale-status filters (verified).

Consequences:

1. **No report predicate changes are needed** — a `cancelled` sale is already invisible to every revenue/performance metric listed above. Phase 3 will **not** blind-edit predicates; instead a verification test asserts a voided sale disappears from sales summary, product sales, profit, dashboard, commission, and financial-statement outputs.
2. The only deliberate surfaces to handle:
   - **Sales list / customer history** (`getSalesData`, `sales.service.ts:239` filters `completed+refunded`): extend to include `cancelled` rows with an explicit status badge so the invoice history stays auditable in the UI (metrics queries unchanged). This is a display-list change, not a metrics change.
   - Due payments against a cancelled sale are already rejected (`dueManagement.service.ts:525`).
   - Journal entries of the voided sale are handled by the G.3 `reverseEntry` (statements read posted entries — reversed entries net out by construction).
3. Commission reversal is handled transactionally in G.3 step 6 (commissions post only for completed sales; void reverses pending entries via the existing refund-path helper).

### G.5 Acceptance

Void cash sale / split-payment sale / loyalty sale / coupon+promotion sale / batch-tracked sale / serial-tracked sale / sale-with-charges — each reversed exactly once (stock, batch rows, serials, drawer, loyalty, coupon counts, commissions, journal); double void 409; unauthorized void 403; concurrent void serialized; invoice number never reused; reports exclude voided sales; drawer movements verified; original audit history intact.

---

## H. Receipt share link + PDF, USB Unicode, multi-display CFD — design

### H.1 Receipt share link (N1-10)

- New table `receipt_share_tokens` (`id, business_id, sale_id, token_hash (sha256, unique), expires_at, revoked_at, created_by, created_at`) — **hashed tokens**, mirroring the CFD display-token model (`cfd.service.ts:84-94`), which is the codebase's secure-token precedent (realtime tickets are 30-second ephemeral; a receipt link needs hours/days, so the CFD long-lived-token pattern is the right donor, not the ticket one).
- `POST /api/sales/:id/receipt-link` `{ ttlHours: 24|72|168 }` → returns the **plaintext token once**; `DELETE` (or `POST .../revoke`) revokes. Route gated by `requirePermission("sales.view")` + business/location scoping. Sale id is never in the URL — only the random token (`/receipt/t/<token>` frontend route, public in the SPA).
- Public render: `GET /api/public/receipts/:token` (no auth; rate-limited) validates hash + expiry + not-revoked + business active, then returns the same `getSaleReceipt` payload (`sales.service.ts:574-796`) **plus** the business `DocumentBranding`. The public page renders with the **existing** `renderReceiptHtml` renderer (`receiptHtml.ts:44`) — no second receipt engine. PDF = the browser print dialog's "Save as PDF" via the existing iframe-print helper (`usePrintReceipt.ts:92-128`); no server-side PDF dependency added.
- Privacy: expiry enforced server-side on every fetch; default TTL 72 h; share button lives in `SaleSuccessDialog`/Sales page alongside existing WhatsApp/text share; customer PII exposure limited to what receipts already contain.
- **Decision D12**: WhatsApp share of the link reuses the existing share plumbing (the receipt-share URL is just text) — no new provider integration.

### H.2 USB receipt Unicode (N1-02)

- In `usePrintReceipt.ts` USB path (`191-205`): before calling `hardware.printReceipt`, scan the payload strings (shop name, items, footer, money strings — note `৳` itself is > 0xFF!) with a `/[\u0080-\uFFFF]/` test. If any non-Latin-1 character exists:
  1. Skip the ESC/POS attempt entirely (don't print `?` garbage),
  2. Fall through to the browser-print path (full Unicode),
  3. Surface a one-line notice in the print dialog ("USB printer can't render Bangla/₹-style characters — opened the browser print dialog instead. See Receipt settings.")
- Standard ESC/POS printing is preserved byte-for-byte for ASCII/Latin-1 receipts (verified mapping at `escpos.ts:42-52`). Image-based ESC/POS is explicitly **not** implemented (stretch goal per prompt).

### H.3 Multi-display CFD (N1-08)

- Backend: the fan-out registry becomes a `Map<number, Set<Response>>` (multiple SSE clients per displayId — a display may legitimately be open in two tabs; push writes to all members, dropping dead sockets on write failure). `POST /api/cfd/push` schema gains `displayIds?: number[]` (preferred) while keeping `displayId` for backward compatibility — push fans out to every listed display, each validated for the caller's business (`pushPayload` ownership check, `cfd.service.ts:173-203`). Cross-register/cross-business leakage stays impossible: displays belong to the business and the POS picks only its own business's displays.
- POS: `CfdManageDialog.tsx` target list becomes multi-select (checkboxes over `GET /api/cfd/displays`, connection status from `lastSeenAt`); localStorage target becomes `"ezpos.cfd.pushDisplayIds"` (array) with a migration read of the old single-id key; `PosPage` push effect sends to all selected ids; disconnected displays show status but are skipped on push until reconnected (SSE auto-reconnect already exists, `CfdDisplayPage.tsx:54-67`).
- Existing one-display flows keep working (old `displayId` accepted; single-selection UI still possible).

---

## I. Bangla localization — design

- Dependencies: `i18next`, `react-i18next` (frontend only; no backend change, no schema change).
- Init: `pos/src/i18n/index.ts` — `fallbackLng: "en"`, `interpolation.escapeValue: false`, resources bundled (imported JSON → hashed assets → SW-cache-safe, verified §Phase 5 row), `returnNull: false`, dev-only `saveMissing` + missing-key console logger during the program; **`parseMissingKeyHandler` falls back to the key's English default via `defaultValue` in `t()` calls** — no raw key path can ever render (belt: `fallbackLng`; suspenders: every `t()` call passes a `defaultValue` equal to the current English string).
- Keys: stable, feature-scoped — `pos.cart.*`, `pos.payment.*`, `pos.success.*`, `pos.register.*`, `common.*` — organized under `pos/src/i18n/locales/{en,bn}/`. The five initial screens get `t()` with preserved English as `defaultValue` (zero visual change in `en`).
- Language control: header/settings control writing `"ezpos.lang"`; `i18next-browser-languagedetector` **not** added (one manual reader/writer matches the codebase's minimal-dependency style — existing `ezpos.*` localStorage keys are hand-managed).
- Numbers/money/dates: money keeps `formatCurrency` (deterministic, `৳`, `format.ts:23`) — **BDT semantics and digit grouping stay Latin** in Phase 5 (Bangla numerals are a later approved phase; mixing digit systems in a till UI is a correctness risk, flagged in the report). Dates: `formatDate/formatDateTime` gain an optional locale parameter fed from the active language (`date-fns` supports `bn` locale; `format.ts:42-49`).
- Checkout safety: language switch re-renders labels only; PaymentModal math and quote consumption are language-independent (no strings in the pricing path — verified). Acceptance: switch en→bn→en, complete a sale in both, verify dialogs/errors/dates/amounts, zero raw key paths visible, all checkout controls operable.
- Bangla terminology: translated by intent, not literal machine translation (e.g., due = বাকি, cart = কার্ট, checkout = পেমেন্ট) with a terminology table maintained in the phase report; cashier-understandable phrasing prioritized.

---

## J. Database migration proposal (numbering starts at 0080 — verified)

All hand-written SQL, each with `-- NNNN: <label>.` header + rationale + `-- Rollback:` line (convention quoted from 0077/0078/0079), `--> statement-breakpoint` separators, and a matching `_journal.json` entry `{ idx, version: "7", when (monotonic!), tag, breakpoints: true }`. Renumber check before each phase commit (git log for concurrent merges — the renumber discipline used in programs 0044-0048). Applied to `ezpos_test` only, with `SELECT current_database()` verified first.

| # | Name | Reason | Tables/changes | Rollback |
|---|---|---|---|---|
| 0080 | `sale_charges` | F1 charges storage | new `sale_charges` table + `(business_id, sale_id)` index | `DROP TABLE sale_charges` |
| 0081 | `customer_credit_limit` | F2 | `customers.credit_limit numeric(14,2) NULL` | `ALTER COLUMN DROP DEFAULT / DROP COLUMN` (NULL-first, no backfill) |
| 0082 | `gift_card_reload` | F3 | `gift_card_transactions_source_valid` CHECK extended to `('issue','redeem','reload')`; nullable `reference varchar(100)` + partial unique index `(business_id, gift_card_id, reference) WHERE reference IS NOT NULL` | restore old CHECK (fails if reload rows exist — document), drop index/column |
| 0083 | `store_credit_expiry` | F4 | `customer_credits.expires_at timestamptz NULL`; CHECK `customer_credits_source_valid` extended to `('refund','sale_payment','manual','expiry')`; index `(business_id, customer_id, expires_at)` | drop index/column; CHECK restore (fails if expiry rows exist — document) |
| 0084 | `pos_batch_and_expiry_settings` | F4 policy + Phase 2 policy + near-expiry window | `pos_settings.expired_batch_policy varchar(20) DEFAULT 'block' CHECK in ('block','allow_with_approval')`; `pos_settings.store_credit_expiry_months int NULL`; `pos_settings.expiry_warning_days int DEFAULT 7` | drop columns (defaults preserved behavior) |
| 0085 | `sale_void_columns` | Phase 3 | `sales.cancel_reason varchar(500) NULL`, `sales.cancelled_by_user_id int NULL FK users`, `sales.cancelled_at timestamptz NULL` | drop columns |
| 0086 | `receipt_share_tokens` | Phase 4 | new `receipt_share_tokens` table (hashed token unique, expires_at, revoked_at) + index on `(business_id, sale_id)` | `DROP TABLE` |

Phase 5 (i18n) needs **no migration**. F5 (split payments), batch picker, FEFO, provenance-restore, multi-CFD, Unicode fallback need **no migration** (no schema change — verified per section).

Backfill: none required anywhere (all new columns nullable/defaulted; existing customers unlimited, existing credit never expires, existing batches behave per `'block'` policy identically to today except expired exclusion — which is the approved intent).

Tenant/location implications: every new table carries `business_id` with FK + index (matching `sale_payments`/`journal_entries` conventions); `sale_charges` is location-agnostic by design (belongs to the sale, which is location-scoped).

---

## K. Permission proposal

| Permission | Backend `permissions.ts` | Frontend `pos/src/lib/rbac.ts` | `DEFAULT_ROLE_PERMISSIONS` | Enforced at |
|---|---|---|---|---|
| `sales.void` | new key (module `sales`) | mirror | `manager` (NOT cashier) | `POST /api/sales/:id/cancel` route + UI gating |
| expired-batch override | **no new permission** (D7: approval-token flow via `approval_required.sale_expired_batch`) | n/a | n/a | `createSale` approval check |
| gift-card reload | none (reuses `pos.create_sale`, identical to issuance) | n/a | n/a | route stack |
| receipt link create/revoke | none (reuses `sales.view`) | n/a | n/a | route stack |
| credit limit edit | none (reuses `customers.edit`) | n/a | n/a | existing customer routes |
| CFD multi-target | none (reuses `cash_register.view` / `settings.edit`) | n/a | n/a | existing routes |

Both catalogs updated atomically in the same commit as the backend key; `ensureRbacSeed()` reseeds idempotently at startup (`permissions.ts:1-10` docblock) so the `permissions` table picks the key up without manual SQL.

---

## L. Testing strategy

### L.1 Backend (node:test + tsx, `ezpos_test` only, `INTEGRATION_TESTS=1`)

New suites under `src/test/` following `payments.integration.test.ts` conventions (`createOwnerCtx` fixtures, `ensureRbacSeed()`, DB-name guard):

- `saleCharges.integration.test.ts` — quote/checkout parity with charges; receipt payload; refund charge-share; offline sync with charges; idempotent retry; report exclusion (product profit unchanged).
- `creditLimit.integration.test.ts` — limit enforcement + 409 message; NULL/0 semantics; concurrent due purchases (parallel requests against one customer); due collection restores; refund reduces outstanding; cross-location single limit.
- `giftCardReload.integration.test.ts` — happy path per tender; ledger `DR/CR` reconciliation; drawer cash-in once; duplicate reference/idempotent retry; inactive/expired rejection.
- `storeCreditExpiry.integration.test.ts` — grant with policy; redeem before expiry; expired unredeemable mid-window; sweep idempotency (double run = 0 delta); refund-credit expiry stamping.
- `batchFefo.integration.test.ts` — the full F.8 matrix incl. FEFO ordering with NULL expiry, manual selection, expired policy both modes, partial/full returns restoring original batches, exchange, concurrent batch sales, offline conflicts.
- `saleVoid.integration.test.ts` — the full G.5 matrix incl. concurrent void and every reversal-once assertion.
- `receiptShare.integration.test.ts` — token create/validate/expire/revoke; tenant isolation; public fetch without auth.

### L.2 Frontend (vitest + MSW, existing patterns)

- Charges editor in cart + totals display (`PaymentModal` untouched behavior asserted — it must still charge `quotedFinalTotal`).
- Credit-limit fields in `CustomerDialog` + POS customer card display + 409 surfacing.
- `BatchPickerDialog` (list, FEFO order, expired gating).
- GiftCardsPage reload dialog + history.
- PaymentModal generalized split builder (all methods selectable, balance pre-checks preserved).
- i18n: language switch renders bn strings on the five screens; fallback when a key is missing (defaults render, not raw keys).
- Receipt share button + fallback notice for USB Unicode.

### L.3 Regression scope per phase

Phase 1: full payments/sales/offline/returns suites + `crossMode.integration.test.ts`. Phase 2: all sales/returns/inventory/stockTransfer/offline suites. Phase 3: reports/dashboard/loyalty/commissions suites + financial statement tests. Phase 4: receipt/documentSettings/comms suites. Phase 5: pos frontend suite + e2e smoke (`pos-checkout.spec.ts`).

### L.4 Baseline discipline

Before Phase 1 commit: clean serial re-run of `npx vitest run` (today's 24-failure run happened while the backend integration suite ran concurrently — durations of 5–80 s indicate timeout pressure; a clean baseline must be captured and its exact failing list recorded, whatever it turns out to be). Backend full-suite baseline is now recorded: **1035/1035 pass, 0 fail, 0 skipped** — compared against at program end. The four `terminalBinding`-era failures no longer exist on this tree (UI/UX program fixed them, commit `0211ed60` lineage); any failure found in the clean run is either pre-existing (recorded, tolerated per the prompt's rule) or investigated.

### L.5 Verification gates (per phase, before commit)

`npx tsc --noEmit` (both apps) → `npm run build` (pos) → targeted suites → `npx vitest run` → full backend suite at program end. Migration application always preceded by `SELECT current_database()` = `ezpos_test`.

---

## M. Dependencies and risk assessment

```
Phase 1 (money) ──► Phase 2 (batch/FEFO) ──► Phase 3 (void)
                                    │                ▲
                                    └── provenance restore machinery ─┘
Phase 4 (receipt/CFD)  independent of 1-3 (touches PaymentModal-adjacent UI only)
Phase 5 (i18n)         after Phase 1 (PaymentModal strings extracted once, not twice)
Phase 6 (maintenance)  NOT approved — separate program
```

Top risks, honestly stated:

1. **Pricing parity** — charges touch both evaluators and both payload schemas; mitigated by the single-choke-point change + dedicated parity tests + PaymentModal regression tests.
2. **Consumption reorder (FEFO)** — touches the hottest financial-adjacent code path (`consumeStockFifo`); mitigated by degenerate-case equivalence for non-batch products (verified NULL-expiry ordering), golden tests on blended `costAtSale`, and keeping serial path untouched.
3. **Return provenance flip** — changes return batch semantics; mitigated by the explicit RETURN-batch fallback and batch-restoration assertions in tests.
4. **Void breadth** — the reversal touches many subsystems; mitigated by reusing refund machinery + `reverseEntry`, status-predicate enumeration before edits, and a dedicated void suite.
5. **Store-credit replay computation** — new algorithm on the credit ledger; mitigated by property tests (balance conservation: Σgrants − Σconsumption − Σexpiry = displayed balance at every step) and row-lock discipline copied from the loyalty sweep.
6. **Frontend baseline noise** — today's contended vitest run isn't a clean baseline; clean capture is a hard prerequisite recorded in the phase report.
7. **Offline batch behavior** — can only be claimed after sync-conflict tests pass (prompt explicitly forbids unverified claims; D10 keeps offline conservative).
8. **Journal/`when` monotonicity** — any migration renumbering must keep `when` ascending (documented gotcha; journal verified monotonic today).

---

## N. Decisions requiring explicit approval before implementation

| # | Decision | Recommendation |
|---|---|---|
| D1 | Charge tax treatment | **A: non-taxable, post-VAT additive** (B per-charge flag / C business setting deferred) |
| D2 | Charge refunds | pro-rata by line total via existing delta mechanism; no per-charge refund selection in v1 |
| D3 | Charge ledger classification | **4010 Sales Revenue** (no COA change); alternative: new 4040 account |
| D4 | Credit-limit semantics | NULL = unlimited, 0 = no due, one business-wide limit per customer |
| D5 | Gift-card reload | reuse `pos.create_sale`; add reference-idempotency to reload; fix issue-path reference gap? (yes/no) |
| D6 | Store-credit expiry | policy on `pos_settings.store_credit_expiry_months`; explicit negative `expiry` rows; **no journal write-off posting** (D6b: alternative is DR 2050/CR 4010 with new finance source type) |
| D7 | Expired-batch policy | `pos_settings.expired_batch_policy` = `'block'` default / `'allow_with_approval'` via manager-approval op `sale_expired_batch` (no new permission) |
| D8 | FEFO scope | reorder `consumeStockFifo` + align `consumeStockFifoAtLocation` (transfers) |
| D9 | Partial manual batch selection | reject with explicit error (no silent FEFO top-up) |
| D10 | Offline batches | allowed with cached batch info; blocked when cache lacks batches; sync revalidates; new conflict reason `expired_batch_selected` |
| D11 | Void eligibility | `completed` status only, zero prior refunds, reason mandatory, approval via `approval_required.sale_cancel` |
| D12 | Receipt share | hashed-token table + public renderer reusing `renderReceiptHtml`; TTL 72 h default; PDF via browser print |

---

## O. Out-of-scope reaffirmation

Per the prompt: P2 findings A1-006/007/008, B1-01, H1-05, F1-04, F1-06, O1-*, customer archive columns, money-formatter consolidation, POS hot-path memoization are **not** pulled in. `POS_GAP_CLOSURE_TRACKER.md` is not modified. Phase 6 and all future verticals require separate approval. No push, no force-push, no history rewrite, no remote changes at any point; commits only after each approved phase passes its gates; `cj-tmp.txt` (if present) never touched.

**STOP — this plan is the first deliverable. Implementation begins only after your explicit approval of the plan and the D1–D12 decisions.**
