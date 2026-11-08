# ezPos Business Finance & Growth — Program Completion Report

**Date:** 2026-11-08 · **Branch:** `feature/finance-growth` · **Backend stages: 3–8 complete.**
Architecture: `phase-0-audit-and-architecture.md` (approved 2026-11-07). Test suite: **752/752 passing** at completion (TypeScript clean).

---

## 1. Implemented functionality

| Stage | Delivered | Migration |
|---|---|---|
| 3 — Ledger foundation | Double-entry GL: chart of accounts (~42 seeded system accounts per business), accounting periods (open/close/reopen), journal entries + lines behind a single `postJournalEntry()` gateway (balance enforcement in integer poisha, idempotency per source event, reversal entries, activation gate), payment accounts (cash/bank/MFS), Finance activation wizard with opening balances + retained-earnings plug; posting hooks in sales/refunds/exchanges/due collections/purchases/receiving/returns/expenses/supplier payments/landed cost (initial post)/stock count | 0053 |
| 4 — Owner finance | Owner profiles (multiple owners, ownership % descriptive only), capital transactions (investment/withdrawal/distribution — each GL-posted, financing category), owner capital dashboard totals, server-authoritative profit calculation, profit allocation into reserves with overlap + over-allocation guards and realization as actual distributions | 0054 |
| 5 — Staff & payroll | Employees (auto EMP codes, versioned salary structures, monthly/daily/hourly), salary advances (asset + FIFO recovery), payroll periods with documented calculation formulas and attendance integration, approval accrual, partial payments with a period status machine, cancel/reopen with entry reversal, payslip data | 0055 |
| 6 — Dashboards | Financial overview (documented metrics, GL-derived), direct-method cash flow (by category/source/day, reconciles to cash balances by construction), growth analytics (period presets + custom, KPIs, zero-denominator policy, rule-based insights) | — |
| 7 — Tools | Budget period types (monthly/quarterly/yearly) + threshold alert sweep; loans with split principal/interest repayments and auto-close; assets with straight-line monthly depreciation (idempotent, scheduled); balance sheet & net worth with an exact A = L + E flag | 0056, 0057 |
| 8 — Reports & finalization | 13 financial reports (see §4), CSV exports, GL-vs-operational reconciliation report, audit-trail read API (was write-only), this document | — |

## 2. Database changes (migrations 0053–0057; all additive, no destructive changes)

New tables: `chart_of_accounts`, `accounting_periods`, `journal_entries`, `journal_entry_lines`, `payment_accounts`, `owner_profiles`, `capital_transactions`, `profit_allocations`, `profit_allocation_lines`, `employees`, `employee_salary_structures`, `salary_advances`, `payroll_periods`, `payroll_records`, `payroll_payments`, `business_loans`, `loan_repayments`, `business_assets`, `asset_depreciation_postings`.
Alterations (nullable/additive only): `payment_account_id` on sale/expense/purchase payments and registers; `gl_account_id` on expense categories; `ledger_activated_at` on businesses; `period_type` + `warning_threshold_percent` on expense_budgets (monthly behavior unchanged).
All money columns are `numeric(14,2)` read as **strings** — the financial spine never crosses a JS-float boundary; arithmetic is integer poisha (`src/utils/money.ts`).

## 3. API endpoints (all business-scoped via `X-Business-Id`, permission-enforced, audit-logged)

- **Ledger:** `GET/POST/PATCH/DELETE /api/finance/accounts(|/:id|/:id/archive|/balances)`, `/api/finance/payment-accounts`, `/api/finance/journal-entries(…/:id/post|/:id/reverse)`, `/api/finance/periods(…/:id/close|:id/reopen)`, `/api/finance/trial-balance`, `GET /api/finance/status`, `POST /api/finance/activation`
- **Owner finance:** `/api/finance/owners`, `/api/finance/capital-transactions`, `/api/finance/capital-summary`, `/api/finance/profit`, `/api/finance/profit-allocations(+/reverse|lines/:id/realize)`
- **Payroll:** `/api/payroll/employees(+/salary-structures|advances)`, `/api/payroll/periods(+/approve|cancel|reopen|records/:id)`, `/api/payroll/records/:id/payments|payslip`, `/api/payroll/payments/:id/void`
- **Dashboards:** `/api/finance/overview`, `/api/finance/cash-flow`, `/api/finance/growth`
- **Tools:** `/api/finance/loans(+:id/repayments)`, `/api/finance/assets(+depreciation/run)`, `/api/finance/balance-sheet`
- **Reports:** `/api/finance/reports/pnl | owner-investments | owner-withdrawals | profit-allocations | retained-earnings | payroll | salary-outstanding | loan-outstanding | budget-variance | transactions` (`?format=csv` on tabular ones), `/api/finance/reconciliation`, `/api/finance/audit-log`

**Permissions added:** `finance.view`, `finance.overview.view`, `finance.accounts.manage`, `finance.journal.view|post|reverse`, `finance.period.close|reopen`, `finance.reconcile.manage`, `finance.activation.manage`, `finance.investment.view|manage`, `finance.withdrawal.view|manage`, `finance.profit.view|allocate`, `finance.assets.view|manage`, `payroll.view|manage|process|approve|pay`, `budget.view|manage`, `loans.view|manage`. Defaults: owner = all; accountant = records + reports (no reversal/period-reopen/allocate/loan-manage); manager = overview + budgets; **cashier = nothing**. Enforced by `requirePermission` on every route.

## 4. The 13 reports (master prompt §8.A)

| # | Report | Endpoint | Status |
|---|---|---|---|
| 1 | Profit & Loss statement | `/reports/pnl` | ✅ |
| 2 | Balance Sheet | `/finance/balance-sheet` | ✅ (Stage 7) |
| 3 | Cash Flow Statement | `/finance/cash-flow` | ✅ (Stage 6) |
| 4 | Owner Investment Report | `/reports/owner-investments` | ✅ |
| 5 | Owner Withdrawal Report | `/reports/owner-withdrawals` | ✅ |
| 6 | Profit Allocation Report | `/reports/profit-allocations` | ✅ |
| 7 | Retained Earnings Report | `/reports/retained-earnings` | ✅ (rollforward) |
| 8 | Payroll Report | `/reports/payroll` | ✅ |
| 9 | Salary Outstanding Report | `/reports/salary-outstanding` | ✅ |
| 10 | Loan Outstanding Report | `/reports/loan-outstanding` | ✅ |
| 11 | Budget Variance Report | `/reports/budget-variance` | ✅ |
| 12 | Business Growth Report | `/finance/growth` | ✅ (Stage 6) |
| 13 | Financial Transaction Report | `/reports/transactions` | ✅ |

Exports: CSV server-side (`?format=csv`, BOM for Excel); PDF/Excel via the frontend's print/export utilities.

## 5. Test results

Backend: **752/752 passing**, TypeScript strict clean. 57 new tests across seven suites:
`financeLedger` (10) · `financeHooks` (6) · `financeOwner` (11) · `financePayroll` (9) · `financeOverview` (6) · `financeTools` (6) · `financeReports` (9).
Accounting invariants under continuous test: every posted entry balances; idempotent posting per source event; reversals never edit history; A = L + E exact at the end of every suite; cash flow net-movement ≡ change in cash balances; GL inventory ≡ batch valuation; GL receivables/payables/salary-payable ≡ operational derivations.

**Local test runs need `AUTH_RATE_LIMIT_MAX=10000 REFRESH_RATE_LIMIT_MAX=10000`** (the default of 20/15-min window rate-limits ~50 tests as the suite grew; CI likely needs the same override — the Playwright config already does this).

## 6. Known limitations

1. **Pre-ledger history is not double-entry** — the GL starts at activation; pre-activation periods keep using the derived reports.
2. **Landed-cost receive-deltas and return reversals** are not GL-posted (only the initial posting); they remain traceable in `landed_cost_adjustments` which the P&L joins. Candidate for a follow-up.
3. **Withheld payroll deductions** other than advances sit inside 2030; remitting them (e.g. tax authority) is a manual journal entry for now.
4. Depreciation is straight-line only; asset disposal is a status change without disposal entries.
5. Inventory turnover/ROIC use point-in-time valuations (documented in the growth report).
6. Bank/MFS reconciliation is variance-reporting only — statement matching is manual.
7. Journal lines carry an optional location dimension, but Stage 6 statements are business-level (the operational reports module covers location views).
8. The `pos/` frontend section (Finance & Growth navigation, payroll UI, report pages) is the next workstream — all endpoints are ready.

## 7. Pre-existing problems surfaced by Phase 0 (not fixed here — tracked separately)

Dashboard counts refunded sales as gross revenue; coupon discount missing from `sales.discount`; unpaid sale + store-credit refund double benefit; "collections" counting instruments as cash; tax report ignoring refunds/location. These are reporting-layer fixes in the existing modules, independent of the ledger.
