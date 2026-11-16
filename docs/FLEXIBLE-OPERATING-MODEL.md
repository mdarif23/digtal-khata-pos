# Flexible Business Operating Model

*Status: implemented 2026-11-16 (Phases 1–6) on `flexible-business-operating-model`. Architecture
audit: Stage 1 + Stage 2 report (this session's starting point); owner approved all
recommendations (E1–E10, D1).*

**One business account. Any sales channel. Expand anytime. No forced physical store. No forced
online store. Shared business intelligence. Secure employee management. Unified inventory and
financial management.**

## The model

Three operating models, all on the same schema and the same business account:

| Model | `businesses.mode` | What is active |
|---|---|---|
| Physical-only | `physical_only` (default) | POS counter, registers, drawers, terminals, offline LAN |
| Online-only | `online_only` | Online orders, WooCommerce, storefronts — **no register or counter required** |
| Omnichannel | `omnichannel` | Both, on shared inventory |

The mode is **configuration, not a permanent classification**. Switching never migrates data,
never duplicates anything, and never resets a subscription or trial.

## The three capability layers (never merged)

1. **Subscription entitlements** — what the plan permits: `subscription_plans.features` /
   `limits` JSONB, enforced server-side (`services/entitlements.ts`,
   `middleware/entitlements.ts` → 403 `FEATURE_NOT_IN_PLAN` + `upgradePlans`).
2. **Business operational configuration** — what the business activated: `businesses.mode`
   (`commerceEnums.ts`), gated by `requireBusinessMode` / `requireBusinessModePortal` /
   `requireSurfaceModes` middleware.
3. **User permissions** — what a person may do: 161-key RBAC catalog
   (`rbac/permissions.ts`), `user_roles` union + `user_location_assignments`
   ("what vs where" are separate axes), re-read from the DB on **every** request.

## Locations are stock sources, not stores

Inventory lives at `locations` — one row per (business, variant, location). A location is where
stock lives, whatever the channel. There is **no fake retail store**:

- Creating a business with an online-capable mode (or switching to one with zero locations)
  provisions a single stock source — a **warehouse-typed** "Online Store" for `online_only`,
  a store-typed one for `omnichannel` (`businesses.service.ts`). Idempotent; never duplicates.
- `requireOptionalLocation` (`middleware/location.ts`) lets location-free surfaces (the
  dashboard) work even with zero locations; `requireLocationAccess` still 400s surfaces that
  physically cannot work without one.
- A channel is not a location: channels attach to locations via `integrations.locationId`
  (per-channel fulfillment source) and draw from the **one** inventory engine — reservations
  (`inventory_reservations` + `reserved_quantity`), channel allocations
  (`channel_inventory_allocations` shared/reserved), FEFO/FIFO batches.

## Physical surfaces are API-enforced

Mode gating is not nav cosmetics. For an `online_only` business, direct API calls to
counter-sale surfaces return **403 `SURFACE_NOT_ACTIVE`**: `POST /api/sales`, cash registers,
held carts, speed keys, offline terminals, POS terminals. Refund/exchange/list routes stay
mode-neutral (online refunds flow through the same endpoints).

## Online order operations

- Unified orders table: online orders are `sales` rows with `channel ≠ pos/offline`.
- Assignment (migration 0088): `sales.assigned_to_user_id / assigned_at / assigned_by_user_id`
  (nullable = unassigned). Routes `POST/DELETE /orders/:id/assign` (permission `orders.assign`,
  new key, manager template includes it for **new** businesses — existing businesses' roles are
  untouched by decision E7). Assignee must be an active member. Every change writes an
  append-only `sale_order_events` event (`assigned` / `reassigned` / `unassigned`).
- Summary gains `unassignedCount` (open, completed-not-final orders with no owner); list gains
  `assignee=me|unassigned|<id>` ("me" resolves server-side).
- Failed delivery: `POST /orders/:id/delivery-failed` → shipment `failed` (money/stock
  untouched); redelivery = `PATCH /shipment` + `deliver`, or a return. Full history in
  `sale_order_events`.

## Finance: one ledger, channel-attributed

Online orders post to the **same double-entry GL** as POS (Phase 4):

- **Confirm** → the standard sale entry (4010 revenue / 2020 VAT / 4030 delivery income /
  5010 COGS / 1050 inventory). Money side: recorded payment rows debit cash **net of gateway
  fees** (fee → 5080); the COD residual debits 1040 receivable.
- **COD collection at delivery** → `sale_due_collection` entry (cash net of fee + 5080 fee +
  1040 settlement).
- Idempotent per source row via the ledger gateway; **no-op before Finance activation**;
  forward-only from cutover (decision E3 — no historical backfill). The reconciliation report's
  **revenue check** (GL 4010 vs operational Σ(final_total − vat − delivery_fee)) quantifies the
  pre-cutover online margin.
- Online profitability counts only real online channels (`woocommerce` + `custom_storefront`) —
  LAN `offline` replays are excluded.
- Channel attribution on journal lines stays join-based (sourceId → sales.channel); no schema
  change.

## Plan entitlement changes (E6)

- `exports` — **now enforced** on the exports router; every seeded plan carries it (seed
  updated), so only plans that deliberately omit it are gated.
- `storefrontAnalytics` — **now wired**: enabling a storefront's analytics beacon requires the
  plan flag.
- `multipleOnlineStores` — **dropped** (redundant with `maxStorefronts` / `maxConnectedStores`).
- `purchaseManagement` — intentionally still unenforced: it would need a product decision on
  *which* purchase capabilities it gates (gating all purchasing would lock trials out of core
  workflows).

## Business Operations UX

- **Signup** (website): "How will you sell?" — physical / online / both, changeable anytime.
- **Onboarding** (website): the location step speaks "stock source" for online-only businesses.
- **Settings → Business Operations**: POS (`/settings/business-operations`) and website
  (`/account/business-operations`) — mode switcher + per-channel readiness snapshot
  (`GET /api/businesses/:id/operations`). The mode switch is the dedicated
  `PATCH /api/businesses/:id/mode` route, **deliberately reachable while the subscription is
  read-only** (E4 — configuration, not data).
- **Security fix**: `PUT /api/businesses/:id` now requires `settings.edit` (previously any
  active member could edit the profile and flip the mode).
- **Mode-aware POS**: the session carries the business mode; navigation and route guards
  (`RequireMode`) hide POS/register/hardware surfaces for online-only businesses and online
  surfaces for physical-only ones; the dashboard gains a **Channel mix** card (consolidated
  owner view, reusing the channel-performance report).
- **SaaS admin**: the businesses list shows each tenant's mode and trade type.

## Migration

- `0088_online_order_assignment.sql` — additive; nullable columns; no backfill; rollback
  documented in-file. Apply with `node scripts/apply-migration.mjs
  drizzle/0088_online_order_assignment.sql --both` (requires the usual env).

## Scenario coverage (master prompt Part 13)

| Scenario | Where |
|---|---|
| A — online-only, zero physical store | `businessOperations.integration.test.ts` (auto-provisioned warehouse stock source, readiness flags), `orderAssignment`, `commerce` |
| B — physical-only | all pre-existing POS suites (mode default unchanged) |
| C/D — transitions | `PATCH /mode` tests incl. integration-block downgrade + idempotent provisioning |
| E — omnichannel + concurrency | `commerce` (reservations vs confirm), `batchFefo`, `crossMode` |

Integration suites require `INTEGRATION_TESTS=1` + `DATABASE_URL` at `ezpos_test`
(`ezPosBackend/.env`).

## Deliberately deferred (documented, not forgotten)

- `purchaseManagement` enforcement (needs route-level product decision).
- Delayed-order SLA detection (no SLA definition exists yet).
- Courier settlements / COD remittance ledger (D2 — approved as deferred).
- Dropshipping (explicitly future), weight-selling online (integer quantities today),
  marketplace-commission input (column exists, no writer), historical GL backfill (E3: no).
