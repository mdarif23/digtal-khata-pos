# ezPos Business Finance & Growth — Phase 0 Audit & Architecture Report

**Date:** 2026-11-07 · **Branch:** `feature/finance-growth` · **Status: AWAITING APPROVAL — no code, schema, or data changed.**

**Audited:** `ezPosBackend/` (Express 5 + TypeScript + Drizzle + PostgreSQL, migrations 0000–0052), `pos/` (React 19 SPA). All findings carry `file:line` references (paths relative to the repo root).

---

## 0. Executive summary

The existing system is a collection of **consistent single-entry ledgers** with strong per-document engineering invariants — every money write is transactional, row-locked, idempotent, tenant-scoped, and audit-logged — and a **real FIFO cost-layer chain** (`inventory_batches.landed_cost_per_unit` → `sale_item_batch_consumptions` → `sale_items.cost_at_sale`). That is a solid foundation.

What does **not** exist anywhere: a general ledger, chart of accounts, journal, posting engine, bank/MFS account entity, owner capital, payroll, loans, other income, period close, or any P&L / cash-flow / balance-sheet statement.

**Recommendation (matches your instinct): adopt a centralized double-entry ledger** as the foundation, implemented *minimally*: 5 new core tables (`chart_of_accounts`, `accounting_periods`, `journal_entries`, `journal_entry_lines`, `payment_accounts`) behind a single `postEntry()` gateway, with **event-time posting hooks** added to existing flows phase by phase. Existing module ledgers (sale_payments, expense_payments, register_transactions, batch cost layers, customer_credits, gift_card_transactions, loyalty_ledger) remain the *operational* source of truth; the GL is the *financial* projection of them. No duplicate financial system is created — the ledger never invents amounts, it derives them from the documents you already have.

**Top risks found (details §5):**
1. Dashboard "sales" counts fully-refunded invoices as gross revenue (`dashboardMatrix.service.ts:75-91`).
2. Coupon discount missing from `sales.discount` — header identity `subtotal − discount − vat = final_total` breaks (`sales.service.ts:887-889` vs `:922`).
3. Unpaid sale + store-credit refund = customer paid twice with credit (receivable reduced **and** credit granted, `sales.service.ts:1435-1444` vs `:1579-1589`).
4. "Collections" metrics count store-credit/loyalty/gift-card redemptions as cash (`dueManagement.service.ts:152-157, 756-765`).
5. Supplier payments never touch any cash/bank record — paid-out cash is invisible outside `purchase_payments` (`dueManagement.service.ts:644-747`).
6. Gift-card issuance creates a liability with **no funding entry** anywhere (`services/giftCards.ts:47-100`).
7. Tax reconciliation report ignores refunds and the location filter entirely (`reports.service.ts:1262-1336`).

**Decisions requested from you:** §14 (ledger history policy, payment accounts scope, approval to proceed).

---

## 1. Method

Read-only inspection: Drizzle schema (110 files), all 53 migrations, the sales/purchases/expenses/dueManagement/cashRegisters/reports/landed-cost/stockCount services, middleware, RBAC catalog, jobs, test infrastructure, and the `pos/` frontend (routing, nav, API layer, reports, expense/due/register UI). Cross-verified by six independent audit passes; load-bearing schema facts re-verified directly.

---

## 2. Existing architecture map

### 2.1 Backend

- **Layers:** `modules/<name>/{routes,controller,service,schema}` → Drizzle over `pg.Pool` (`src/db/index.ts`; `src/db/schema/index.ts` exports only pool/db — tables imported per-file). Zod v4 schemas colocated per module. Global error handler maps typed errors → `{ success:false, message, code?, errors? }` (`src/app.ts:183-229`); success payloads are raw objects, lists return `{ rows, meta }` with `page/page_size` pagination.
- **Transactions:** `db.transaction(...)` at 142 call sites; canonical financial write = expense create (`src/modules/expenses/expenses.service.ts:414-489`): lock row → insert ledger row(s) → register movement → `recordAuditInTx` in one tx.
- **Idempotency patterns in production use:** sale `idempotencyKey` + payload-hash (409 on mismatched replay, `sales.service.ts:654-712`); `expense_payments.client_uuid`; register movements unique `(business_id, reference_type, reference_id)` (`registers.ts:217-221`).
- **Money:** all columns `numeric(p,s)` with Drizzle `mode:"number"` (JS floats); aggregation always in SQL (`round(sum(...)::numeric,2)::float8`); `roundMoney()` half-up helper (`src/utils/roundMoney.ts`); integer-poisha validation only at sale payment edges (`sales.validation.ts:186-217`). **No decimal library** (backend deps are exactly: argon2, cors, drizzle-orm, exceljs, express, express-rate-limit, jose, pg, tar-stream, zod).
- **Document numbers:** reusable allocator `nextDocumentNumber(tx, businessId, key)` on `document_sequences` (`src/utils/documentSequence.ts:38-57`) — keys are free-form; a finance module adds `journal_entry`, `payroll_run`, etc. with **zero migration**.
- **Jobs:** single in-process scheduler, 60-min tick, 6 sweeps incl. recurring expense generation (`src/jobs/scheduler.ts:27-34`), `FOR UPDATE SKIP LOCKED`-safe.

### 2.2 Tenancy & RBAC

- JWT authenticates the *user* only; tenancy chosen per request via `X-Business-Id` → verified against active membership (`src/middleware/business.ts:171-202`), `X-Location-Id` → validated + location-assignment enforced (`src/middleware/location.ts:34-149`). No RLS — scoping is per-query `eq(table.businessId, businessId)` (institutionalized invariant), plus composite FKs `(id, business_id)` making cross-tenant child rows physically impossible.
- **RBAC:** permission catalog `src/rbac/permissions.ts:18-165`; namespaces include `sales.*, purchases.*, expenses.*, reports.* (incl. reports.financial.view), attendance.*, landed_cost.*`. **No `finance.*` / `payroll.*` namespace yet.** Owner role = wildcard `*` (`:170`). Adding catalog keys + `DEFAULT_ROLE_PERMISSIONS` entries auto-seeds (idempotent `ensureRbacSeed()` at boot).
- **Audit:** `audit_log` + `recordAuditInTx(tx, …)` (`src/services/audit.ts:28-37`), ~90 action verbs, write-only (no reader API yet).

### 2.3 Frontend (`pos/`)

- Router: flat `createBrowserRouter` in `src/routes/AppRoutes.tsx:61-451`; every route wrapped in `<RequirePermission>` → `/403`. Nav declared in `src/config/navigation.ts:25-205` (sections with permission gates), rendered by `src/components/app-sidebar.tsx` with `usePermissions()` (`src/hooks/usePermissions.ts:13-14`).
- API: shared axios with `Authorization / X-Business-Id / X-Location-Id / X-Terminal-Id` interceptors + 401 refresh-retry (`src/api/axios.ts:422-464`); TanStack Query key-factory hooks (e.g. `expenseKeys`, `src/features/Expense/hooks/useExpenses.ts:46-61`).
- Reusable finance-adjacent UI: Reports hub (`/reports?tab=…`, ~27 report components sharing `ReportHeader/ReportTable/ReportMetricCard/ReportChart` wrappers + CSV export with formula-injection guard, `src/features/reports/utils/reportUtils.ts:86-108`); Expenses (list/settle/void/recurring/budgets/attachments — **no approval workflow**); Due management (AR/AP, record payments, printable ledgers); Registers (live session, drawer movements, offline queue); Attendance timeclock.
- **Currency is hardcoded BDT** (`formatCurrency` → `Intl.NumberFormat("en-BD",{currency:"BDT"})`); `businesses.currency` (default `'BDT'`) exists in the DB but is never consumed by the frontend (`src/db/schema/businesses.ts:26`).
- Tests: vitest + MSW, 33 files / ~208 cases; Playwright e2e 3 specs / 8 tests (incl. RBAC-route-block and tenant-isolation tests).

### 2.4 Test infrastructure (backend)

- Node built-in test runner via `tsx --test` (not vitest); 89 test files (75 integration under `src/test/`).
- Strategy: real DB `ezpos_test`, migrated; fail-closed guard `INTEGRATION_TESTS=1` + `current_database()==='ezpos_test'` (`src/test/helpers/db.ts:7-18`); helpers `createOwnerCtx` (register→login→create business→location), `authHeaders` (Bearer + `X-Business-Id`); suites self-seed RBAC + free-trial plan. `reportingConsistency.integration.test.ts` already polices dashboard-vs-report reconciliation.

---

## 3. Financial flow (as built)

```
                       ┌──────────────── OPERATIONAL LEDGERS (single-entry) ───────────────┐
 SALE side             │ sale_payments (cash/qr/card/credit/loyalty/gift/sslcommerz)       │
  sale ──► sale_items ─┤ sale_refunds / sale_refund_items                                  │
  (FIFO consume ──► sale_item_batch_consumptions ◄── inventory_batches.landed_cost_per_unit)│
  due ──► sales.due_amount (derived cache; truth = Σ payments − refunds)                    │
                                                                                           │
 PURCHASE side         │ purchase_payments │ purchase_returns │ supplier_ledger (2 row      │
  receive ──► batches  │ types only, dead-end) │ purchase_discrepancies (0052)             │
                                                                                           │
 CASH                  │ register_transactions (drawer; types sale/cash_in/out/refund/     │
                       │  safe_*/adjustment_*) │ register_sessions (expected vs counted)   │
                                                                                       ─   │
 EXPENSES              │ expense_payments (+ register cash_out when Cash+session)          │
 INSTRUMENTS           │ customer_credits │ gift_card_transactions │ loyalty_ledger        │
                       └───────────────────────────────────────────────────────────────────┘
                                        │ (nothing today)
                                        ▼
                        ┌────────────────────────────────────┐
                        │  NO GENERAL LEDGER / NO ACCOUNTS   │  ← the Finance & Growth gap
                        └────────────────────────────────────┘
```

---

## 4. Financial calculation audit — where every figure comes from today

| Financial value | Source (file:line) | Formula / mechanism | Verdict |
|---|---|---|---|
| Sales revenue | `sales.final_total` numeric(10,2) (`sales.ts:115-133`) | Server-authoritative; prices from DB; cart discount + coupon + tax rules (`cartPricing.ts:35-232`) | ⚠ VAT-**inclusive**, includes `delivery_fee`; coupon not in `discount` col |
| Sale tax | `sale_items.tax_amount` + `tax_detail` jsonb | Per-line rules engine, inclusive/exclusive, snapshot at sale (`saleItems.ts:45-70`) | ✅ good; no per-rate refund breakdown |
| Sale refunds | `sale_refunds.refund_total` | Pro-rata allocation of sale-level delta (tax/coupon/delivery) to items (`sales.service.ts:1347-1393`); sale-level ceiling | ✅ correct netting; history immutable |
| COGS | `sale_items.cost_at_sale` (12,2) | Blended FIFO avg from `consumeStockFifo()` w/ `FOR UPDATE` (`sales.service.ts:286-372`); per-batch truth in consumptions (14,6) | ✅ solid; landed-cost COGS deltas are **memo-only** (not in reports) |
| Gross profit | reports SQL | `Σ(selling_price − cost_at_sale)×qty − refund_money + restocked_cost` (POS-005) (`reports.service.ts:489-618`) | ⚠ revenue incl. VAT; sale-discount not allocated |
| Net profit (dashboard) | `dashboardMatrix.service.ts:355-448` | gross profit − refunds net of restock − expenses | ⚠ no tax/other income/depreciation |
| Operating expenses | `expenses.amount` (10,2) + `expense_payments` ledger | Statuses **unpaid/partial/paid only** — no draft/approved; soft-void; recurring templates (`expenses.ts:23-129`) | ✅ mechanically sound; no accrual-period concept beyond `expense_date` |
| Purchase cost | `purchases.totalAmount` = subtotal−discount+tax+shipping (`purchases.service.ts:128-146`) | Batches carry **session unit cost**, excl. purchase discounts & header shipping unless landed-cost posted | ⚠ batch cost ≠ invoice cost |
| Landed cost | `landed_costs` module, BigInt-micros largest-remainder; `landed_cost_per_unit` generated col | Inventory/cogs split rows in `landed_cost_adjustments` (CHECK-constrained, `landedCosts.ts:380-383`) | ✅ excellent engine; P&L ignores cogs split |
| Receivables (AR) | derived: `final_total − Σsale_payments − Σrefunds` (`dueManagement.service.ts:88-118`) | `sales.due_amount` = maintained cache; settlement row-locks + recomputes | ✅ correct by construction |
| Payables (AP) | derived: `total − Σpayments − Σreturns − Σcancelled` (`dueManagement.service.ts:119-151`) | `supplier_ledger` table is a **dead-end** (2 credit-only writers; UI ignores it, `:1094-1097`) | ⚠ replace, don't reuse |
| Cash | drawer only: `computeExpectedCash` = opening + Σ signed `register_transactions` (`cashRegisters.service.ts:56-68`) | expected vs counted at close, discrepancy notify | ⚠ **no bank/MFS entity**; supplier & non-session expense payments invisible |
| Bank balance | — | does not exist (`payment_provider_configs` = gateway credentials only) | ❌ |
| Inventory value | `Σ qty_remaining × landed_cost_per_unit` (`reports.service.ts:803-809`) | batch-based | ⚠ negative-stock rows & shrinkage with missing batches drift from stock table |
| VAT liability | `getTaxReconciliationReport` | outputVat − inputVat (`reports.service.ts:1262-1336`) | ❌ ignores refunds + location filter |
| Other income | — | does not exist | ❌ |
| Owner capital / payroll / loans / budgets alerts | — | do not exist (grep across src: zero hits) | ❌ |

**Report date-column inconsistency (will bite growth analytics):** sales summary/profit use `sales.created_at`; channels/staff/online-profitability use `sales.purchase_date`; purchase summary uses `created_at` but purchase items use `purchase_date` (`reports.service.ts:143 vs 1935 vs 1114 vs 936`).

---

## 5. Existing problems & risks

**High (financially wrong numbers today):**
1. **Refunded sales inflate dashboard revenue** — `getSalesOverview` sums `final_total` for `status IN ('completed','refunded')` without refund netting (`dashboardMatrix.service.ts:75-91`), while `getSalesSummary` nets refunds — the two headline charts disagree by design.
2. **Coupon discount missing from `sales.discount`** — header equation breaks; coupon recoverable only via `coupon_redemptions` (`sales.service.ts:887-889`, `:922`).
3. **Unpaid sale + store-credit refund double benefit** — receivable reduced *and* spendable credit granted with no paymentStatus check (`sales.service.ts:1435-1444`, `:1579-1589`).
4. **"Collected today"/trend counts instruments as cash** — all `sale_payments` methods summed (`dueManagement.service.ts:152-157, 756-765`).
5. **Supplier cash outflow invisible** — `purchase_payments` touches nothing but supplier balance; no drawer/bank movement (`dueManagement.service.ts:644-747`). Same for cash expenses without a register session (`expenses.service.ts:463-473` is session-optional).
6. **Gift-card float unfunded** — issuance posts liability only; no cash/deferred-revenue counterpart (`services/giftCards.ts:47-100`).
7. **Tax report wrong under refunds / multi-location** (`reports.service.ts:1262-1336`).

**Medium (value silently lost or approximated):**
8. Stock-count shrinkage captures no loss value anywhere (`stockCount.service.ts:343-402`); shrinkage report falls back to `selling_price × 0.7` heuristic (`reports.service.ts:1372`).
9. Over-received goods become free inventory; the gain is unrecorded (`purchases.service.ts:639-655`).
10. Rejection resolution is recording-only (no credit/stock effect until a manual purchase return) (`outstandingResolution.service.ts:342-419`).
11. Negative-stock/`allowShortfall` sales dilute `cost_at_sale` and produce stock rows the batch valuation cannot see (`sales.service.ts:1000-1007`).
12. Serial-sale consumptions store raw `purchase_price` while totals use landed cost (`sales.service.ts:457-462`).
13. Transfer batches truncate 6-dp landed cost to 2 dp and lose purchase lineage (`stockTransfers.service.ts:562-574`).
14. Loyalty earn accrues no liability value at grant time (`services/loyalty.ts:111-135`).

**Low (hygiene):**
15. Precision mix: headers 10,2 / items 12,2 / costs 14,6 / receiving 14,4; `sale_refunds.refund_total` has no declared precision; `purchases` mixes number/string modes.
16. `paymentStatus='paid'` overloaded (returns/cancellations can mark purchases "paid" with `paidAmount < totalAmount`).
17. `getSalesByInvoiceReport` includes pending/cancelled rows; other summaries exclude them.
18. Expense module has no approval workflow (statuses are settlement-only) — relevant for payroll-style approvals later.
19. `pos/` frontend has no shared currency util (4 duplicate formatters) and ignores `businesses.currency`.

**Security note:** working-tree `.env` is now gitignored (only `*.env.example` tracked) — the previously identified "git-tracked .env" risk is resolved on HEAD; **git-history purge and `AUTH_JWT_SECRET` rotation remain outstanding** (tracked separately from this program).

---

## 6. Feature status vs the Finance & Growth scope

| Status | Items |
|---|---|
| **Already implemented (reuse as-is)** | Sales/revenue engine + tax snapshot; FIFO cost layers + COGS snapshot chain; refunds/exchanges with restock cost logic; AR/AP derived ledgers + settlement with overpay guards; expense ledger w/ partial payments, void, recurring, attachments; drawer cash ledger + close reconciliation; batch-based inventory valuation; RBAC + audit trail + document numbering; tenant isolation (composite FKs + header-verified context); reporting scaffolding (tables/charts/CSV/print); plan entitlement gating |
| **Partially implemented (extend)** | Budgets (monthly-only, category/location, **no alerts, no approval**, hard-deletable by design); attendance (timeclock only — no leave types/overtime baselines); registers (drawer-level only — no bank/MFS); tax (snapshot good — reporting wrong); expense categories (flat labels — no GL mapping) |
| **Missing (build)** | Chart of accounts + journal + periods + posting engine; payment accounts (bank/MFS wallets); owner profiles & capital transactions (investments, withdrawals, distributions); profit calculation & allocation; employees, salary structures, advances, payroll periods/records/payments, payslips; loans & repayments (principal vs interest); business assets & depreciation; other income; P&L / cash-flow / balance sheet / owner & payroll & growth reports; `finance.*` & `payroll.*` permissions; finance section UI |

---

## 7. Proposed accounting model

### 7.1 Principles

1. **Single posting gateway.** All GL writes go through `postJournalEntry(tx, …)`. No service inserts journal rows directly.
2. **Derive, don't invent.** Posting hooks translate existing operational documents (sale, refund, expense, payroll record, capital transaction, loan repayment…) into balanced entries. The GL never becomes a second place to enter the same amount.
3. **Immutability.** Posted entries are immutable. Corrections = reversal entry (+ optional replacement). Drafts exist only for manual/adjustment entries and follow controlled rules (edit before post only).
4. **Idempotent posting.** Partial unique index on `(business_id, source_type, source_id)` — replaying an event can never double-post.
5. **Tenant scoping as everywhere else:** `business_id NOT NULL` on every row; `location_id` nullable on lines with the composite FK pattern; per-query enforcement in services.
6. **Operational ledgers stay authoritative** for their own domains (e.g., register expected cash remains the drawer sub-ledger; AR still derives from sale_payments). The GL must **reconcile** against them (§7.9), not replace them.

### 7.2 Core ledger tables (conceptual; full DDL in §8)

- **`chart_of_accounts`** — per business; `code` (unique per business), `name`, `type asset|liability|equity|revenue|expense`, `normal_balance`, `is_system` (seeded, undeletable), `is_cash` (cash-equivalent flag), `cash_flow_category operating|investing|financing|none` (for direct-method cash flow), `parent_id` (one level of grouping), archived flag. ~40 system accounts seeded per business (list below); users may add child expense accounts (user expense categories map onto them).
- **`accounting_periods`** — `(business_id, period_start, period_end, status open|closed, closed_by/at)`; month granularity; auto-provisioned on demand; posting into a closed period is rejected; reopen is permission-gated + audited.
- **`journal_entries`** — `business_id`, `entry_no` (via `document_sequences` key `journal_entry`), `entry_date`, `memo`, `source_type` (`sale|sale_refund|purchase|purchase_return|landed_cost|expense|stock_count|payroll|owner_capital|loan|asset|opening|manual|adjustment`), `source_id`, `source_category` (operating/investing/financing for cash-flow classification), `status draft|posted|reversed`, `reversal_of_entry_id`, `posted_by/at`, `created_by`; immutable after post.
- **`journal_entry_lines`** — `entry_id`, `account_id`, `debit`, `credit` (numeric(14,2), CHECK `debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0)`), `location_id` nullable (composite FK), `description`; indexed `(business_id, account_id, entry_date)` for balance queries.
- **`payment_accounts`** — the missing cash/bank entity: `business_id`, `name`, `type cash|bank|mfs`, `provider` (bkash/nagad/rocket/sslcommerz/… nullable), `gl_account_id` FK, `currency`, `is_default` per type, `last_reconciled_at`. Registers get a nullable `payment_account_id` (drawer ↔ cash account); sale/expense/purchase payments get nullable `payment_account_id` FKs.

Balances: **computed, not cached** — `SUM(debit − credit)` over lines (SMB volumes make this trivial; a `account_period_balances` cache can be added later if profiling ever demands it).

### 7.3 Posting service contract

```ts
postJournalEntry(tx, {
  businessId, entryDate, memo,
  sourceType, sourceId,          // idempotency: unique (business, sourceType, sourceId)
  sourceCategory,                // cash-flow classification
  locationId?,
  lines: [{ accountCode | accountId, debit, credit, locationId?, description? }],
  status?: "draft" | "posted",   // system hooks always post immediately
}) // validates: Σ poisha(debits) === Σ poisha(credits); period open; accounts active;
  // allocates entry_no; inserts entry+lines; recordAuditInTx("finance.journal.posted")

reverseEntry(tx, entryId, { reason, entryDate, actorId }) // balanced swap + link + audit
```

### 7.4 System chart of accounts (seeded per business)

```
1000 ASSETS      1010 Cash on Hand (drawers)   1020 Bank Accounts   1030 MFS Wallets
                 1040 Accounts Receivable      1050 Inventory
                 1060 Employee Salary Advances 1070 Prepaid Expenses  1045 VAT Input
                 1080 Equipment  1081 Furniture  1082 Vehicles  (+ 1090 Accum. Depreciation contra)
2000 LIABILITIES 2010 Accounts Payable (Suppliers)  2020 VAT Payable  2030 Salary Payable
                 2040 Gift Card Liability  2050 Store Credit Liability  2060 Loyalty Liability
                 2070 Customer Advances    2080 Loans Payable (one sub-ledger row per loan in business_loans)
3000 EQUITY      3010 Owner Contributions  3020 Owner Drawings (contra)  3030 Retained Earnings
                 3040 Reserve: Reinvestment  3050 Reserve: Emergency  3060 Reserve: Expansion
                 3070 Reserve: Debt Repayment  3080 Reserve: Other
4000 REVENUE     4010 Sales Revenue  4020 Sales Returns (contra)  4030 Delivery Income
                 4040 Other Operating Income
5000 EXPENSES    5010 COGS  5020 Salaries & Wages  5030 Rent  5040 Utilities  5050 Marketing
                 5060 Transportation  5070 Inventory Shrinkage  5080 Bank & Gateway Fees
                 5090 Loan Interest  5100 Depreciation  5900 Other Expenses (parent of user categories)
```

User expense categories get a nullable `gl_account_id`; unmapped categories post to `5900`. Payment methods map to `payment_accounts` → GL cash accounts (per business configurable; defaults: cash→1010, card/bank_transfer→1020, Mobile→1030).

### 7.5 Accounting treatment matrix (event → DR/CR)

| Event | Debit | Credit | Derivation source |
|---|---|---|---|
| Sale (per payment method split) | Cash 1010/1020/1030 (by method→account); store credit 2050 / gift card 2040 / loyalty 2060 for instrument parts | Sales Revenue 4010 (net of discounts), Delivery Income 4030, VAT Payable 2020, Sales Returns 4020 for refund legs | `sale_payments` methods; `sale_items.tax_detail` for per-rate VAT; coupon from `coupon_redemptions` |
| Due collection | Cash account | 1040 AR | `sale_payments` rows created by `recordCustomerPayment` |
| Refund — cash back | 4020 Sales Returns (+ 2020 VAT reduction per tax_detail) | Cash 1010 | `sale_refunds` |
| Refund — store credit | 4020 | 2050 | `refund_method='store_credit'` |
| Refund — restock | 1050 Inventory | 5010 COGS | `disposition='restock'` batches at `cost_at_sale` (matches POS-005) |
| Purchase received | 1050 Inventory (incl. landed), 1045 VAT Input (recoverable) | 2010 AP / Cash (at-receive payment split) | `purchase_receiving_records` + batches + payments in tx |
| Supplier payment | 2010 AP | Cash account | `purchase_payments` (+ **new**: drawer/account movement) |
| Purchase return | 2010 AP | 1050 Inventory (+ landed reversal share) | `purchase_returns` (batch-authoritative credits) |
| Purchase cancellation (shortage) | 2010 AP | — (reduces AP via revenue of the payable? No:) | posts **memo-only reversal of the original inventory leg** by cancelled value (DR 2010 / CR 1050) — payable cut already implemented |
| Expense (accrual) | mapped 5xxx expense | 2010 Expense AP / Cash on record | `expenses` + `expense_payments` |
| Landed cost posting | 1050 (received share) + 5010 (sold share) | Cash/AP per settlement source | `landed_cost_postings` (fixes risk: cogs split becomes real P&L) |
| Stock-count shrinkage | 5070 Shrinkage (FIFO value) | 1050 | approve-time batch consumption (fixes risk #8) |
| Stock-count increase | 1050 | 5070/4040 (avg-cost gain) | `ADJ-` batches |
| Over-received goods | 1050 | 4040 Other Income | discrepancy resolution `over_receival` (fixes risk #9) |
| Payroll accrual | 5020 Salaries | 2030 Salary Payable (net of advance recovery → 1060) | `payroll_records` at approval |
| Payroll payment | 2030 | Cash account | `payroll_payments` |
| Salary advance | 1060 | Cash account | `salary_advances` |
| Owner investment | Cash account | 3010 | `capital_transactions(type=investment)` |
| Owner withdrawal / distribution | 3020 | Cash account | `capital_transactions(type=withdrawal|distribution)` |
| Profit allocation (designation) | **no GL entry** — internal equity designation recorded on `profit_allocations` + reserve accounts 3040-3080 | — | allocation is a designation, not a cash event; actual distribution posts when paid |
| Loan received | Cash account | 2080 | `business_loans` disbursement |
| Loan repayment | 2080 (principal) + 5090 (interest) | Cash account | `loan_repayments` split |
| Depreciation (monthly job) | 5100 | 1090 | `business_assets` schedule |
| Opening balances (activation wizard) | Assets / AR / Inventory per computed values | Liabilities / AP / 3030 (plug: pre-ledger retained earnings) | one-time `source_type='opening'` entry |

Every formula documented in code next to its hook; **no journal entry is created twice for the same business event** (enforced by the idempotency index).

### 7.6 Money & rounding strategy

- New ledger columns: `numeric(14,2)`, Drizzle **`mode:"string"`** (no JS floats on the financial spine), arithmetic in SQL, poisha-integer validation at the service edge.
- Reuse the established integer-poisha pattern from `sales.validation.ts` in a new shared `src/utils/money.ts` (parse/format/compare). Existing tables keep their current types — no churn.
- Posting amounts derive from already-rounded document totals; hooks never re-round a stored figure.

### 7.7 History policy — go-live, not backfill (**decision requested**)

- **Option A (recommended):** Finance module activation sets `businesses.ledger_activated_at`. Posting starts **forward** from activation. An activation wizard posts a single `opening` entry: cash from open drawer sessions + entered bank/MFS balances + inventory at batch valuation + derived AR/AP + entered owner capital → equity plug "Retained Earnings (pre-ledger)". Finance dashboards for pre-activation periods keep using the existing derived queries (isolated in one service function).
- **Option B:** one-time backfill script generating JEs from all historical transactions — significantly heavier (every historical edge case: refunds, exchanges, coupons, offline sales), harder to verify, not recommended for v1. Can be added later as an opt-in tool without changing the schema.

### 7.8 Reconciliation model

| GL account | Reconciles against |
|---|---|
| 1010 Cash on Hand | `register_sessions` expected/counted (existing drawer close) |
| 1020/1030 Bank/MFS | `payment_accounts.last_reconciled_at` + manual statement reconciliation (Phase 4: record statement balance → variance → adjustment entry with audit) |
| 1040 AR / 2010 AP | derived due totals (existing `dueManagement` SQL) |
| 1050 Inventory | batch valuation report (existing `Σ qty×landed_cost`) |
| 2020 VAT | improved tax report (refund-aware, location-aware) |

---

## 8. Proposed database changes — **for approval, nothing applied**

All new tables carry `business_id NOT NULL FK → businesses ON DELETE RESTRICT` (no cascading deletes for posted financial history), `created_by/updated_by` FKs, `created_at/updated_at`, and appropriate indexes. **Next migration number: 0053** (drizzle `out: ./drizzle`).

**New tables (18):**

| Table | Key columns | Notable constraints/indexes |
|---|---|---|
| `payment_accounts` | name, type cash\|bank\|mfs, provider, gl_account_id, currency, is_default | unique partial `(business_id, type) WHERE is_default` |
| `chart_of_accounts` | code, name, type, normal_balance, is_system, is_cash, cash_flow_category, parent_id, archived_at | unique `(business_id, code)` |
| `accounting_periods` | period_start, period_end, status, closed_by/at | unique `(business_id, period_start)` |
| `journal_entries` | entry_no, entry_date, memo, source_type, source_id, source_category, status, reversal_of_entry_id, posted_by/at | unique `(business_id, entry_no)`; **partial unique `(business_id, source_type, source_id) WHERE status='posted'`**; index `(business_id, entry_date)` |
| `journal_entry_lines` | entry_id, account_id, debit, credit, location_id, description | CHECK balanced-positive-amounts; composite FK `(location_id, business_id)`; index `(business_id, account_id, entry_date)` |
| `owner_profiles` | user_id nullable, name, phone, ownership_percent (5,2), distribution_policy jsonb, is_active | partial unique active-owner-per-user |
| `capital_transactions` | owner_profile_id, type investment\|withdrawal\|distribution, amount (14,2), txn_date, payment_account_id, method, source_of_funds, reference, description, attachment_url, status, journal_entry_id, client_uuid | unique `client_uuid`; index `(business_id, owner_profile_id, txn_date)` |
| `profit_allocations` | period_start/end, basis metrics snapshot (jsonb), total_distributable, status draft\|confirmed\|reversed, approved_by/at | — |
| `profit_allocation_lines` | allocation_id, category, basis_type percent\|fixed, basis_value, amount, realized_amount, realized_at, reference | CHECK Σ(lines.amount) ≤ allocation.total_distributable |
| `employees` | employee_code (document seq), user_id nullable, full_name, phone, email, address, designation, department, joining_date, employment_status active\|inactive\|terminated, location_id, payment_method, payment_account_id | unique `(business_id, employee_code)` |
| `employee_salary_structures` | employee_id, pay_type monthly\|daily\|hourly, basic_amount, allowances jsonb, overtime_rate, effective_from, is_active | partial unique one-active-per-employee |
| `salary_advances` | employee_id, amount, advance_date, installment_count, outstanding_amount, status, journal_entry_id, client_uuid | — |
| `payroll_periods` | period_type monthly, period_start, period_end, status draft\|approved\|paid\|partial\|cancelled, totals, approved_by/at | unique `(business_id, period_type, period_start)` |
| `payroll_records` | period_id, employee_id, attendance snapshot cols (worked/absent/leave/half/late/ot_hours), basic/allowances/overtime/bonus/commission/deductions/advance_deduction/gross/net (14,2), status | unique `(period_id, employee_id)` — prevents duplicate processing |
| `payroll_payments` | payroll_record_id, amount, method, payment_account_id, payment_date, reference, client_uuid, journal_entry_id | unique `client_uuid`; overpay guarded in service |
| `business_loans` | lender_type bank\|mfs\|owner\|other, lender_name, principal, interest_rate (6,3), loan_date, due_date, installment_schedule jsonb, status, notes | — |
| `loan_repayments` | loan_id, principal_amount, interest_amount, total_amount, payment_date, payment_account_id, reference, client_uuid, journal_entry_id | unique `client_uuid` |
| `business_assets` | name, category, acquired_at, cost, salvage_value, useful_life_months, depreciation_method, accumulated_depreciation, status, location_id | — |

**Alterations to existing tables (nullable/additive only — no destructive changes):**

- `sale_payments`, `expense_payments`, `purchase_payments`: + `payment_account_id` nullable FK.
- `expense_categories`: + `gl_account_id` nullable FK.
- `registers`: + `payment_account_id` nullable FK (drawer → cash account).
- `expense_budgets`: + `period_type` (default `monthly`, preserves current behavior), + `warning_threshold_percent` (default 80), + `status` — reuses the existing budgets module instead of building a second one.
- `businesses`: + `ledger_activated_at` nullable timestamptz (go-live marker, §7.7).

**Explicit reuse (no new tables):** audit trail → `audit_log`; document numbering → `document_sequences`; attendance → existing `attendance_records/breaks` (payroll reads hours/days from them; no employee duplication — `employees.user_id` links); gift-card/store-credit/loyalty liabilities → posted from their existing ledgers; permissions → existing catalog+seed; payslip branding → existing `document_settings`.

---

## 9. API architecture (proposed)

Follows the existing chain exactly: `requireAuth → requireBusinessContext() → requireLocationAccess() → requireFullAccess → requirePermission(...)`; Zod schemas colocated; `db.transaction`; idempotency via `client_uuid`; `recordAuditInTx` on every mutation; list endpoints return `{rows, meta}`.

```
/api/finance/overview                 GET   metrics (documented formulas, §7.4 reports)
/api/finance/accounts                 CRUD chart of accounts (system accounts protected)
/api/finance/payment-accounts         CRUD cash/bank/MFS accounts
/api/finance/journal-entries          GET list/detail · POST manual draft · POST :id/post · POST :id/reverse
/api/finance/periods                  GET · POST :id/close · POST :id/reopen
/api/finance/investments              CRUD capital transactions (type=investment)
/api/finance/withdrawals              CRUD (type=withdrawal|distribution)
/api/finance/owners                   CRUD owner profiles
/api/finance/profit-allocations       GET/POST confirm · POST :id/reverse · POST lines/:id/realize
/api/finance/cash-flow                GET statement (direct method from GL cash accounts)
/api/finance/reports/*                P&L · balance sheet · owner investment/withdrawal · retained earnings
                                      payroll report · salary outstanding · loan outstanding · budget variance
                                      growth report · transaction report   (CSV/PDF/Excel exports)
/api/finance/reconciliation           GET variance · POST adjustment
/api/payroll/employees                CRUD · :id/salary-structures · :id/advances
/api/payroll/attendance-summary       GET (derived from existing attendance)
/api/payroll/periods                  POST run (calculate) · :id/approve · :id/cancel
/api/payroll/records/:id/payments     POST (partial payments) · GET payslip :recordId
/api/loans                            CRUD · :id/repayments
/api/budgets                          (existing /api/expenses/budgets extended: period types, alerts)
```

**New permissions** (catalog `src/rbac/permissions.ts` + `DEFAULT_ROLE_PERMISSIONS`): `finance.view`, `finance.overview.view`, `finance.investment.view|manage`, `finance.withdrawal.view|manage`, `finance.profit.view|allocate`, `finance.accounts.manage`, `finance.journal.view|post|reverse`, `finance.period.close|reopen`, `finance.reconcile.manage`, `payroll.view|manage|process|approve|pay`, `budget.view|manage`, `loans.view|manage`, `reports.financial.*`. Defaults per your spec: Owner = all; Manager = assigned only; Accountant = records+reports; **Cashier = none**. Backend `requirePermission` on every route; frontend gating is cosmetic only.

---

## 10. Frontend architecture (proposed)

- **Nav:** new top-level section `Finance & Growth` in `src/config/navigation.ts` (one collapsible group, `anyPermission: ["finance.view","payroll.view",…]`, sub-items permission-gated) — mirrors the Reports-hub pattern (`/finance?tab=` for report-type pages).
- **Routes** in `AppRoutes.tsx` under `AppLayout`, each wrapped in `RequirePermission`: `/finance` (overview), `/finance/owners`, `/finance/profit-allocation`, `/finance/withdrawals`, `/finance/cash-flow`, `/finance/loans`, `/finance/budgets`, `/finance/growth`, `/finance/balance-sheet`, `/payroll` (+ employees/periods/payslips), `/finance/journal` (power view).
- **Reuse, not rebuild:** `ReportMetricCard/ReportTable/ReportChart/ReportHeader` (print), `exportToCsv`, `createEntityPromiseToast`, `ConfirmDeleteDialog`, RHF + `zodResolver` dialog pattern (as `ExpenseDialog`), TanStack Table clusters, `PermissionButton/PermissionGuard`, plan-gate `PlanUpgradeCard` (finance features can be plan-entitled like advanced reports).
- **Fix promoted along the way:** one shared currency util consuming `businesses.currency` (replaces 4 hardcoded-BDT formatters) — displayed currency follows the business config per your requirement.
- Payroll UI: employees list/detail (structure editor), period run wizard (attendance-aware preview → approve), payment recording with partial support, printable payslip reusing receipt/document branding conventions.

---

## 11. Testing plan

Backend integration suites in the existing harness (`INTEGRATION_TESTS=1`, `ezpos_test` guard, `createOwnerCtx`):

1. **Ledger invariants:** every posted entry balances (DB CHECK + service tests); idempotent posting (same `source_type+id` twice → single entry); reversal links; period-closed rejection; immutability of posted entries.
2. **Reconciliation:** GL cash ≡ register-session expected cash; GL AR ≡ derived receivables; GL AP ≡ derived payables; GL inventory ≡ batch valuation; **Assets = Liabilities + Equity** on randomized transaction scripts.
3. **Flow scenarios** (your §10 list): investments, withdrawals, capital repayment, allocation validation (cannot exceed distributable), payroll calculation incl. advance recovery (no double expense), partial/unpaid salary, loan principal-vs-interest split, budget overspend alert, cash-flow reconciliation, refund/COGS cases (restock vs not).
4. **Growth analytics:** fixed-seed fixtures comparing current/previous periods, zero-denominator handling, mixed `created_at` vs `purchase_date` alignment.
5. **Multi-tenant:** cross-business ID manipulation rejected on every new endpoint (pattern of existing e2e `tenant isolation` spec); location scoping on journal lines and reports.
6. **Permissions:** cashier sees 403 on all finance/payroll routes; accountant/owner matrix.
7. Frontend: vitest for new hooks/components (key factories, dialogs); Playwright spec: finance overview renders from seeded data + payroll run happy path.

---

## 12. Phased implementation plan (Stages 3–8 after your approval)

| Stage | Content | Migrations |
|---|---|---|
| 3 — Foundation ✅ (2026-11-07) | Ledger tables, CoA seed, posting service, periods, payment accounts, permissions, activation wizard; posting hooks for **existing** flows: sales/refunds/due-collections/exchanges, purchases/receiving/returns, expenses, supplier payments, landed cost (initial post), stock count | 0053 |
| 4 — Owner finance (Ph.1–2) ✅ (2026-11-08) | Owner profiles, capital transactions, profit calculation service (documented formulas), allocation + reserves | 0054 |
| 5 — Payroll (Ph.3) ✅ (2026-11-08) | Employees, structures, advances, periods/records/payments, payslip data, attendance integration | 0055 |
| 6 — Dashboards (Ph.4–5) ✅ (2026-11-08, backend) | Financial overview + cash flow (direct, GL-derived) + growth analytics w/ period comparisons + rule-based insights; owner-finance & payroll UI lands with the frontend section | — |
| 7 — Tools (Ph.6–7) ✅ (2026-11-08) | Budget period types (monthly/quarterly/yearly) + threshold alert sweep; loans & repayments (principal vs interest); assets & straight-line depreciation (monthly job, idempotent); balance sheet & net worth | 0056, 0057 |
| 8 — Reports & finalization (Ph.8) ✅ (2026-11-08) | 13 reports + CSV exports, reconciliation report, audit-trail API, completion report (`program-completion-report.md`) | — |

Each stage ends with the full backend suite + typecheck green before proceeding. No unapproved schema changes in later stages.

---

## 13. Known limitations to document (not hidden)

- Pre-ledger history is not double-entry (unless Option B chosen later); finance pages for pre-activation periods use derived approximations.
- Inventory valuation remains batch-based; negative-stock drift is reported, not silently absorbed.
- Bank/MFS reconciliation is manual statement-matching in v1 (no bank feeds).
- Depreciation is straight-line only; no amortization schedules.
- Insights (§5E of your spec) are rule-based thresholds on verified data — no speculative AI claims.

---

## 14. Decisions requested

1. **Approve the double-entry ledger architecture** (§7) including "operational ledgers stay authoritative + GL reconciles" — or indicate changes.
2. **History policy:** Option A (go-live + opening-balance wizard — recommended) vs Option B (historical backfill tool).
3. **Payment accounts scope:** include bank/MFS accounts + GL mapping in Stage 3 (recommended) vs defer to Phase 4.
4. **Budgets:** extend existing `expense_budgets` (recommended) vs separate finance budget tables.
5. **Approve the schema package (§8) and phase plan (§12)** so Stage 3 migrations (0053+) can be drafted.
