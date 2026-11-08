# Phase 6 — POS Price Override, Minimum-Price Protection, Receipt Breakdown
Percentage-Based Pricing Management · branch `feature/percentage-pricing`
Date: 2026-11-08 · Approved design: [phase-0-audit-and-architecture.md](./phase-0-audit-and-architecture.md) §18 P6 · Predecessor: [phase-5-report.md](./phase-5-report.md)

## Scope delivered

### Permission-gated price override (backend)
- **Payload** (`sales.schema.ts`): optional per-line `priceOverride: {unitPrice, reason?}` on cart items — the cashier's price **in the ENTERED selling unit** — plus payload-level `belowMinimumReason`. The client's plain `unitPrice` stays ignored (server-authoritative unchanged); the override is the single sanctioned exception, gated by `pricing.price_override`.
- **Controller gate** (`sales.controller.ts`): any override in the payload from a caller without `pricing.price_override` → **403** (beside the existing `pos.apply_discount` gate). The below-minimum override permission is resolved at the controller (`callerHasPermission`) and passed into the service as `options.allowBelowMinimum`.
- **Resolution** (`sales.uom.ts`): base lines charge the override; UOM lines divide it by the conversion factor so the per-base snapshot stays per-base. `uomSnapshot.enteredUnitPrice` reflects the typed price. The output carries `overrideSnapshot {enteredUnitPrice, reason}` and `listUnitPrice` (what the line WOULD have charged) for the attribution entry.
- **Snapshots**: `sale_items.selling_price` = the charged (overridden) per-base price — the variant row is NEVER touched (governing principle). `price_adjustments` gains `{kind:'manual', refId:null, name:'Price override', amount: (list − charged) × qty (signed: discount +, surcharge −), reason}` appended after group/promotion entries. One in-transaction audit row `pricing.price_override` per sale lists every override (roll-back-safe).

### Minimum-price protection (backend)
- **`pricing.saleFloors.ts`** — `evaluateMinimumFloors` computes each line's effective per-base charge (line discount + pro-rata manual cart allocation + group + promotion amounts — the shared `lineChargeAfterAllocations` helper works for both totals engines) and checks:
  - `product_variants.min_selling_price` (per-base floor), and
  - the business-wide `pricing_settings.min_margin_percent`, measured against the **PricingCostProvider** weighted-average landed cost — cost-unavailable SKIPS the margin check explicitly (never priced from nothing).
- **Quote**: violations always come back as `warnings: [{variantId, code:'below_minimum', message, effectiveUnitPrice, minPrice, marginPercent, floorMarginPercent}]` — warn always.
- **createSale**: violations BLOCK (400, per-line messages) unless the caller holds `pricing.below_minimum_override`; when allowed, a reason is MANDATORY (line override reason or payload `belowMinimumReason`) and an entry `{kind:'manual', name:'Below-minimum approval', amount:0, reason}` is snapshotted on each violating line.

### Receipt & invoice breakdown (frontend)
- `getSaleReceipt` now returns each line's `priceAdjustments`; the shared HTML renderers (`receiptHtml.ts`, `invoiceHtml.ts`) append sub-lines for group/promotion discounts (`name: -৳X`) and override/approval notes (reason text, signed amounts) — in application order. The POS receipt types carry the optional field; empty snapshots render nothing (zero behavior change for legacy receipts).

### POS register UI (frontend)
- **Per-line override**: an "Override price" button on each cart line — visible only with `pricing.price_override` — opens a dialog (unit price + reason, reset-to-list action) and stores the override on the line (`useCartStore.setLinePriceOverride`, per (variant, unit) line key). The quote sends `priceOverride` so the cashier sees the repriced total before charging; `PosPage` sends it in the sale payload (schema-validated).
- **Below-minimum flow**: the cart totals panel shows the quote's warnings inline (⚠ message list); holders of `pricing.below_minimum_override` get a mandatory reason input bound to the store, sent as `belowMinimumReason` and cleared on cart reset.

## Files changed

**New:** `src/modules/pricing/pricing.saleFloors.ts`, `src/test/pricingOverride.integration.test.ts`.
**Modified:** `sales/schemas/sales.schema.ts`, `sales/sales.validation.ts` (min price on the locked variant read), `sales/sales.uom.ts`, `sales/sales.controller.ts`, `sales/salesExchange.controller.ts` (quote schema), `sales/sales.service.ts` (createSale floor gate + snapshots + audit; quote warnings; receipt adjustments), `sales/utils/cartPricing.ts` (`lineChargeAfterAllocations`), `db/schema/pricing.ts` (`SalePriceAdjustment.reason?`), POS: `quote.api.ts`, `schemas/cart.schema.ts`, `types/cart.types.ts`, `stores/useCartStore.ts`, `pages/PosPage.tsx`, `components/pos/CartItems.tsx`, `types/receipt.types.ts`, `features/receipt-settings/renderers/{receiptHtml,invoiceHtml}.ts`.

## Database changes

None (`product_variants.min_selling_price` + `pricing_settings.min_margin_percent` landed in 0063; both already surfaced by the Phase 2 apply flow).

## API changes

| Surface | Permission | Notes |
|---|---|---|
| `POST /api/sales` with `items[].priceOverride` | `pricing.price_override` (403 without) | below-minimum lines additionally need `pricing.below_minimum_override` + reason |
| `POST /api/sales/quote` with `priceOverride` / response `warnings` | unchanged | warnings informational |
| `GET /api/sales/:id/receipt` | unchanged | items gain `priceAdjustments` |

## Tests & results

- `pricingOverride.integration.test.ts` (5 cases): quote override + below-minimum warning shape; 403 without the permission / 201 with it (charged price, signed adjustment, variant price untouched, audit row); floor block without permission, mandatory reason, approved snapshot with reason; margin floor (20% discount on a 50-cost item blocked at a 40% floor, quote warning carries margin numbers, approved with reason, no-batch variant explicitly skips the margin check); receipt renders the override breakdown. **Status: written, self-skip green; needs `INTEGRATION_TESTS=1` + reachable `ezpos_test` (credentials blocker, see phase 8 report).**
- Backend `tsc --noEmit` clean; unit suite 197 pass / 0 fail / 1 skipped (pre-existing backups conditional); POS `vite build` green; POS vitest 265 pass + 4 pre-existing `terminalBinding` environment failures (verified failing identically on the clean Phase-4 tree via `git stash` — unrelated to this program).

## Known limitations

1. The below-minimum check measures per-line charges after line/group/promotion/manual allocations — a cart-level COUPON can still push the FINAL total below cost (coupons are a separate Module-6 system; their min-order evaluation runs post-floor).
2. Offline-mode sales inherit the floors at sync time (the same service runs server-side); a truly offline terminal cannot surface the interactive reason prompt until sync — a below-minimum offline sale will be rejected at application time unless the sync actor holds the permission, matching audit §12.9.
3. The margin floor uses the global weighted-average cost (same basis as materialization); FIFO-at-sale COGS variance is inherent and documented (audit §3).
