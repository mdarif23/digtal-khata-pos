# ezPos P3 Advanced Features — Phase 2 Report

**Phase:** 2 — Batch management and FEFO at the POS register
**Date:** 2026-11-14
**Branch:** `feature/add-feature` · **Commit:** (filled at commit) · **Pushed:** no
**Approved plan:** `P3_ADVANCED_FEATURES_PLAN.md` (D7–D10 approved via "Phase 2"; recommendations implemented: D7 expired-batch policy `block` default / `allow_with_approval` via manager-approval op `sale.expired_batch`, D8 FEFO in sales + transfers, D9 partial manual selection rejected, D10 offline batches allowed with cached truth and a new `expired_batch_selected` conflict)

## 1. Implemented functionality

### F.1 Batch picker (POS)
- `GET /api/variants/:variantId/batches` — the serial endpoint's exact access model (`requireAnyPermission(["pos.create_sale","inventory.view"])`), **location-scoped**, FEFO-ordered (`expiry ASC NULLS LAST, id`), only `quantityRemaining > 0`, with `expiryStatus: valid | expiring_soon | expired | no_expiry`. Under the default `'block'` policy expired batches are hidden; under `'allow_with_approval'` they surface flagged.
- `BatchPickerDialog.tsx` — the serial picker's UX, single-select per line, status badges, a "Use FEFO" reset; offline it reads the catalog cache (D10).

### F.2 Sale payload + backend processing
- Sale item payloads (create + quote) accept `batchId?: number` — passthrough through the UOM boundary (`normalizeSaleItemsToBase`), read from the DB context (`trackingType`), never trusted beyond ownership validation.
- createSale pre-check inside the transaction: batch belongs to variant + business + **location** (cross-location access impossible); composite (BOM) and serial-tracked lines reject batch selection explicitly.
- Manual selection takes **precedence** over FEFO; online partial coverage is REJECTED with the exact figures ("Batch B-30D has 2 of the 10 unit(s) requested…") — no silent FEFO top-up (D9). Offline-originated sales (physically happened) flow shortfalls through the existing `batch_shortfall` conflict machinery.

### F.3 FEFO default consumption
- `consumeStockFifo` ordering: `expiry_date ASC NULLS LAST, id ASC` — earliest valid expiry first, never-expiring last, FIFO tiebreak. **Expired batches are excluded from automatic consumption entirely under both policies** — an expired batch can never be silently sold.
- Expiry comparisons are **DB-side** (`expiry_date >= CURRENT_DATE` — session TZ pinned to UTC like every report query). A JS local-midnight boundary shifts a day when serialized (Dhaka +6) and silently admitted yesterday's expired batches — caught by the acceptance tests and fixed (documented in §7).
- `consumeStockFifoAtLocation` (stock transfers) gets the same ordering + exclusion (D8) — shipping expired stock to another location can no longer launder it into sellable stock there.
- `consumeSerials` untouched — serial behavior intact (regression-verified).
- Non-batch products: degenerate NULL-expiry ordering (id-order preserved) — behavior identical (regression-verified).

### F.4 Expired-batch policy (D7)
- `pos_settings.expired_batch_policy VARCHAR(20) DEFAULT 'block'` CHECK in (`block`,`allow_with_approval`) + `expiry_warning_days INTEGER DEFAULT 7` (migration 0085). PATCH /api/pos-settings accepts both.
- `'block'`: expired batches hidden in the picker, rejected for manual selection (`ExpiredBatchError`, 409).
- `'allow_with_approval'`: expired selection demands a one-time manager approval — new op **`sale.expired_batch`** registered in `APPROVAL_OPS` with authority `inventory.adjust` (PIN → token → consumed in-tx; a rolled-back sale does not burn the token; a replayed token is 409). The op is deliberately **not** in `approval_required` — the policy column itself mandates the approval; no new permission, no new config knob.
- Audit: `sale.create` metadata records `expiredBatchApprovedBy`.

### F.5 Expiry notifications
- `sweepExpiringInventory` now applies the business's own `expiry_warning_days` window (LEFT JOIN pos_settings, default 7 — previously fixed 7) and adds an **expired** sweep: batches with `expiry < CURRENT_DATE` and stock remaining raise `expired_inventory` notifications (critical severity, dedupe `expired:<batchId>`, business/location payload). No real customer messages — in-app notification center only.

### F.6 Returns, exchanges and provenance
- Returns now restore the **ORIGINAL batches** from `sale_item_batch_consumptions` instead of fabricating a `RETURN-…` batch:
  - Quantity lines: allocation across consumed lots, **history-aware** — prior restorations (summed from this sale's `return` movements per batch) cap each lot's remaining-out, so successive partial refunds never over-restore the largest lot (a real bug the acceptance tests caught and fixed).
  - Serial lines: serials keep their sale-time batch (`consumeSerials` never clears it) — grouped by original batch, capped by remaining-out; orphans (null batchId) fall back.
  - `RETURN-…` batch survives **only as the fallback** when provenance is incomplete (legacy rows / deleted batch) — a refund never fails on incomplete provenance.
  - Movements ledger: one `return` row per restored batch with the actual restored quantity.
- Exchanges inherit both sides automatically (refund side = provenance restore; replacement side = FEFO consumption).
- Phase 3 void-readiness: the same provenance machinery is what void will replay.

### F.7 Offline (D10)
- Batch snapshots cached at allowance-refresh time (`offlineStore.refreshGrants` fetches `variants/:id/batches` for batch-tracked variants → IndexedDB `scopeKey("batches")`).
- Offline add-to-cart for a batch-tracked variant **requires** cached batch rows (blocked otherwise, mirroring the serial hard block); the FEFO-first cached batch auto-attaches; the cart-line picker reads the cache offline.
- Sync: `createSale` re-validates ownership/availability/policy; an expired selection that the live policy rejects fails the op and writes a **`expired_batch_selected`** sync-conflict (new `OfflineConflictReason`) — the sale is NOT applied (expired stock is never sold silently, offline included). Shortfalls still surface as `batch_shortfall`.

## 2. Database changes
| Migration | Content | Rollback (in-file) |
|---|---|---|
| 0085_pos_batch_policy | `pos_settings.expired_batch_policy` (default 'block', CHECK) + `expiry_warning_days` (default 7) | drop columns |

`ezpos_test` at **86/86**. No backfill needed. Next migration: 0086.

## 3. API changes
- New: `GET /api/variants/:variantId/batches` (permission `pos.create_sale` **or** `inventory.view`).
- Extended: create/quote sale items accept `batchId`; `PATCH /api/pos-settings` accepts `expiredBatchPolicy` + `expiryWarningDays`.
- No permission catalog changes (picker reuses the serial endpoint's pair; approval authority reuses `inventory.adjust`).

## 4. Frontend changes
- `BatchPickerDialog.tsx` (new); cart line "Batch: <no.>/FEFO" chip + picker for batch-tracked lines (`CartItems.tsx`); cart store `setLineBatch` + `batchId/batchNumber` on cart/hold/resume types; checkout payload + quote payload carry `batchId`; offline batch cache (`catalog.ts`) + gates (`ProductList.tsx` scan & click paths) + offline picker reads; allowances refresh caches batch snapshots (`offlineStore.ts`).

## 5. Test evidence (actually executed 2026-11-14)
`batchFefo.integration.test.ts` — **11/11 pass**, covering the full §F.8 matrix:
picker FEFO order + expired hidden; FEFO consumption (earliest expiry first, expired batch with the LOWEST id untouched — proves ordering is expiry-driven); manual selection honored; D9 rejection with exact message; expired blocked under 'block'; 'allow_with_approval' → 403 without token → PIN → token → sale consumes the expired batch → replayed token 409; partial return restores original lots (+3 to B-10D, RETURN- count 0) and full return completes restoration; two concurrent manual sales of one batch → exactly one 201 + one 409; offline expired selection → op failed + `expired_batch_selected` conflict + zero sales applied; non-batch product unchanged; transfer ships FEFO from B-10D and never touches the expired batch.

## 6. Regression + gates
- Adjacent suites: offlineTerminal/offlineReplay/exchanges/stockTransfers **31/31**; phase1Operational/cashRegisters/payments + all four Phase-1 suites **50/50**.
- Full backend suite: **1067/1068 pass** as recorded — the single failure (`phase2Comms` auto-receipt test, "exactly one receipt" expected 1 got 0) **passes 7/7 standalone**: parallel-suite interference on the shared `ezpos_test` database, classified per the prompt's §3.5 protocol (re-run standalone → interference confirmed, not a defect). The count reconciles exactly: 1057 (Phase-1-complete equivalent) + 11 new = 1068.
- Frontend: app-config `tsc` **119 = 119 baseline (zero new)**; production build **pass**; vitest **288/288 pass** — one suite file (`CartItemDiscount`) hit a vite-transform worker timeout in the full parallel run and passes standalone (6/6), the same environment-sensitivity documented in Phase 1.

## 7. Bugs found and fixed during acceptance testing (worth remembering)
1. **Timezone boundary**: expiry exclusion via a JS local-midnight Date serialized to the previous UTC day (host TZ = Asia/Dhaka; pool pins session TZ to UTC) — expired batches were admitted. Fixed with DB-side `expiry_date >= CURRENT_DATE`.
2. **Multi-refund allocation**: greedy largest-first allocation didn't track prior partial restorations — the second refund over-restored the largest lot. Fixed with history-aware remaining-out caps from the movements ledger.
3. **ReferenceError after refactor**: a removed `today` declaration left the manual-miss path throwing a 500 under concurrency. Fixed + covered by the concurrent test.

## 8. Remaining / deferred
- Image-based ESC/POS, batch-wise pricing (batch cost already flows via `costAtSale`), and batch selection for composite/BOM lines (rejected explicitly) are out of Phase 2 scope.
- The batch picker's cached snapshot is refreshed on the allowances cadence — long offline periods may hold stale quantities; sync-time revalidation + conflicts are the safety net (per D10).
- Phase 3 (sale void) is next; it consumes the same provenance machinery and needs decisions D11–D12 approvals.

## 9. Git / safety
- One focused local commit; no push, no remote/history changes; migrations applied to `ezpos_test` only after in-memory target verification; `cj-tmp.txt` (absent here) untouched; no `.env` values printed.
