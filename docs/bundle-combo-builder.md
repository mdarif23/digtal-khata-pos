# Bundle & Combo Builder

Dynamic bundles, combos, reward promotions, and campaigns for ezPos — built
**on top of the existing promotions engine** (`pricing_promotions`), not as a
parallel system. Branch history: `feature/bundle-combo-builder` phases 1–5
(migrations 0095–0098).

## Overview

| Promo kind | What it does | Example |
|---|---|---|
| `discount` | Whole-cart or scoped % / fixed discount | 10% off everything |
| `bogo` | Buy X get Y free, same item, cheapest-first free units | Buy 2 get 1 free |
| `buy_x_get_y` | Buy product X, get product Y free / at a % / at a fixed price | Buy 10 pens, get 1 free · Buy 2 shirts, get accessory at ৳10 |
| `mix_match` | Any N units from a scope, % off | Any 3 stationery items, 10% off |
| `quantity_tier` | Line % discount by quantity tiers | 5+ → 5%, 10+ → 10% |
| `bundle` | **Fixed bundle**: exact component multiset at a package price or % off | 5 NB + 3 pens + 2 pencils + 1 eraser = ৳299 |
| `spend_get` | **Spend-qualified reward**: cart ≥ ৳X → get product free / % / fixed price | Spend ৳2,000 → get gift free |

A campaign (`promotion_campaigns`) **organizes and gates** promotions: an
inactive, expired, or out-of-location campaign suppresses every promotion
attached to it. Campaign priority breaks ties between same-priority
promotions. Campaigns never hold pricing logic.

## Engine semantics (`pricing.salePromotions.ts`)

- **Evaluation**: server-side only, shared by `POST /api/sales/quote` and
  `createSale` — quote == checkout, always. Near-misses power the POS offer
  strip.
- **Stacking order** (approved policy §12.2): base price → line discount →
  **group discount** → **promotions** (priority DESC → campaign priority →
  id ASC, priced on post-group bases) → manual cart discount → VAT → charges.
  A promotion stacks with a group discount or a coupon only when its consent
  flags allow.
- **Bundles**: repetitions = min over components of ⌊available/required⌋
  (capped by `maxApplications`); covered units taken cheapest-effective-first;
  discount = covered value − `bundlePrice × reps` (or `covered × percent`),
  allocated pro-rata across the covered lines. The bundle can never discount
  past the post-group cart.
- **Rewards** (`takeRewardUnits`): cheapest-unit-first, whole units,
  `Math.max(0, unitPrice − getPrice)` for fixed-price rewards (a reward price
  at/above the unit price discounts nothing).
- **Minimum-price floors** (Phase 6 pricing) protect every discounted line.

## Inventory & accounting guarantees

Bundle/spend-get components are **ordinary cart lines** — stock, batches
(FEFO + manual-batch policy), serials, and floors flow through the existing
sale paths with zero new inventory code. COGS comes from the components' own
batches, so gross profit = bundle price − real component cost, automatically.

**Composite note**: BOM-composite *products* (assemble-on-sale parents) never
held parent stock — refunds and voids now restore **component** stock rows via
the BOM formula symmetric with sale time (Phase 5 fixed the old parent-row
increment). `sale_item_batch_consumptions` provenance still restores the exact
component batches.

Refunds of discounted lines are pro-rata of effective value (the sale-level
delta spreads the bundle discount fairly); a returned free item refunds ≈ ৳0
and restocks its stock. Voids release `promotion_usage` counters.

## POS integration

- Applied promotions render in the cart totals; receipts show
  `"promotion name: -amount"` from `price_adjustments`.
- `BundleCards` strip above the product grid: live bundles with a savings
  badge and one-tap **Add bundle** (tops the cart up to the requirement;
  serial-tracked components are refused up front; client-side stock takes
  roll back on shortfall). Self-hiding when offline/loading/empty.
- Near-miss chips for bundles get an **Add missing** action.

## API

| Endpoint | Permission | Notes |
|---|---|---|
| `GET/POST/PATCH/DELETE /api/promotions[/:id]` | `promotions.view` / `promotions.manage` | All kinds; bundles take `components: [{variantId, quantity}]`; all kinds accept `campaignId` |
| `GET /api/promotions/active-bundles?locationId=` | `pos.view` | Bundles applicable right now, with components (feed mirrors engine filters) |
| `GET/POST/PATCH/DELETE /api/campaigns[/:id]` | `promotions.view` / `promotions.manage` | Campaign CRUD (audit: `pricing.campaign.*`) |
| `GET /api/reports/pricing/campaign-performance` | `promotions.view` + `advancedReports` | Distinct sales + discount rollup per campaign |
| `GET /api/reports/pricing/promotion-performance` | unchanged | Counts every engine kind via `price_adjustments` |

Validation: `rule` is kind-validated at write time (H3-1 discipline — a
malformed rule is rejected, never silently skipped). Scope columns are
rejected for `bundle`/`spend_get` (their rule is the whole definition). Zod
strips unknown payload keys — new fields must be declared in
`promotions.validation.ts`.

## Configuration

- **Permissions**: `promotions.view` / `promotions.manage` (existing keys).
  Promotions are store configuration — no plan entitlement gates them; the
  *reports* follow `advancedReports`.
- **Usage limits**: `usageLimit` / `perCustomerLimit` per promotion,
  idempotent per (business, sale, promotion), released on void.
- **Flash windows**: `daysOfWeek` + `startTime`/`endTime` in Asia/Dhaka
  (UTC+6 fixed), per promotion.

## Migrations

| # | Content |
|---|---|
| 0095 | `promotion_bundle_components` (composite FKs cascade, unique promotion+variant) |
| 0096 | promo_kind CHECK + `'bundle'` |
| 0097 | promo_kind CHECK + `'spend_get'` |
| 0098 | `promotion_campaigns` + `pricing_promotions.campaign_id` (plain FK SET NULL) |

Rollback: drop the new table / restore the previous CHECK / drop the column.

## Tests

- `src/test/promotionsBundles.integration.test.ts` — engine + CRUD + campaigns (22 tests)
- `src/test/bundleE2eScenarios.integration.test.ts` — master-prompt scenarios 1–5, F1 composite symmetry, concurrency race (8 tests)
- `pos/src/features/pricing/bundleForm.test.ts` + `pos/src/features/pos/bundleCart.test.ts` — form/feed math (22 tests)

Known scope limits: storefront/online checkout does not evaluate promotions
(pre-existing — POS/quote only); the POS bundle feed is server-fetched
(hidden offline); promo-vs-promo stacking is unconditional by design
(group/coupon consent is the documented gate).
