# Phase 7 — Price History UI, Group Profitability, Promotion Performance
Percentage-Based Pricing Management · branch `feature/percentage-pricing`
Date: 2026-11-08 · Approved design: [phase-0-audit-and-architecture.md](./phase-0-audit-and-architecture.md) §18 P7 · Predecessor: [phase-6-report.md](./phase-6-report.md)

## Scope delivered

### Backend — pricing attribution reports (`modules/reports`)
- **`GET /api/reports/pricing/group-profitability`** (`reports.financial.view` + `advancedReports` entitlement, the profit-report chain): aggregates by the `sales.customer_group_id` SNAPSHOT — no live membership joins, so moving a customer between groups never rewrites history. Per group: salesCount, grossSales, itemDiscounts, groupDiscounts + promotionDiscounts (from `sale_items.price_adjustments` via a lateral `jsonb_array_elements` pass, `FILTER`-separated so adjustments never multiply the base aggregates), netRevenue, totalCost (`cost_at_sale`), netProfit, marginPercent. Walk-ins bucket under "No group"; deleted groups degrade to "Removed group #id". Location filter honored.
- **`GET /api/reports/pricing/promotion-performance`** (`promotions.view` + entitlement): per promotion id from `price_adjustments` kind='promotion' — salesCount (distinct sales), totalDiscount; promotion names joined from `pricing_promotions` with the same removed-promotion fallback. Deleted promotions keep their attribution content (no FK by design).
- **Report regression:** the existing `getProfitReport` formula reads `sale_items` snapshots only — the attribution layers live in `price_adjustments` and never touch those snapshots, so profit, dashboard, and finance math are untouched by construction (asserted by the regression test + the unchanged pre-existing suites).

### Frontend — Pricing section (all under the existing nav section)
- **Price History page** (`/pricing/history`, `pricing.history.view`): variant filter + paginated table of every materialized change (when, variant, old → new, source badge, cost at change behind `products.view_cost`, reason).
- **Customer Groups page** (`/pricing/customer-groups`, `pricing.view` read / `pricing.customer_groups.manage` write): group CRUD with single-default + activate/deactivate, and a per-group pricing drawer (whole-cart or scoped rows with minimums, cap, validity window, stacks-with-promotions switch). This closes Phase 4's deferred UI limitation.
- **Promotions page** (`/pricing/promotions`, `promotions.view`/`promotions.manage`): promotion CRUD — scope picker, discount, window, minimums, cap, stacking switches, activate/deactivate. (Member assignment lives with Contacts/customer CRUD; group membership management is available through the Customer Groups drawer APIs.)
- **Pricing Reports page** (`/pricing/reports`, `pricing.view`): period picker (presets + custom range) over both report tables.

## Files changed

**New:** `pos/src/features/pricing/pages/{PriceHistoryPage,CustomerGroupsPage,PromotionsPage,PricingReportsPage}.tsx`, `src/test/pricingReports.integration.test.ts`.
**Modified:** `modules/reports/reports.service.ts` (+2 report functions), `reports.controller.ts` (+2 handlers), `reports.routes.ts` (+2 routes), `pos/src/config/navigation.ts` (+4 items), `pos/src/routes/AppRoutes.tsx` (+4 routes), `pos/src/features/pricing/pricing.{api,types}.ts` + `hooks/usePricing.ts` (+groups/promotions/reports surfaces), `pricing.wiring.test.ts` (nav parity).

## Database changes

None.

## API changes

| Method/Path | Permission |
|---|---|
| `GET /api/reports/pricing/group-profitability` | `reports.financial.view` + advancedReports |
| `GET /api/reports/pricing/promotion-performance` | `promotions.view` + advancedReports |

## Tests & results

- `pricingReports.integration.test.ts` (4 cases): a member sale (300 gross → group 30 → promo 15 → net 255, cost 150 → profit 105, margin 41.18%) and a walk-in sale aggregate into the right buckets; membership change after the sale leaves the snapshot attribution intact; promotion performance rows survive promotion deletion ("Removed promotion #id", discount preserved); the pre-existing profit report returns snapshot-based gross profit (200) across the same sales. **Status: written, self-skip green; needs `INTEGRATION_TESTS=1` + reachable `ezpos_test` (credentials blocker, see phase 8 report).**
- Backend `tsc --noEmit` clean; unit suite 197 pass / 0 fail / 1 skipped (pre-existing backups conditional); POS `vite build` green; pricing wiring tests 4/4.

## Known limitations

1. Group profitability buckets by the sale-time group only (correct per the snapshot design); there is no drill-down into individual sales yet.
2. Promotion performance measures discount given + usage; revenue uplift attribution (with/without) is out of scope.
3. Coupon amounts are not part of `price_adjustments` (they live in `coupon_redemptions`), so the attribution tables intentionally exclude coupons.
