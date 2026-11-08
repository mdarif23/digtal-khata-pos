# Phase 8 — Bulk Update, Mode A Proposals, Mode B Auto-Update Sweep
Percentage-Based Pricing Management · branch `feature/percentage-pricing`
Date: 2026-11-08 · Approved design: [phase-0-audit-and-architecture.md](./phase-0-audit-and-architecture.md) §18 P8 · Predecessor: [phase-7-report.md](./phase-7-report.md)

## Scope delivered

### Shared recommendation + materialization core (`pricing.apply.service.ts`)
- **`recommendForVariant`** — pure per-variant recommendation (rule resolution → cost provider → engine → final-stage rounding → minimum-floor check). Blocked recommendations are EXPLICIT (`blockedReason`: cost unavailable / floor violation) — never silently priced from nothing.
- **`materializePrice`** — THE transactional write shared by bulk, proposals and the sweep: variant price update (LAN-sync trigger watermark respected) + `product_price_history` row (source-tagged, cost snapshotted, actor recorded) + in-transaction audit. Every path funnels through it; no side door writes prices.

### Bulk update (Part 8 of the master prompt)
- `POST /api/pricing/bulk` (`pricing.bulk_update`) — filter by `variantIds` / `categoryIds` / `productIds` / name `search` (≤ 500 variants per run); `dryRun: true` returns per-variant rows `{currentPrice, recommended, changed, cost, method, sourceLabel, blockedReason}`; `dryRun: false` materializes each unblocked change (source `bulk`, optional reason) inside one transaction, skips blocked rows with reasons, and audits `pricing.bulk_update` with counts.

### Mode A — proposals (the DEFAULT update mode)
- `POST /api/pricing/proposals/generate` (`pricing.manage`): scans every variant an ACTIVE rule can reach — variant/product scopes directly, **category scopes via a recursive subtree walk (matching the resolution precedence)**, global rule → whole catalog (capped 1000) — under a per-business `pg_advisory_xact_lock` so concurrent sweeps cannot double-create. A variant's pending proposals that no longer match the fresh recommendation are marked **stale**; a matching pending proposal is left alone (idempotent re-runs); otherwise a new `pending` row is created with `batchToken`, old/new cost, old price, recommended price and percentChange.
- `GET /api/pricing/proposals?status=&page=&pageSize=` (`pricing.history.view`) — `{rows, meta}` with product labels.
- `POST /api/pricing/proposals/:id/(approve|reject)` + `POST /api/pricing/proposals/bulk-approve` (`pricing.product.manage` — decisions write prices): approve RECOMPUTES the recommendation first; if it moved, the proposal is marked stale and a 409 asks for regeneration (a stale proposal can never write an out-of-date price). Approval materializes with source `proposal` + `proposal_id` and flips the row to `applied`. Bulk-approve collects per-row failures instead of failing the batch.

### Mode B — auto-update sweep (opt-in)
- `POST /api/pricing/auto-update/run` (`pricing.manage`): refuses unless `pricing_settings.auto_update_enabled`; takes a per-business `pg_try_advisory_xact_lock` — a second concurrent sweep is REJECTED (409), not queued (audit §12.8). Applies recommendation changes for rule-covered variants with history source `auto_update`; **fixed-price protection**: rows whose source is a `fixed` rule are skipped unless `auto_update_fixed_prices` is enabled; floor-violating rows are skipped with explicit reasons; audit `pricing.auto_update.run` with counts.

### Frontend
- **Proposals page** (`/pricing/proposals`, `pricing.history.view`): generate button, status tabs (pending/approved/rejected/applied/stale), approve/reject per row, select-all + bulk approve, Mode B toggle + run button (disabled until the setting is on).
- **Bulk Update page** (`/pricing/bulk`, `pricing.bulk_update`): filter form → preview table (per-row blocked reasons, cost behind `products.view_cost`) → apply with confirmation; reason recorded.

## Files changed

**New:** `src/modules/pricing/pricing.apply.service.ts`, `src/test/pricingApply.integration.test.ts`, `pos/src/features/pricing/pages/{PriceProposalsPage,BulkUpdatePage}.tsx`.
**Modified:** `pricing.validation.ts` (+bulk/proposal schemas), `pricing.controller.ts` (+6 handlers), `pricing.routes.ts` (+6 routes), `pos/src/features/pricing/pricing.{api,types}.ts` + `hooks/usePricing.ts`, `pricing.wiring.test.ts`.

## Database changes

None (`price_change_proposals` + `product_price_history` landed in 0063).

## API changes

| Method/Path | Permission |
|---|---|
| `POST /api/pricing/bulk` | `pricing.bulk_update` |
| `GET /api/pricing/proposals` | `pricing.history.view` |
| `POST /api/pricing/proposals/generate` | `pricing.manage` |
| `POST /api/pricing/proposals/:id/:decision`, `/bulk-approve` | `pricing.product.manage` |
| `POST /api/pricing/auto-update/run` | `pricing.manage` |

## Tests & results

- `pricingApply.integration.test.ts` (6 cases): bulk dryRun→apply (60 from markup-20 over cost 50, cost-unavailable row blocked, history row source `bulk` with reason); proposal generation across rule scopes (variant + category-subtree + global + fixed in one sweep, exactly the moved recommendation created), approve → materialization (source `proposal`, `proposal_id` linked, double-decide 409); recommendation move → old pending staled + fresh pending created; auto-update gate (409 disabled), sweep applies only the moved variant, fixed-price protection skip, fixed-protection opt-in applies, floor-violating recommendation blocked without a write; permission matrix (view-only role: proposals readable, bulk/generate/decide 403); tenant isolation (no rules → nothing generated; foreign variant bulk → empty rows). **Status: written, self-skip green; needs `INTEGRATION_TESTS=1` + reachable `ezpos_test` to execute.**
- Backend `tsc --noEmit` clean; full unit suite **197 pass / 0 fail / 1 skipped** (pre-existing backups-pipeline conditional); POS `vite build` green; POS vitest 265 pass + 4 pre-existing `terminalBinding` failures (verified pre-existing on the clean Phase-4 tree via `git stash`).

## Known limitations

1. **Integration execution blocker (environment):** `ezPosBackend/.env`'s `DATABASE_URL` fails with `password authentication failed for user "user"` on the local Postgres, so the four new integration suites (`pricingPromotions`, `pricingOverride`, `pricingReports`, `pricingApply`) were written, compile clean and self-skip green, but have NOT yet been executed against `ezpos_test`. They run with `INTEGRATION_TESTS=1 DATABASE_URL=postgres://…/ezpos_test npm test` once credentials are fixed. Until then the phase gates rest on: engine/evaluator unit tests, `tsc`, the full unit suite, and both builds.
2. The proposal scan caps at 1000 variants per run (large catalogs sweep in batches across runs).
3. `percentChange` is informational (price-based); the stale check compares the recomputed RECOMMENDED PRICE, so a cost-only change that leaves the recommendation unchanged is a no-op by design.
4. Mode B dedupe is per-process-lock in-transaction (`pg_try_advisory_xact_lock`) — multi-instance deployments are safe per database, but the sweep is not a scheduled job yet; it runs on demand (or via a future cron).
