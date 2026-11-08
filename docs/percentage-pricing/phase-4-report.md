# Phase 4 — Customer Groups + Group Pricing at Checkout
Percentage-Based Pricing Management · branch `feature/percentage-pricing`
Date: 2026-11-08 · Approved design: [phase-0-audit-and-architecture.md](./phase-0-audit-and-architecture.md) §18 P4 · Predecessor: [phase-3-report.md](./phase-3-report.md)

## Scope delivered

### Sale-time group layer (backend)
- **`pricing.salePricing.ts`** — server-side evaluation shared by quote AND createSale (the coupons engine pattern): customer → active group → active group-pricing rows, filtered by **minimum purchase, minimum quantity and the validity window (business-local calendar date)**. Whole-cart rows produce capped amounts; category/product/variant-scoped rows match per line and cap the row's AGGREGATE via proportional scaling. Walk-ins and group-less customers get nothing. Group pricing applies to eligible selling prices only — never costs.
- **Cart engine extension** (`sales/utils/cartPricing.ts`) — optional `CartGroupInput` on both totals engines: whole-cart amounts allocate pro-rata by line total (last line absorbs remainder), line-scoped amounts apply verbatim; the **manual cart discount's percentage base becomes the post-group total** (approved stacking order: base → group → manual → VAT); per-line tax bases subtract the allocations so VAT is computed on the discounted base. **Empty input reproduces the pre-groups totals bit-for-bit** (12/12 pre-existing engine tests unchanged).
- **createSale integration** — header gains the `sales.customer_group_id` snapshot; each `sale_items.price_adjustments` entry records `{kind:'group', refId, name, amount}` in application order (self-describing with the group name); the header `discount` now also carries the group layer (line + manual cart + group). Coupon stacking re-specified: **coupon XOR manual cart discount unchanged; coupon stacks with the automatic group discount** (coupon min-order/percentage base = post-group total).
- **quote integration** — identical evaluation; response gains `group: {id, name, discountAmount}` so the cashier sees the exact automatic discount before charging.

### Customer groups module (`modules/customerGroups/`)
- `GET/POST/PATCH/DELETE /api/customer-groups` — groups with member + active-pricing counts; single-default enforced (old default auto-cleared in a transaction); name conflicts → 409; deletes are safe (membership SET NULL, pricing rows cascade, sale snapshots untouched by design).
- `GET/PUT/DELETE /api/customer-groups/:id/members[/:customerId]` — bulk membership assignment with ownership verification; membership is the live reference (group discounts snapshot onto sale lines at transaction time).
- `GET/POST/PATCH/DELETE /api/customer-groups/:id/pricing[/:pricingId]` — group pricing CRUD mirroring the DB CHECKs (scope XOR, percentage ≤ 100, date order) with merged-object PATCH validation.
- Permissions: writes `pricing.customer_groups.manage`, reads `pricing.view`; audit actions `pricing.customer_group.*`.

### POS frontend (minimal by design)
- Quote totals render a **"<Group name> pricing −৳X"** line above the coupon line. Customer-change re-quoting was already wired (customerId is a quote effect dependency) — changing General → Wholesale reprices the cart automatically; nothing else in the sale flow moved.

### Bug fixed en route (found by the new tests)
- `/api/sales/quote` **priced variants from other businesses at 0 instead of 404** (the quote path lacked the existence check createSale has). Now guarded.

## Files changed

**New:** `src/modules/pricing/pricing.salePricing.ts`, `src/modules/customerGroups/{customerGroups.validation,customerGroups.service,customerGroups.controller,customerGroups.routes}.ts`, `src/test/pricingGroups.integration.test.ts`.
**Modified:** `sales/utils/cartPricing.ts` (+group input, both engines, +5 unit tests), `sales.service.ts` (createSale + quoteSaleTotals integration, foreign-variant 404 guard), `app.ts` (mount), POS: `features/pos/quote.api.ts` + `components/pos/CartItems.tsx` (group line).

## Database changes

None (0063 carried the schema).

## API changes

| Method/Path | Permission |
|---|---|
| `GET /api/customer-groups` | `pricing.view` |
| `POST/PATCH/DELETE /api/customer-groups[/:id]` | `pricing.customer_groups.manage` |
| `GET/PUT/DELETE /api/customer-groups/:id/members[/:customerId]` | view / `.manage` |
| `GET/POST/PATCH/DELETE /api/customer-groups/:id/pricing[/:pricingId]` | view / `.manage` |
| `POST /api/sales/quote` + `POST /api/sales` | unchanged permissions; response/payload extensions above |

## Tests & results

- `pricingGroups.integration.test.ts`: **12/12** — group CRUD (single default, 409 name conflict), membership assign/remove + foreign-customer rejection, group-pricing validation (percentage cap, date order), **quote stacking matrix** (whole-cart 30 + scoped 5 = 35 → final 265; walk-in/groupless 300; manual-after-group; coupon stacks with group at 238.5 but XOR manual; VAT base 300−35=265 → 39.75 → 304.75), min-purchase + future-validFrom gating, group deactivation, **createSale snapshots** (header group id + discount 35; line adjustments [10,5] / [20] named "Wholesale"; effective price untouched at 100), tenant isolation (empty groups; foreign-variant quote 404), permission matrix.
- Engine unit tests: **17/17** (12 pre-existing bit-for-bit + 5 group cases: manual-after-group ordering, zero-change, line-scoped tax-base reduction, pro-rata allocation, zero-clamp).
- POS vitest: **269/269**; `vite build` green.
- Full backend suite: **929 pass / 0 fail / 1 skipped** (pre-existing backups conditional), `tsc --noEmit` clean.

## Known limitations

1. Exchange replacement lines (createSaleExchange) keep base prices — group pricing there would need difference-settlement rework; documented and deferred.
2. `stacksWithPromotions` flags are stored but promotions (their counterpart) arrive in Phase 5.
3. The manual-cart-discount percentage now bases on the post-group total when a group discount exists — intended per the approved stacking order; no group → identical behavior.
4. Customer-group management UI (group CRUD pages, per-customer assignment in Contacts) ships with the Phase 5/6 frontend work; the endpoints are complete and the POS display works today.
