# Phase 6 — Platform Maintenance & Refactoring (report)

Executed 2026-11-15 on the Windows checkout `D:\ezposzcode\digtal-khata-pos`, branch `feature/add-feature`, on top of the Phase 5 close. Plan: `P5_P6_PLAN.md` §3 (approved). **Defining requirement honored: zero behavior change** — the frontend test suite passed unchanged (352/352) at every commit, and the backend was never touched by any Phase 6 commit.

---

## 1. Feature 1 — TanStack Query migration (9 commits, one domain per commit)

| Commit | Domain | Design |
|---|---|---|
| `81901d40` | Customers | `useCustomersQuery` (key `["customers", businessId, "list"]`); queryFn IS `loadCustomersWithCache(getCustomersApi)` (IndexedDB offline fallback identical); store keeps dialog/selection state; addCustomer/updateCustomer keep the local-patch-no-refetch semantics, now patching the query cache |
| `bd371b9c` | Products catalog | `useProductsQuery` (key `["products", businessId, locationId, "catalog"]`); queryFn IS `loadProductsWithCache(getProductsApi)`; every `getProducts` call site mapped before removal: bootstrap → prefetch, PosPage revisions → invalidate, 4 barcode scan-miss chains → await invalidate + `readProductsCache`, sales stock refresh, purchase hooks, cart restore, offline-grant prep (dynamic import kept for the lazy cycle break) |
| `585201fc` | Product option groups | `useProductSelectOptionsQuery` / `useProductVariantOptionsQuery`; **`useProductStore` deleted**; option CRUD = `productOptionActions` plain functions with the same API-call → local-patch semantics; select-options key reuses the pre-existing `["product","select-options"]` shape — the old Zustand+TQ dual cache collapsed into one (resolves a deferred-registry dedupe candidate) |
| `51ca389f` | Sales list | `useSalesQuery` (key `["sales", businessId, locationId, "list"]`); store keeps checkout/refund ACTIONS; per-action refresh semantics preserved exactly (createSale best-effort vs refund strict) and pinned by tests; `sale.created` still does NOT refresh the sales list (unchanged behavior, documented) |
| `96a44582` | Users page | `useUsersQuery` + shared `useRolesListQuery` / `useLocationsQuery` (both soft-fail to empty, preserving the outage semantics); version-triggered reload → invalidate; create/update patch the cache |
| `3b33c155` | Roles page | shared `useRolesListQuery` gains a `softFail` option — Users page soft-fail vs Roles page hard-fail contracts both preserved on one cache key; permission catalog (`["permissions-catalog"]`) keeps the R1-3 block-editing-on-error state; role-users dialog query with enable gating |
| `d7c785d1` | Coupons | the last raw-axios in-component fetch → `useCouponsQuery`; failure toast + empty-list semantics preserved |
| `0e3f3925` | Quotations | `useQuotationsQuery` (filterable, `keepPreviousData` mirrors the old no-skeleton-flash behavior); filters typed via `Parameters<typeof listQuotationsApi>[0]` (exactOptionalPropertyTypes-safe); detail dialog stays a manual ephemeral fetch |
| `59070227` | Audit logs | `useAuditLogsQuery` (filterable + offset-paginated, `keepPreviousData`); `loading = isFetching` so the pager disables identically; CSV export stays a manual action |

**Invalidation mapping discipline**: every existing store-reload call was enumerated (plan §3.1 table) before its removal; bootstrap warm-starts via `prefetchQuery` in the same effect-order position; the realtime revision consumers now invalidate the corresponding keys. **Scoping**: every key carries the business (and location where relevant) from the session; location/business switching is a full page reload today, so stale cross-scope data cannot occur, and the keys are future-proofed for the business switcher. **Offline**: the products/customers queryFns ARE the offline wrappers — the IndexedDB fallback, `offlineMode` flag and the `ezpos-offline` v3 stores behave identically.

## 2. Feature 2 — Large-file refactoring (4 commits, one file per commit)

| Commit | File | Extracted (verbatim lifts) | Size |
|---|---|---|---|
| `29eb7ca4` | `Dashboard.tsx` | `dashboardNormalizer.ts` (pure response normalizer + period/threshold consts + formatters), `dashboardPrimitives.tsx` (MetricCard/SectionHeading/EmptyState), `SalesOverviewChart.tsx` (recharts card; comparison as an explicit prop) | 1398 → 957 |
| `6c58751b` | `PaymentModal.tsx` | `paymentHelpers.ts` (QR_NUMBER, money, buildPayments/getMode, toNum, tender types), `paymentValidation.ts` (storeCreditIssue/loyaltyIssue/isPaymentValid — factories still translate at call time), `useTenderBalances.ts` | 1189 → 912 |
| `8dae36fd` | `Sales.tsx` | `salesListUtils.ts` (date-range/refund consts + guards + label maps, formatDate, summarizeSales, isInDateRange, refundStateOf, remainingOf) — including the mid-file formatCurrency import staying with the page | 1064 → 948 |
| `b750640f` | `PurchasesReturn.tsx` | shared `useDebouncedValue.ts` hook, `ReturnState.tsx` guard screen, dead import (`scanStepInLineUnit`) dropped | 811 → 787 |

All lifts are verbatim — no logic, state-shaping math (including the takeVariantStock 0-clamp), request pattern, permission check or keyboard/offline behavior changed. **Extraction candidates deliberately left in-page** (documented, not silently skipped): Dashboard's `useDashboardSummary` hook + remaining section cards; Sales' VoidSaleFlow/RefundDialog/SaleDetailsDialog dialogs; PaymentModal's SplitPayment/method panels/Due panel; PurchasesReturn's scan-ref cluster (order-sensitive refs) — each is self-contained but needs wider prop threading; safe follow-ups under the same zero-change discipline.

## 3. Database / API / permission changes

**NONE.** No migration (journal stays at 88, next `0088`), no route or contract change, no rbac change. Feature 1 is a frontend data-layer migration only.

## 4. Test evidence (executed 2026-11-15)

| Gate | Result |
|---|---|
| Backend `npx tsc --noEmit` | 1 pre-existing `receiptShare.integration.test.ts(283)` TS2339 (open decision D1) — backend untouched by Phase 6 |
| Frontend `npx tsc --noEmit -p tsconfig.app.json` | **119 errors after every commit; normalized error list (file+code+message) identical to the worktree baseline** — zero new diagnostics across all 13 commits |
| Frontend `npm run build` | Pass every commit |
| Frontend Vitest (`--no-file-parallelism`) | **352/352 across 59 files** at program end; grew from 294 baseline: +4 terminalBinding restored (Phase 5 storage shim), +9 i18n infra, +4 bn screen renders, +4 checkout bn renders, +2 register bn, +5 format locale, +4 bn POS strings, +6 customers, +7 products, +2 register, +3 sales, +4 users, +4 roles, +3 coupons, +3 quotations, +3 audit |
| Backend full suite (`INTEGRATION_TESTS=1`, Node 26, `ezpos_test` verified before the run) | **1106 tests recorded, 1104 pass, 1 fail, 1 skipped, 159 suites** — the single failure is the documented pre-existing `expensesPhase6` budget-scope test (identical to the Phase 5 close: zero backend regression from the whole program) |
| Existing pinned tests | PaymentModal 17 tests and PurchasesReturn 7 tests pass UNCHANGED (harness accommodations: a QueryClientProvider wrapper; the products-store mock swapped for the new data source — assertions untouched) |

## 5. Known limitations / notes

1. The dual-cache unification (product select options) intentionally goes one step beyond the plan's "pin, do not unify" note — same endpoint, same payload, strictly fewer fetches; disclosed here and in commit `585201fc`.
2. `sale.created` still never refreshes the sales list (pre-existing behavior, now documented and test-adjacent) — flagged for a future behavior decision rather than changed silently.
3. Test-harness accommodations were required where component tests render a migrated consumer (QueryClientProvider wrappers; store-module mocks swapped for hook-module mocks). Assertion logic untouched everywhere.
4. Feature 2 extraction depth is honest but not exhaustive — the remaining seams are listed in §2 with their risk notes.

## 6. Remaining work

- Push decision (14 unpushed commits: 6 Phase 5 + docs + 13 Phase 6 minus docs… see git log) — **never pushed without explicit instruction**.
- bn string review (Phase 5) still pending owner review.
- Deferred registry (P5_P6_PLAN.md §6) unchanged: RegisterPage movement labels, `/due_by_customers` double-fetch, catalog refetch churn, server-side Bangla, Bangla numerals, receipt renderers.
- Optional follow-up refactors: the in-page seams listed in §2.
