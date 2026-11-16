# ezPos P3 Advanced Features — Phase 3 Report

**Phase:** 3 — Sale void with batch-aware restoration (audit finding E1-003)
**Date:** 2026-11-15
**Branch:** `feature/add-feature` · **Commit:** final hash in `git log` (this report ships inside the same amended commit) · **Pushed:** no
**Approved plan:** `P3_ADVANCED_FEATURES_PLAN.md` §G (D11 implemented as recommended: `completed`-only, zero prior refunds, reason mandatory, approval via the existing `sale_cancel` gate)

## 1. Implemented functionality

### Permission (G.1)
- New **`sales.void`** added to the backend catalog + the `pos/src/lib/rbac.ts` mirror + `DEFAULT_ROLE_PERMISSIONS.manager` (NOT cashier). Enforced by `requirePermission("sales.void")` on the route — UI visibility is not authorization.
- `POST /api/sales/:id/cancel` body `{ reason: string(3..500), approvalToken? }` — route stack `write` + `requirePermission("sales.void")`.

### Business rules (G.2, D11)
- Locks the sale row `FOR UPDATE` (business-scoped): simultaneous duplicate voids serialize — the loser gets 409, never a double void (tested with concurrent requests).
- Only `status = "completed"`; **zero prior refunds** (the refund check runs BEFORE the status check so a refunded sale gets the actionable "has refunds — use returns instead" message).
- Same-business + same-location enforced.
- Approval: `isApprovalRequired(businessId, "sale.cancel")` reads the **pre-existing `approval_required.sale_cancel`** config key (0086-era type anticipated it); the op is registered in `APPROVAL_OPS` with authority `sales.void`; token consumed in-tx (rollback does not burn it).
- Mandatory reason + actor + timestamp on new columns `sales.cancel_reason / cancelled_by_user_id / cancelled_at` (0086). Status → the existing `cancelled` enum value. **The invoice number is never released** — its per-business unique index keeps it reserved; the row stays fully auditable.

### Atomic reversal (G.3) — one transaction, every reversal exactly once
1. **Inventory**: replays `sale_item_batch_consumptions` → restores every consumed ORIGINAL batch in full (Phase 2's provenance machinery; the zero-refunds rule means all lots are outstanding); `inventory_stock` incremented per variant; `inventory_movements` rows (`return` / `sale_cancel` / saleId) per restored batch; a `VOID-<saleId>` fallback batch only when provenance is incomplete (consistent with the Phase 2 refund fallback).
2. **Serials**: `sold` → `in_stock` at their sale-time batch.
3. **Drawer**: the sale's total cash leaves the open session — `recordSaleVoidCashOutInTx` (`cash_out` / `sale_cancel` / saleId), reference-unique index idempotent, no-session = GL-only reversal (honest, mirroring refunds).
4. **Loyalty**: earned points reversed on the PAID portion (`reverseLoyaltyPointsInTx`); redeemed points restored in full (`restoreRedeemedPointsInTx`, refundId = saleId — exactly once because the void is once-only).
5. **Instrument ledgers — append-only reversal, never deletion**: gift-card redemptions (`gift_card_transactions` redeem rows keyed by saleId) are countered with positive **`void_restore`** rows; store-credit spends (`customer_credits`) likewise. Both CHECK constraints extended (0086). Balances restore exactly.
6. **Commissions**: pending entries reversed at 100% (mirrors the refund engine's pattern; `refundId = saleId` under the 0077 reversal-unique index; reason "Sale voided").
7. **Coupon usage**: the sale's `coupon_redemptions` row deleted AND the denormalized `coupons.used_count` decremented — `evaluateCouponInTx` limits on `used_count`, so usage applies again (tested).
8. **Promotion usage**: the sale's `promotion_usage` rows deleted (counter release).
9. **Warranties**: `voidWarrantiesForSale` with reason `sale_void:<saleId>` (the function gained an optional reason override).
10. **Finance journal**: the sale's posted entry reversed via the tested **`reverseEntry`** primitive — original marked `reversed`, mirrored reversal entry, duplicates blocked. No silent deletion.
11. Audit `sale.void` + realtime `stock.changed` signal for other registers.

### Reports (G.4) — verified no metric changes needed
Every revenue/performance predicate already filters `completed`/`refunded` (exhaustive plan §G.4 enumeration). The ONLY change: `getSalesData` (the sales list / customer history) now includes `cancelled` rows so voided invoices remain visible in the UI — metrics queries untouched. The due-management guard already rejects cancelled sales.

## 2. Database changes
| Migration | Content | Rollback (in-file) |
|---|---|---|
| 0086_sale_void | `sales.cancel_reason / cancelled_by_user_id / cancelled_at`; `gift_card_transactions` + `customer_credits` CHECKs gain `'void_restore'` | NULL-out, drop columns; CHECK restores fail if void_restore rows exist |

`ezpos_test` at **87/87**. No backfill. Next migration: 0087.

## 3. API / permission changes
- New: `POST /api/sales/:id/cancel` (`sales.void`).
- New permission `sales.void` (backend catalog + frontend mirror + manager template — same commit).
- `approval_required.sale_cancel` is now fully wired (config zod + sanitizer key + `CONFIG_KEY_BY_OP` entry — the key existed in the type since Phase 1 of the earlier program).

## 4. Frontend changes
- Sales page: **Void sale** button (only `sales.void` holders, only `completed` sales), mandatory-reason dialog, `ManagerApprovalDialog` reuse on 403 (`sale.cancel` op → token → retry), success toast + list refresh.
- Sales list: **Voided** badge on cancelled rows (history visible; metrics unchanged).
- `sales.api.ts`: `voidSaleApi`.

## 5. Test evidence (actually executed 2026-11-15)
`saleVoid.integration.test.ts` — **10/10 pass**, covering §G.5: cashier without `sales.void` → 403; atomic cash-sale void (stock exact, movements once, drawer `cash_out` 40 ৳ once, journal entry `reversed` + reversal, invoice preserved, reason recorded, audit row, cancelled row visible in the sales list); double void 409 with zero extra movements; **concurrent voids → exactly one 200 + one 409**; batch-tracked void restores original lots on top of pre-void remaining; serial void returns serials to `in_stock`; loyalty earn reversed (−100) + 20 redeemed points restored with `void_restore` gift-card rows restoring the 100 ৳ balance exactly; coupon usage released (limit-1 coupon works again after void); eligibility guards (refunded sale → "has refunds" 409, missing sale 404, short reason 400); `approval_required.sale_cancel` → 403 without token → PIN → token → 200.

## 6. Gates
| Gate | Result |
|---|---|
| Backend `tsc --noEmit` | clean |
| Full backend suite | **1077/1078 pass** — the single failure (`expensesPhase6` budget scope test) **fails identically with the Phase 3 working tree stashed** (verified at the clean Phase-2 HEAD): pre-existing on this tree, unrelated to void. Count reconciles exactly: 1068 + 10 new = 1078 |
| Frontend `tsc` (app config) | **119 = 119 baseline (zero new; Sales.tsx diagnostics verified pre-existing via HEAD worktree)** |
| Frontend production build | pass |
| Frontend vitest (serial) | **294/294** |

## 7. Remaining / deferred
- Void of online-channel sales: allowed only for `completed` with zero refunds (channel not gated — online `completed` sales void the same way; `fulfillmentStatus` untouched, flagged as a deliberate v1 simplification).
- Payment-intent/gateway money for captured online payments is not auto-refunded by void (manual provider payout per existing policy) — documented, not silently altered.
- Phase 4 (receipt share/PDF, USB Unicode, multi-display CFD) is next; decision D12 covers the receipt-share design.

## 8. Git / safety
- One focused local commit; no push, no remote/history changes; migrations applied to `ezpos_test` only after in-memory target verification; `cj-tmp.txt` untouched; no `.env` values printed.
