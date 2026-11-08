# Phase 2 — Pricing Rules: Resolution, CRUD, Materialization, History
Percentage-Based Pricing Management · branch `feature/percentage-pricing`
Date: 2026-11-08 · Approved design: [phase-0-audit-and-architecture.md](./phase-0-audit-and-architecture.md) §18 P2 · Predecessor: [phase-1-report.md](./phase-1-report.md)

## Scope delivered

- **Resolution engine** (`pricing.resolution.ts`) — the approved precedence chain **variant > product > nearest category ancestor > global**, first ACTIVE rule wins, missing/inactive rules fall through to the next level and terminate at the business default (`pricing_settings`). Category ancestors walk `categories.parent_id` (cycle- and depth-guarded). One context load (`activeRules` + category map + settings) resolves any number of variants in memory.
- **Rules CRUD** — global and category scopes live in Phase 2 (product/variant scopes resolve already and gain CRUD in Phase 3):
  - `GET /api/pricing/rules` (`pricing.view`) — rows carry scope label ("Category › Parent…", "Whole business").
  - `POST/PATCH/DELETE /api/pricing/rules[/:id]` (`pricing.manage`) — strict zod shapes mirroring the DB CHECKs; merged-object validation on PATCH; scope ownership verified before write (composite FKs backstop); duplicate active-scope conflicts surface as **409** (the 23505 constraint error is unwrapped through drizzle's `DrizzleQueryError.cause`); audit entries `pricing.rule.create/update`.
- **Materialization — the ONE sanctioned write to the effective price** (`pricing.product.manage`):
  - `PUT /api/pricing/products/:variantId/price` — transactional, variant row `FOR UPDATE`; resolves the effective rule; percentage methods pull the **global** weighted-average landed cost (the selling price is business-global — per-location narrowing removed from preview too, §2.1 of the audit); engine computes → final-stage rounding from settings → **minimum-floor check blocks below-minimum applies (409)** → writes `product_variants.selling_price` (the LAN-sync `updated_at` watermark is trigger-maintained) → appends `product_price_history` (`source: rule_apply`, old/new price, rule id, 6-dp `cost_at_change`, optional reason, actor) → audit `pricing.price.applied`. Re-applying an unchanged recommendation is a documented no-op (`{applied:false, unchanged:true}`, no history row).
  - `GET /api/pricing/products/:variantId/price` (`pricing.view`) — effective configuration, source rule, recommended price, cost (**stripped without `products.view_cost`**), floors and violations.
- **Price history** — `GET /api/pricing/history?variantId=&page=&pageSize=` (`pricing.history.view`), `{rows, meta}` pagination, `cost_at_change` stripped for non-cost callers.
- **Preview upgrade** — rows now report the resolved `source` object (`variant_rule | product_rule | category_rule | global_rule | settings_default | request_override` with rule id + human label) instead of the Phase-1 flat string; cost basis aligned to global (same as materialization).

## Files changed

**New:** `src/modules/pricing/pricing.resolution.ts`, `src/test/pricingRules.integration.test.ts`.
**Modified:** `pricing.rules.service.ts` (new — CRUD/materialize/history/view), `pricing.service.ts` (preview over the resolver), `pricing.validation.ts` (rule/create/update/strict, apply-price, history schemas), `pricing.controller.ts` (+7 handlers, cost stripping for every pricing response), `pricing.routes.ts` (+7 routes), Phase-1 test assertions for the new preview source shape.

## Database changes

None (Phase 1's migration 0063 already created every table; this phase ships zero new migrations).

## API changes

| Method/Path | Permission | Notes |
|---|---|---|
| `GET /api/pricing/rules` | `pricing.view` | scope labels included |
| `POST /api/pricing/rules` | `pricing.manage` | 409 on active-scope duplicate; 400 shape validation |
| `PATCH /api/pricing/rules/:id` | `pricing.manage` | merged-object validation |
| `DELETE /api/pricing/rules/:id` | `pricing.manage` | history/proposals keep content (SET NULL FKs) |
| `GET /api/pricing/products/:variantId/price` | `pricing.view` | cost gated |
| `PUT /api/pricing/products/:variantId/price` | `pricing.product.manage` | the materialization write |
| `GET /api/pricing/history` | `pricing.history.view` | `{rows, meta}` |

## Frontend changes

None in this phase (per approved §18, UI arrives with Phase 3; the endpoints above are UI-ready).

## Tests & results

- `pricingRules.integration.test.ts`: **12/12 pass** — global-rule CRUD + active-duplicate 409; shape validation (margin 100, fixed+percentage, multi-scope → 400); **precedence chain end-to-end** (category beats global, nearest ancestor beats farther ancestor, deactivations fall through to global then settings default, computed via preview: 62.50 → 65 → 62.50 → 55 → 52.50 across rule activations); re-activation conflict 409; **materialization** (100 → 55 with history row old/new/source/rule/cost 50, audit row, unchanged re-apply no-op); minimum-floor block (409, price + history untouched); cost-unavailable conflict (never zero); fixed-rule materialization without cost (79.99); per-variant history filter + pagination; permission matrix (viewer reads rules but 403s on manage/materialize/history); tenant isolation (404 cross-business, empty rule list for business B).
- Phase-1 suites re-run green (engine 25/25, pricing integration 11/11 after the source-shape update).
- Full backend suite: **912 pass / 0 fail / 1 skipped** (pre-existing backups-pipeline conditional), `tsc --noEmit` clean.

## Known limitations

1. Rule CRUD covers global + category only; product/variant scope rules resolve correctly (arms tested via fallthrough) but their CRUD + Pricing matrix UI are Phase 3.
2. Materialization applies one variant at a time — bulk apply and the proposals/auto-update sweeps are Phase 8.
3. Cost basis is the global weighted average; FIFO-at-sale COGS variance is inherent and documented (audit §3).
4. Deletion of a rule is a hard delete (history keeps its content via SET NULL); there is no rule-archival UI yet.
