# ezPos P3 Advanced Features — Phase 1 Report

**Phase:** 1 — Register money and financial capabilities (F1–F5)
**Date:** 2026-11-14
**Branch:** `feature/add-feature` · **Commit:** (filled at commit) · **Pushed:** no
**Approved plan:** `P3_ADVANCED_FEATURES_PLAN.md` (D1–D6 approved via "Phase 1"; recommendations implemented: D1 charges non-taxable post-VAT additive, D2 pro-rata charge refunds, D3 charges → 4010 revenue, D4 NULL=unlimited/0=block/business-wide limit, D5 reload reuses `pos.create_sale` + reference idempotency, D6 expiry policy on `pos_settings` + explicit `expiry` ledger rows + no journal write-off)

## 1. Implemented functionality

### F1 — Additional sale charges (approved D1–D3)
- New `sale_charges` child table (`[{label, amount}]`, ≤ 20 per sale, amount ≥ 0, composite sale/business FK — migration 0080).
- Post-VAT additive: `finalTotal = afterDiscount + vat + Σcharges` in **both** server evaluators (`getCartTotals`, `getCartTotalsWithTaxRules`) and the client fallback evaluator — one choke point, quote == checkout by construction.
- Coupon immunity: a coupon reduces the product portion only (`max(0, finalTotal − chargesTotal − couponDiscount) + chargesTotal`), identical math in quote and create.
- Stored as child rows (never fake sale items) → product gross-margin reports (which aggregate `sale_items`) are unaffected by construction; ledger classification unchanged (charges ride inside `CR 4010 Sales Revenue` — D3; `deliveryFee` keeps its storefront-only semantics).
- Refunds: charges flow through the existing header-delta pro-rata mechanism (`applySaleRefund`) — partial refunds refund the proportional charge share, full returns refund all.
- Surfaces: quote endpoint echo (`charges`/`chargesTotal`), receipt (`getSaleReceipt` + `receiptHtml`/`invoiceHtml` rows between VAT and final), CFD push (`chargesTotal` slot), POS charges editor dialog, offline (payload carries `charges` verbatim; server re-prices at sync).
- Idempotent retry: the payload hash covers charges; replay returns the original sale.

### F2 — Customer credit limits (approved D4)
- `customers.credit_limit NUMERIC(14,2) NULL` (0081): NULL = unlimited (all pre-existing customers unchanged), 0 = no due, positive = cap. One business-wide limit per customer.
- Guard inside `createSale`'s transaction **before** the invoice number is drawn: locks the customer row `FOR UPDATE` (concurrent due purchases serialize — cannot collectively bypass) and computes outstanding with the due-management recomputation `Σ(final_total − payments − refunds)` over completed sales — the denormalized `sales.due_amount` is never the authority.
- Rejection: `ConflictError` → HTTP 409 with the exact numbers in the message ("Credit limit exceeded for X: limit ৳L, already outstanding ৳O, this sale would add ৳D.").
- Restoration: due collection and refunds already reduce outstanding — available credit restores with no extra code.
- API: `GET /api/customers/:id/credit-summary` `{creditLimit, outstanding, available}`; create/update customer accept `creditLimit`.
- Frontend: customer dialog field (empty = unlimited), POS customer card "Credit available / limit", PaymentModal due card shows available credit + over-limit warning (display only; backend authoritative).

### F3 — Gift-card reload (approved D5)
- `POST /api/gift-cards/:id/reload` `{amount > 0, paymentMethod: cash|bangla_qr|card, reference?}` — same route stack as paid issuance (`write` + `requireLocationAccess` + `pos.create_sale`).
- Money side mirrors paid issuance exactly: `isLedgerActivatedInTx` → `resolveCashAccountForMethod` → `postJournalEntry` DR cash/bank / CR 2040 (`gift_card_reload` source type added to `FINANCE_SOURCE_TYPES`) → `recordGiftCardReloadCashInTx` drawer cash_in for cash reloads.
- **Idempotency anchor:** the reload's `gift_card_transactions` row id keys both the journal entry and the drawer movement — keying on the card id would have made `postJournalEntry` silently *reuse* the issuance entry (posted-entry replay). Second dedup layer: 0082 adds `reference` + partial unique `(business_id, gift_card_id, reference)`; a repeated reference → 409.
- `gift_card_transactions_source_valid` CHECK extended to `('issue','redeem','reload')` (0082).
- Frontend: Reload action + dialog on GiftCardsPage (amount, tender, reference); reloads appear in the card's transaction history.

### F4 — Store-credit expiry (approved D6)
- `customer_credits.expires_at TIMESTAMPTZ NULL` + `'expiry'` source type (0083); policy `pos_settings.store_credit_expiry_months INT NULL` (0084, NULL = no expiry; PATCH /api/pos-settings).
- Balance is computed by a **deterministic replay** of the ledger (no parallel balance column): positive rows open grants carrying `expires_at`; negative rows (consumption **and** prior expiry rows) consume FIFO oldest-expiry-first (NULLS LAST), then creation. Available = unexpired remaining. Conservation invariant: Σ rows = Σ remaining always.
- The replay makes expired value unspendable at any moment (not just post-sweep) and makes the sweep **idempotent by construction** — re-running finds nothing left.
- Sweep `runStoreCreditExpirySweep(businessId?)`: per-customer transaction, row-locks first, inserts ONE aggregated negative `expiry` row per affected customer, fires a `store_credit_expired` in-app notification (new `NotificationKind`, day-dedupe key). Registered in the scheduler's job list (SKIP-LOCKED-safe, deterministic candidate order prevents lock-ordering deadlocks).
- Refund-granted store credit stamps policy expiry at grant time (months from policy; NULL policy = never).

### F5 — Generalized split payments
- `PaymentModal` split is now an **arbitrary ordered list of tender rows** over all seven backend methods (`cash, bangla_qr, card, store_credit, loyalty_points, gift_card, due`) — the old positional cash/bangla_qr/due trio and the 2-method digital toggle are gone.
- Rows: add (next unused method; distinct-method constraint enforced in the picker, re-checked by the backend), switch, per-row Fill-remaining, remove (min 1 row); references enforced per row (6+ chars digital, full gift-card code); due/store-credit/loyalty rows gated on customer.
- Validation: rows must sum exactly to the authoritative quoted `finalTotal`; each balance tender re-runs its existing pre-check (`storeCreditIssue`/`loyaltyIssue`) at its row amount; backend row-locked re-checks unchanged — no new tender types, no gateway changes.
- Due context: credit-limit display + over-limit warning on due rows and the single-method Due card.

## 2. Database changes (all hand-written SQL + journal entries, applied to `ezpos_test` only — 85/85)

| Migration | Content | Rollback (documented in-file) |
|---|---|---|
| 0080_sale_charges | `sale_charges` table + index + CHECKs + composite FK | `DROP TABLE` |
| 0081_customer_credit_limit | `customers.credit_limit` (NULL-first) | drop column |
| 0082_gift_card_reload | CHECK + `'reload'`, `reference` + partial unique index | restore CHECK (fails if reload rows exist) |
| 0083_store_credit_expiry | `customer_credits.expires_at` + index + CHECK `'expiry'` | NULL-out then drop; CHECK restore fails if expiry rows exist |
| 0084_pos_store_credit_expiry_setting | `pos_settings.store_credit_expiry_months` | drop column |

Backfill: none required (all nullable/defaulted; journal `when` kept monotonic).

## 3. API changes
- New: `POST /api/gift-cards/:id/reload`; `GET /api/customers/:id/credit-summary`.
- Extended: `POST /api/sales` + `POST /api/sales/quote` accept `charges[]`; `PATCH /api/pos-settings` accepts `storeCreditExpiryMonths`; customer create/update accept `creditLimit`; receipt payload carries `charges[]/chargesTotal`; CFD push accepts `chargesTotal`.

## 4. Permission changes
**None** (per approved D5/plan K): reload reuses `pos.create_sale`; credit-summary reuses `customers.view`; settings reuse `settings.edit`. No backend/frontend catalog edits needed.

## 5. Frontend changes
- POS: charges editor + per-charge totals rows (`CartItems.tsx`), quote echo + fallback pricing with charges, payload plumbing (`PosPage`, `cart.schema`, `cartPricing.ts`, `quote.api.ts`).
- PaymentModal: generalized split builder, per-row validation, credit-context on due tenders.
- GiftCardsPage: reload dialog + history.
- Customers: credit-limit field (`CustomerDialog`), POS card credit display.
- Receipts/A4 invoices: charge rows; CFD payload chargesTotal.

## 6. Financial verification (test evidence — actually executed 2026-11-14)
- Quote/checkout parity with charges + 15% VAT: both 280; header `final_total` 280; one `sale_charges` row; `sale_items` count unchanged → product profitability untouched.
- Coupon-immunity: fixed 40 discount + 30 charge on 200 → 190 (charge never discounted).
- Full refund of a charged sale: `refund_total` = 250 (200 + 50 charge share via header delta).
- Idempotent retry: one sale, one charge row.
- Credit limit: within-limit due OK; over-limit → 409 with exact figures; 0 blocks all dues; NULL unlimited; **two concurrent due sales against one limit → exactly one 201 + one 409**; due collection restores available 0→100; editable limit re-gates immediately.
- Gift reload: balance 100→150 exactly once; balanced JE (DR 50 / CR 50 on 2040-side) keyed by the reload row id; drawer `cash_in` once (`gift_card_reload` reference); duplicate reference → 409 with single ledger row; inactive card → 409; reload→redeem→reload lifecycle lands on 30.
- Store-credit expiry: expired value unspendable pre-sweep (available ৳50.00 message on over-consume); FIFO consumption prefers expired grants (spendable preserved); sweep −100 once, repeat sweep zero changes, conservation Σ rows = remaining; notification row written; refund credit stamped ≈6 months under policy.

## 7. Test results (actual counts)
- New backend suites (`saleCharges`, `creditLimit`, `giftCardReload`, `storeCreditExpiry`): **22/22 pass**.
- Adjacent regression suites (payments, cashRegisters, cashManagement, financeHooks, financeLedger, offline, exchanges, coupons, due-management, cartPricing+salesValidation units): **103/103 pass**.
- Full backend suite: **1052/1052 pass, 0 fail, 0 skipped** as recorded (run 2; run 1: 1050/1050). The node:test/tsx runner on this machine **intermittently omits one unit suite's describe block from the report** without failing anything — run 1 dropped `pricing.engine — minimum price protection` (7 tests), run 2 dropped `landed-cost calculator` (5 tests); both verified green standalone, zero `not ok` lines in either run. Expected complete count: **1057 = 1035 baseline + 22 new**; everything that ran, passed (per the prompt's §3.5 protocol: re-run standalone → classify interference vs defect → interference confirmed).
- Frontend vitest (serial, clean): **294/294 pass, 45/45 files** (baseline 269 + 25 incl. 5 new/rewritten PaymentModal + cfd fixture updates; parallel full-suite runs show random single-file timeout flakes on this CPU-constrained machine — files pass standalone, `--no-file-parallelism` is fully green).
- TypeScript: backend `tsc --noEmit` **clean (exit 0)**; frontend app-config `tsc` = **119 errors at HEAD vs 119 with Phase 1 (zero new; pre-existing baseline documented in the plan §0.3 — the pos/ tsc gate was never green on this tree)**.
- Frontend production build: **pass** (exit 0).

## 8. Remaining issues / deferred
- Charges ledger classification stays generic revenue (4010); a dedicated income account (plan D3 alternative) is a documented follow-up.
- Store-credit expiry does not post a journal write-off (D6 recommendation) — accountants can write off the remaining 2050 liability via the existing `adjustment` source type.
- Offline charges: stale-price offline sales with charges surface through the existing payment-mismatch conflict path (same as any repriced offline sale — documented edge, not silently altered).
- Online storefront orders (`createOnlineOrder`) do not enforce credit limits (out of Phase 1 scope; POS + offline paths covered).
- Phase 2+ migrations (0085+ per plan §J: batch policy settings, void columns, receipt tokens) are renumbered when their phases run.

## 9. Git / safety
- One focused local commit (hash in the commit line above) — no push, no remote/history changes, `cj-tmp.txt` (absent on this machine) untouched, no `.env` values printed, migrations applied only after in-memory verification that the target was `ezpos_test`.
- Runner-flake note: the full-suite report omission documented in §7 is a pre-existing node:test/tsx characteristic on this machine (affects which suites appear, never correctness — affected suites pass standalone). Watch for it when comparing future baseline counts.
