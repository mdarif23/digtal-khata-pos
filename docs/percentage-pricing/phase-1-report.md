# Phase 1 — Pricing Calculation Engine, Settings, Cost Provider, Preview
Percentage-Based Pricing Management · branch `feature/percentage-pricing`
Date: 2026-11-08 · Approved design: [phase-0-audit-and-architecture.md](./phase-0-audit-and-architecture.md) §13/§14/§18

## Scope delivered

- **`pricing_settings`** — singleton per business (posSettings pattern): default method (fixed/markup/margin) + percentage, rounding increment/direction, Mode-B auto-update flags, business-wide minimum-margin floor. Absent row = all defaults.
- **`pricing.engine`** — pure calculation module on BigInt micros: markup `cost × (1+pct/100)` ≠ margin `cost / (1−pct/100)`, margin ≥ 100 rejected (engine *and* DB CHECK), fixed prices cost-free, explicit `cost_unavailable` instead of zero-cost, final-stage rounding (`none | 0.01 | 1 | 5 | 10` × `nearest | up | down`), minimum-price/margin floor evaluation.
- **`pricing.money`** — integer decimal helpers (2-dp money ↔ micros, Postgres numeric literal parsing at 6 dp, half-up division, single-stage rounding grid).
- **`PricingCostProvider`** — the one cost read-path for pricing: weighted average of on-hand `inventory_batches.landed_cost_per_unit` (the authoritative generated column), optional per-location narrowing, explicit unavailable result.
- **Preview endpoint** — `POST /api/pricing/preview` computes per-variant recommended prices from settings (Phase-1 source: `settings_default`) or a request what-if override (`request_override`), reports current selling price, cost (permission-gated), rounding-applied recommendation, and minimum-price violations. **Never persists.**
- **Foundation migration `0063_pricing_foundation.sql`** — the full approved §13 schema, additive-only: pricing_settings, pricing_rules (+4 partial unique precedence indexes), customer_groups, customers.customer_group_id (plain FK, ON DELETE SET NULL), customer_group_pricing, pricing_promotions, promotion_customer_groups, price_change_proposals, product_price_history, sale_items.price_adjustments jsonb, sales.customer_group_id (snapshot, no FK), product_variants.min_selling_price, categories_id_business_uq candidate key. RBAC section inserts the 8 `pricing.*` keys and **retro-grants** them to existing businesses' roles (manager+owner via `products.edit`, accountant via `reports.profit.view` — 0039 precedent).
- **RBAC** — catalog + role presets: manager all 8 keys, accountant view+history, cashier none, owner wildcard. Verified on `ezpos_test`: retro-grant matched 136,800 existing role_permission rows.

## Files changed

**New:** `ezPosBackend/drizzle/0063_pricing_foundation.sql`, `src/db/schema/pricing.ts`, `src/modules/pricing/{pricing.money,pricing.engine,pricing.costProvider,pricing.service,pricing.validation,pricing.controller,pricing.routes}.ts`, `src/modules/pricing/pricing.engine.test.ts`, `src/test/pricing.integration.test.ts`.
**Modified:** `src/app.ts` (mount `/api/pricing/*`), `src/rbac/permissions.ts` (8 keys + presets), schema files with additive columns (`customers.ts`, `sales.ts`, `saleItems.ts`, `productVariants.ts`, `categories.ts`), `drizzle/meta/_journal.json` (idx 63).

## Database changes

Migration 0063 applied to `ezpos_test` (drizzle journal: 64 entries). Validated first on a schema-clone scratch DB with `psql -1 -v ON_ERROR_STOP=1` (silent-drizzle-failure gotcha). **Dev/prod application is the user's machine step (`npm ci` + `db:migrate`).** Rollback = DROP TABLE / DROP COLUMN; nothing existing was altered or backfilled.

## API changes

| Method/Path | Permission | Notes |
|---|---|---|
| `GET /api/pricing/settings` | `pricing.view` | defaults when unset |
| `PUT /api/pricing/settings` | `pricing.manage` | partial payload, merged-object validation (fixed⇔no-pct, margin<100) |
| `POST /api/pricing/preview` | `pricing.view` | ≤500 variants; cost stripped without `products.view_cost` |

## Frontend changes

None (backend-only phase, per approved §18). The client RBAC catalog mirror lands with the Pricing UI phase.

## Tests & results

- `pricing.engine.test.ts` (pure): **25/25 pass** — master-prompt cases 1–7 (markups 10/20/30, margins 20/50, margin≥100 rejected, fixed), markup≠margin divergence, decimal precision (0.1×1.1=0.11 exact; 6-dp batch costs), cost-unavailable (case 19), rounding grid × direction, minimum-price/margin floors (case 17/18 incl. exact-boundary pass and negative profit).
- `pricing.integration.test.ts`: **11/11 pass** — settings CRUD + cross-field validation (incl. merged partial-PUT semantics), preview available/unavailable/not-required, margin/fixed overrides, rounding applied once, minimum-price violations without fabricated cost, **effective-price separation invariant (preview never mutates `selling_price`)**, cost stripping for viewers without `products.view_cost`, new-business role presets, tenant isolation (404 cross-business), 403 on missing `pricing.manage`.
- Full backend suite: **900 pass / 0 fail / 1 skipped** (864-baseline cases + 36 new; the single skip is the pre-existing conditional `backups pipeline` test), `tsc --noEmit` clean.

## Known limitations

1. Preview source is `settings_default` only — rule resolution (variant>product>nearest-category>global) arrives in Phase 2.
2. Recommended prices use the on-hand weighted-average landed cost; actual COGS remains FIFO-at-sale (inherent FIFO variance, documented in §3 of the audit).
3. No materialization path yet — the selling price cannot be changed from the pricing module until Phase 2/3 (by design; import/manual writes remain the only price writers today).
4. `sale_items.price_adjustments` is written as `[]` by default; the sale-time adjustment layer is Phase 4/5.
5. Cost stripping covers the preview response; the future Pricing UI must keep cost columns behind `products.view_cost` as well.
