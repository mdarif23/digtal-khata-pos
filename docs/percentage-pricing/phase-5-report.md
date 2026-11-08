# Phase 5 — Auto-Applied Promotions: Engine, Stacking Policy, Checkout Integration
Percentage-Based Pricing Management · branch `feature/percentage-pricing`
Date: 2026-11-08 · Approved design: [phase-0-audit-and-architecture.md](./phase-0-audit-and-architecture.md) §18 P5 · Predecessor: [phase-4-report.md](./phase-4-report.md)

## Scope delivered

### Sale-time promotion layer (backend)
- **`pricing.salePromotions.ts`** — server-side evaluation shared by quote AND createSale (the coupons + group-pricing engine pattern). Promotions are store configuration that applies BY ITSELF — never permission-gated.
- **Eligibility** (all server-side): `isActive`, `startsAt`/`endsAt` window (timestamps), `minOrderValue` measured on the POST-GROUP cart total, `minQuantity` on total base quantity, and group eligibility via `promotion_customer_groups` — no rows = every customer **including walk-ins**; rows = listed ACTIVE groups only.
- **Scoping**: whole-business rows produce whole-cart amounts; category/product/variant rows match per line (variant → product → category, no ancestor walk — the row's own category only) and cap the row's AGGREGATE at `maxDiscountAmount` via proportional scaling (last matching line absorbs the remainder).
- **Stacking policy (deterministic, approved §12.2)** — application order: base price → GROUP → promotions → manual discounts → VAT:
  - A promotion applies with an applied group discount only when BOTH sides consent: `canStackWithGroupDiscount` on the promotion AND `stacksWithPromotions` on EVERY applied group-pricing row (Phase 4's group evaluation now returns this consent flag). Otherwise the promotion is skipped entirely — the automatic group layer wins.
  - A promotion applies with a coupon in the cart only when `canStackWithCoupons` is set; otherwise skipped. The coupon's min-order/percentage base is the post-group-post-promotion total (the engine's `afterDiscount`).
  - Multiple eligible promotions each compute on the same post-group base (independent, deterministic).
  - The promotion layer can never exceed the post-group cart itself (final proportional guard).
- **Cart engine extension** (`sales/utils/cartPricing.ts`) — optional `CartPromotionInput` on both totals engines. Whole-cart promotion rows allocate pro-rata over the POST-GROUP line totals (exported `allocateProRata` shared with the evaluator so quote and engine can never disagree about a base); line-scoped amounts apply verbatim; per-line tax bases subtract the promotion allocations. `LineTax`/`TaxedTotals`/legacy totals gain `promotionAdjustments`/`promoCartAmount`/`promoLineTotal`. **Empty input reproduces the pre-promotions totals bit-for-bit.**
- **createSale integration** — each `sale_items.price_adjustments` entry now records `{kind:'promotion', refId, name, amount}` AFTER the group entries (application order, self-describing names); the header `discount` carries the promotion layer too. Coupon XOR manual cart discount unchanged.
- **quote integration** — identical evaluation; response gains `promotions: {applied: [{id, name, amount}], total}` for the register display.

### Promotions CRUD (`/api/promotions`, the pricing module)
- `GET/POST/PATCH/DELETE /api/promotions[/:id]` — reads `promotions.view`, writes `promotions.manage` (the catalog keys reused, per approved §14; the coupon API at `/api/coupons` is untouched). Scope XOR, percentage ≤ 100, date order and group ownership mirror the DB CHECKs; merged-object PATCH validation; group eligibility replaced atomically (`groupIds` present = replace the list); audit `pricing.promotion.*`. List rows carry `scopeLabel` + eligible groups.

## Files changed

**New:** `src/modules/pricing/pricing.salePromotions.ts`, `src/modules/pricing/promotions.{validation,service,controller,routes}.ts`, `src/test/pricingPromotions.integration.test.ts`.
**Modified:** `sales/utils/cartPricing.ts` (+promotion layer, `allocateProRata` export, +4 engine unit tests), `pricing.salePricing.ts` (+`stacksWithPromotions` consent), `sales.service.ts` (createSale + quote integration), `sales/schemas/sales.schema.ts`? no — schema untouched this phase, `app.ts` (mount), POS: `quote.api.ts` + `components/pos/CartItems.tsx` (promotion total line).

## Database changes

None (0063 carried `pricing_promotions` + `promotion_customer_groups`).

## API changes

| Method/Path | Permission | Notes |
|---|---|---|
| `GET/POST/PATCH/DELETE /api/promotions[/:id]` | view `promotions.view` / write `promotions.manage` | scope XOR + percentage cap + date order validated |
| `POST /api/sales/quote` + `POST /api/sales` | unchanged | response/payload extensions above |

## Tests & results

- `cartPricing.test.ts`: **21/21** (17 pre-existing bit-for-bit + 4 promotion cases: post-group pro-rata allocation, line-scoped rules-path snapshot, bit-for-bit no-op, zero-clamp).
- `pricingPromotions.integration.test.ts` (13 cases): CRUD + validation (percentage cap, multi-scope, date order, foreign group 404), group-eligibility replace semantics, quote stacking matrix (walk-in 30/270; group+promo both-consent 40+39; promo-refusal skip; group-row-refusal skip; category-scoped on post-group bases; minOrder on post-group total; minQuantity; future startsAt; whole-cart cap and scoped aggregate cap; group-restricted promotion excluding walk-ins and wrong-group members), coupon interplay (non-stacker skips; stacker + coupon base post-promotion), createSale snapshots (adjustment order group→promotion with names, header discount 79, effective price untouched), tenant isolation, permission matrix. **Status: written, self-skip green; needs `INTEGRATION_TESTS=1` + a reachable `ezpos_test` to execute (DB credentials blocker, see phase 8 report).**
- Backend `tsc --noEmit` clean; unit suite 197 pass / 0 fail / 1 skipped (pre-existing backups conditional); POS `vite build` green.

## Known limitations

1. Category-scoped promotions match the row's exact category only (no ancestor walk) — rule precedence does the ancestor walk, promotions do not; documented.
2. Multiple simultaneous promotions compute independently on the same post-group base (two 10% promos = 20%) — there is no promotion-vs-promotion priority yet.
3. Exchange replacement lines keep base prices (as Phase 4).
4. Coupons remain non-scoped by group (unchanged); `price_adjustments` kind `coupon` is reserved but coupon amounts stay in `coupon_redemptions`.
