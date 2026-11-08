# Phase 3 — Product/Variant Overrides + Pricing Frontend Module
Percentage-Based Pricing Management · branch `feature/percentage-pricing`
Date: 2026-11-08 · Approved design: [phase-0-audit-and-architecture.md](./phase-0-audit-and-architecture.md) §18 P3 · Predecessor: [phase-2-report.md](./phase-2-report.md)

## Scope delivered

### Backend (small polish)
- **Variant labels in the rules list** — `listRules` now resolves "Product (Option, Option)" labels via the shared `variant_values`/`variant_options` aggregation, so variant-scope rules display as `Football — SKU (Small)` rather than bare SKU. Product/variant rule CRUD required **no new backend work**: the Phase-2 endpoints, validation, conflict handling and materialization already accept every scope (the resolution arms were live from Phase 2; their CRUD is simply reachable now).

### Frontend — the Pricing module (`pos/src/features/pricing/`)
- **`pricing.types.ts` / `pricing.api.ts` / `hooks/usePricing.ts`** — typed client over the seven `/api/pricing/*` endpoints through the **shared axios instance** (deliberately not the finance.api bare-axios pattern), `{success, data}` unwrapping, `pricingKeys` query-key factory (stable sorted-ids preview keys), mutations invalidating the `all` root — the finance-feature pattern.
- **Product Pricing matrix** (`/pricing/products`) — per-variant: effective price, **inheritance-source badge** (Variant override / Product rule / Category rule / Global rule / Business default), active rule summary (markup % / margin % / fixed), cost column shown only with `products.view_cost`, recommendation after settings rounding, minimum-violation badges, search + pagination (25/page) with a batched preview per page. Actions: **Apply** (`pricing.product.manage` — the audited materialization, with success toast showing old → new and a no-op toast on unchanged), **Override** (`pricing.manage` — creates a variant-scope rule via the shared dialog, pre-scoped to the row's variant), **Clear override** (deletes the variant rule → the variant inherits again).
- **Pricing Rules** (`/pricing/rules`) — scope/method rule table with scope labels, edit dialog (scope chips locked when editing), activate/deactivate, delete-with-history note; server 409 conflicts surface verbatim as toasts ("An active rule already exists for this scope…").
- **Pricing Settings** (`/pricing/settings`) — business defaults (method chips with formula hints, percentage, rounding increment/direction, minimum-margin floor) and the Mode-B auto-update preferences (stored now; the sweep itself ships in Phase 8, noted in the UI).
- **Wiring** — new top-level **Pricing** nav section (`BadgePercent`) with three permission-gated entries, three `RequirePermission` routes, and the eight `pricing.*` keys mirrored into the client RBAC catalog (`lib/rbac.ts` — they now appear in the Roles matrix).
- **Wiring test** (`pricing.wiring.test.ts`) — finance.wiring.test.ts pattern: catalog parity both directions for the 8 keys, nav section presence + gates, query-key uniqueness/stability.

## Files changed

**Backend:** `pricing.rules.service.ts` (variant label aggregation in `listRules`).
**Frontend new:** `pos/src/features/pricing/{pricing.types.ts, pricing.api.ts, hooks/usePricing.ts, components/RuleDialog.tsx, pages/{ProductPricingPage,PricingRulesPage,PricingSettingsPage}.tsx, pricing.wiring.test.ts}`.
**Frontend modified:** `lib/rbac.ts`, `config/navigation.ts`, `routes/AppRoutes.tsx`.

## Database changes

None.

## API changes

None (Phase-2 endpoints consumed; `listRules` rows gain a richer variant scope label).

## Tests & results

- POS vitest: **269 passed / 0 failed (41 files)** — includes the new pricing wiring tests (4).
- `vite build`: green (pre-existing chunk-size warnings only).
- Backend: pricing suites re-run green after the label change (`pricingRules` 12/12); full backend suite: **912 pass / 0 fail / 1 skipped** (pre-existing backups conditional), `tsc --noEmit` clean.

## Known limitations

1. The matrix previews 25 variants per page (server batch) — a whole-catalog virtualized view can come later if needed.
2. Editing a rule's percentage happens through the dialog (no inline editing).
3. Price history UI/report and bulk update remain Phase 7/8; the matrix is the only apply surface for now.
4. Cost columns depend on `products.view_cost` as designed; managers/cashiers without it see "—" instead of figures.
