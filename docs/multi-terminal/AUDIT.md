# ezPos Phase A — Read-Only Audit (Multi-Terminal / Cloud / LAN / Offline Program)

Branch: `featue/multi-terminal-cloud-lan-offline-sync` (typo in the name; harmless, kept)
Tip audited: `50e9efc` (merge of PR #61, barcode scanning) — identical to the `development` tip at audit time.
Date: 2026-11-06. Method: six parallel read-only audit passes (auth/tenancy, database, sales+inventory lifecycle, realtime/registers/numbering, frontend, deployment/infrastructure). **Zero source files modified, zero migrations, zero DB writes.** This document is the audit deliverable; the accompanying `ARCHITECTURE.md` holds the proposal. All evidence is `file:line` on the audited tip.

Abbreviations: `BE` = `ezPosBackend/`, `FE` = `pos/`, `BR` = `ezPosHardwareBridge/`.

---

## A1. Authentication & authorization

**Verified solid (do not re-audit):**
- Access token: JWT (jose, HS256), claims only `typ:"access"` + `sub` — `BE/src/modules/auth/auth.service.ts:79-86`; TTL 15 min (`BE/src/config/env.ts:45`). Verified per request against the DB; **inactive users are rejected immediately**, not at token expiry (`BE/src/middleware/auth.ts:51-65`).
- Refresh: opaque 32-byte token, SHA-256 hashed in `refresh_tokens` (unique `token_hash`, `expires_at`, `revoked_at`, `user_agent`, `ip_address` — `BE/src/db/schema/refreshTokens.ts:11-28`). Single-use rotation with atomic conditional claim + 30 s reuse grace; **reuse of a rotated token outside grace revokes ALL of the user's refresh tokens** (`BE/src/modules/auth/auth.service.ts:434-508`). Cookie `ezpos_refresh_token`: httpOnly, `secure` in prod, sameSite lax, path `/api/auth` (`BE/src/modules/auth/auth.controller.ts:40-48`).
- Revocation on password change/reset: yes (self-service and forgot-password flows both revoke all refresh tokens, `auth.service.ts:751-765, 331-339`).

**Tenancy resolution — headers are hints, never proof:**
- Business: `X-Business-Id` header → `requireBusinessContext()` loads the ACTIVE `business_memberships` row for `(userId, businessId)`; no membership → 403 indistinguishable from nonexistence; suspended business → 403 `BUSINESS_SUSPENDED` (`BE/src/middleware/business.ts:171-202, 49-87`).
- Location: `X-Location-Id` header → `requireLocationAccess()`/`resolveRequestLocation` validates the location belongs to the business and is active; non-owners must hold a `user_location_assignments` row or get 403; owners (wildcard `*`) bypass (`BE/src/middleware/location.ts:34-166`).
- Permissions: ~90-key `PERMISSION_CATALOG` (`BE/src/rbac/permissions.ts:18-164`), wildcard owner, `requirePermission/requireAnyPermission/requireAllPermissions` (`BE/src/middleware/permissions.ts`); **permissions re-read from DB on every request** (`BE/src/middleware/business.ts:36-38, 93-117`). Subscription write-gating via `requireFullAccess` → 403 `TRIAL_EXPIRED`/`SUBSCRIPTION_REQUIRED` (`business.ts:242-268`).
- Multi-role: `business_memberships` (one primary role) + `user_roles` extras; effective permissions are the union (`business.ts:93-117`).

**Terminal identity — the Phase-1 foundation already exists (from the cash-management program, PR #55):**
- `pos_terminals`: business+location scoped (NOT NULL `location_id`, composite FK `(location_id, business_id)`), `status` active/inactive, SHA-256 `secret_hash`, `device_info` jsonb, `last_seen_at` (`BE/src/db/schema/posTerminals.ts:51-86`).
- `requireTerminalAuth()`: `Bearer ezpos_tb_<secret>` + `X-Terminal-Id`, timing-safe hash compare, requires `status==="active"`, **updates `last_seen_at` as a heartbeat on every authenticated request**, attaches `req.terminal = {terminalId, businessId, locationId, name}` — business/location come from the terminal row, never client headers (`BE/src/middleware/terminalAuth.ts:62-120`).
- Admin surface already exists: `/api/terminals*` with `pos_terminal.view`/`pos_terminal.manage`, pairing via one-time hashed codes (10-min, single-use), secret rotation, audit events (`pos_terminal.paired|updated|deleted|secret_rotated`) — `BE/src/modules/hardware/terminals.routes.ts`, `terminals.service.ts:60-73,127-359`.
- **Critical scope limitation: `requireTerminalAuth` is used ONLY by hardware-bridge routes** (`BE/src/modules/hardware/bridge.routes.ts:18`). No POS/business route consumes terminal identity. There is **no terminal claim in user JWTs, no `X-Terminal-Id` anywhere in the FE API client** (grep verified), and **no terminal column on `sales`, `register_sessions`, or any financial table**. A "revoked" terminal today only stops the hardware bridge — the browser on that PC keeps selling under the user's token.

**Gaps / risks found:**
- **A1-G1:** No terminal enforcement or attribution on POS routes (above) — the core Phase-1 work.
- **A1-G2 (security):** admin password reset (`users.service.ts:378-397`) does NOT revoke refresh tokens — a revoked user with a known password stays logged in until token TTL. Self-service reset does revoke.
- **A1-G3:** No "active sessions"/device list UI; `refresh_tokens.last_used_at` is never written; no expired-token sweep job.
- **A1-G4:** All rate limiting is in-memory single-instance (`BE/src/middleware/rateLimit.ts:10-12`); `AUTH_RATE_LIMIT_MAX` default 20/15 min.
- **A1-G5 (carried from prior program, still open):** `AUTH_JWT_SECRET` was committed to git history; rotation still pending on the user's checklist.

## A2. Database architecture

49 migrations (`0000` … `0048_backup_restore`), hand-assigned monotonic `when` values; latest `when` = 1794200000000 (`BE/drizzle/meta/_journal.json`). Runner caveat: `drizzle-kit migrate` has a documented silent no-op failure mode — `BE/scripts/apply-migration.mjs:1-14` is the reliable path. Only 15 drizzle snapshots exist; most migrations are hand-authored SQL. **Next migration number: 0049** (0044/0045 landed-cost, 0046 barcode, 0047 product-import, 0048 backup-restore).

**Schema domains (all under `BE/src/db/schema/`):** users/business/memberships/locations/roles/assignments; products/variants/barcodes/categories/brands/units/variant options-values-images/product_taxes/tax_rates; customers/customer_credits ledger; suppliers/supplier_ledger; sales/sale_items/sale_payments/sale_payment_intents/sale_refunds(+items)/sale_item_batch_consumptions/held_sales/coupons/loyalty/gift_cards; purchases(+items,+payments,+returns)/landed_costs (6 tables); inventory_stock/inventory_movements/inventory_batches/serial_numbers/inventory_reservations/stock_transfers(+items)/stock_count_sessions(+lines)/channel_inventory_allocations; registers/register_sessions/register_transactions; pos_terminals/terminal_pairing_codes/hardware_commands; expenses (6 tables); integrations (6 tables)/webhooks; backups (3 tables); storefront (10 tables); notifications(+reads,+prefs); audit_log; document_sequences/document_settings; subscriptions/plans/payments/invoices/events.

**What already supports multi-terminal/sync (verified present):**
- `sales.idempotency_key` varchar(120), DB constraint **UNIQUE(business_id, idempotency_key)** (migration `0015_sale_idempotency_business_scope.sql`) with replay semantics — see A3. Proven for offline replay by `BE/src/test/offlineReplay.integration.test.ts`.
- `sale_payment_intents.idempotency_key` unique per business (`salePaymentIntents.ts:54,67-70`); `online_order_payments.idempotency_key` unique; `inventory_reservations.idempotency_key` unique; `register_transactions` partial-unique idempotency `(business_id, reference_type, reference_id) WHERE … AND type<>'manual'` (migration 0042).
- `sales.channel` (pos/woocommerce/custom_storefront), `external_order_id/number` — a channel-origin pattern exists to extend.
- `document_sequences` per-business numbering, atomic (`BE/src/db/schema/documentSequences.ts:4-20`).
- `pos_terminals` registry w/ location scoping + heartbeat (A1).
- Per-location stock rows: `inventory_stock` unique `(business_id, variant_id, location_id)` with `quantity` + `reserved_quantity` (`inventoryStock.ts:13-42`).

**What does NOT exist (grep-verified absent across BE):**
- No `outbox*`, `sync_queue`, `pending_ops`, change-log/CDC tables; no terminal sync cursors/watermarks.
- **No `terminal_id`/`device_id` column on sales, sale_items, sale_payments, register_sessions/transactions, inventory_movements, or expenses.** `expense_payments.client_uuid` is the only uuid column in the entire schema.
- No `sale_channel` value for offline/LAN origin.
- No version/`updated_at` column on `inventory_stock` (nothing for optimistic concurrency or delta detection).
- `sale_payments` has no client-generatable idempotency column; `inventory_movements` has none either.
- No `inventory_movements.idempotency` — a naive offline replay would double-apply stock deltas (the only safe replay unit today is the whole `POST /api/sales` via `sales.idempotency_key`).

**Schema divergence trap:** `BE/src/db/schema/sales.ts:59` still declares plain `.unique()` on `idempotency_key`, but the live DB constraint is the composite `(business_id, idempotency_key)` from migration 0015. **Trusting `drizzle-kit generate` here would regenerate a global-unique constraint** and break multi-tenant replay. Must be fixed (or fenced) before any schema work.

**Timestamps:** dominant pattern `timestamptz defaultNow()`. Naive-`timestamp` exceptions that matter for sync: `sales.purchase_date` (the `saleDate` column), `sale_payments.payment_date`, `inventory_movements.created_at`, purchases timestamps, the whole expense module. Migration ordering note: journal `when` must stay monotonic (drizzle migrator applies `when > max(stored)`).

**Enums/CHECKs:** sale payment methods are a CHECK `('cash','bangla_qr','card','store_credit','loyalty_points','gift_card','sslcommerz')` (`salePayments.ts:42-45`); `register_transaction_type` has 8 values; `movement_type` = purchase/sale/return/adjustment/transfer_in/transfer_out; `serial_status` = in_stock/reserved/sold/returned/in_repair/damaged/lost.

## A3. Sales & transaction lifecycle

**Sale creation (POS):** `POST /api/sales` → chain `requireAuth → requireBusinessContext() → requireLocationAccess() → requireFullAccess → pos.create_sale` (`BE/src/modules/sales/sales.routes.ts:32-37`) → `createSale` controller (`sales.controller.ts:44-77`) → `salesService.createSale` — **one `db.transaction` from `sales.service.ts:753` to :1229**; any throw rolls back everything (serial-link mismatch, store-credit/loyalty/gift-card redemption failures all abort).

**Stock protection (POS path):** `validateStock` takes `SELECT … FOR UPDATE` on `inventory_stock` rows for `(business, variant, location)` up front (`BE/src/modules/sales/sales.validation.ts:87-100`); insufficient → `NotFoundError` (HTTP 404) with "Insufficient stock for variant X. Available: N" (:114-118). Batch consumption is FIFO-by-id with per-batch `FOR UPDATE` (`consumeStockFifo`, `sales.service.ts:285-364`); serials locked `WHERE status='in_stock' … FOR UPDATE`, marked sold in-tx (`consumeSerials`, :365-468; re-asserted after `sale_items` insert, :991-1008). Deduction is an unconditional `quantity = quantity - x` (:1011-1026) — **safe under concurrency because of the earlier row lock**, not because of a conditional update. Two simultaneous last-unit sales serialize; the loser sees 404. `reserved_quantity` is intentionally NOT consulted on the POS path (storefront-only; documented in `commerce/reservations.service.ts:8-25`).

**Idempotency (the offline-critical property):** payload key optional, 8–120 chars; pre-check → insert with `.onConflictDoNothing({target: [businessId, idempotencyKey]})` → refetch-and-replay returning **HTTP 201 with the ORIGINAL sale (same id, same invoice number, re-derived totals)** (`sales.service.ts:751-766, 864-909`). `offlineReplay.integration.test.ts:178-210` asserts replay returns the original invoice and exactly one stock deduction. Concurrent duplicates: loser blocks on the unique index, then replays the winner. No double stock deduction.
- **Gap R-idem:** same key with a *different* payload silently replays the first sale — no payload-hash binding (`sales.service.ts:644-688`).
- **Gap R-gap:** on the replay path the document number allocated at :856-859 commits → permanent invoice-number gaps (cosmetic).
- **Gap R-5xx:** several business-rule failures throw plain `Error` → HTTP 500 instead of 4xx: serial count mismatch (:928-935), serial unavailable (:390-392), batch shortage (:353-357). Bad semantics for offline terminals distinguishing "no stock" from "server bug".

**Invoice numbering:** `nextDocumentNumber(tx, businessId, "sale_invoice")` = single-statement `INSERT … ON CONFLICT DO UPDATE next_value = next_value + 1 RETURNING next_value - 1` (`BE/src/utils/documentSequence.ts:38-57`) — atomic, rollback-safe, serialized on the row, no duplicates. Format `INV-<year>-######`. **But online orders bypass this entirely** — `createOnlineOrder` omits `invoiceNumber`, drawing from the legacy **global** sequence column default `sale_invoice_number_seq` (`commerce/orders.service.ts:344-371`; `db/schema/sales.ts:76-82`). Two regimes counting from 1 → cross-channel `INV-YYYY-NNNNNN` collisions against `sales_business_invoice_unique` (risk R2 below).

**Returns/refunds:** single + multiple refund endpoints; core `applySaleRefund` locks the sale FOR UPDATE, pro-rata allocates the sale-level delta, enforces `refundTotal ≤ finalTotal − priorRefunds`, inserts `sale_refunds`(+items) (`sales.service.ts:1245-1574`). Restock disposition: locks stock at the sale's location, direct increment, creates a `RETURN-…` batch, writes an `inventory_movements` row type `return` (:1415-1480). Serials re-pointed by disposition (restock→in_stock, damaged→damaged, else returned) (:1397-1468). Cash refunds post `cash_refund` register transactions in-tx via `recordCashRefundInTx` (`cashRegisters.service.ts:669-693`). Duplicate-return protection = FOR UPDATE serialization + value ceiling + refunded-item filtering (sound; no DB-level unique on `sale_refund_items.sale_item_id`). Exchange reuses applySaleRefund + FIFO consumption and replays idempotently via the replacement sale's key — **but see R1: exchanges don't decrement stock.**

## A4. Inventory writers & consistency report

**There is NO shared stock-mutation service.** The only shared helper is `consumeStockFifo` (3 callers); stockCount, transfers, products (adjust), purchaseReturn each duplicate their own batch loop; every `inventory_movements` insert is inline. Every writer found (movement row?):

| Writer | Where | Movement row |
|---|---|---|
| POS sale deduction | `sales.service.ts:1011-1026` (+FIFO :285) | yes (`sale`) |
| Refund restock | `sales.service.ts:1435-1445` | yes (`return`) |
| Purchase receive | `receive.service.ts:65-89` atomic upsert `quantity = quantity + x` | yes (`purchase`) |
| Purchase return | `purchaseReturn.service.ts:314-333` (conditional `quantity >= x`) | yes (`adjustment`) |
| Manual stock adjustment | `products.service.ts:42-390` | yes (`adjustment`) |
| Transfer ship | `stockTransfers.service.ts:306-381` FIFO at source | yes (`transfer_out`, negative) |
| Transfer receive | `stockTransfers.service.ts:543-560` atomic upsert | yes (`transfer_in`) |
| Stock count approval | `stockCount.service.ts:285-449` | yes (`adjustment`) |
| Online order confirm | `orders.service.ts:573-594` | yes (`sale`) |
| **Exchange replacement** | `sales.service.ts:2249-2270` | **NO — and stock NOT decremented (R1)** |
| Reservations (storefront) | `reservations.service.ts` | no (touches `reserved_quantity` only, by design) |
| Product-create opening stock | `product.service.ts:413,459` | **no movement row** |
| Product import opening stock | `importSession.service.ts:495-541,660-710` | yes (`adjustment`) |
| Landed cost | `landed-cost.lifecycle.ts` | no (valuation-only, correct) |

Movement sign convention is inconsistent (`sale/purchase/return/transfer_in` positive; `transfer_out` negative; `adjustment` signed). Batch tracking: `inventory_batches` with quantity_received/remaining, landed-cost generated column; serials with full status machine + unique `(business_id, serial_number)`.

**Risk register (pre-existing, verified at tip):**
- **R1 HIGH — exchange bug:** replacement sale consumes batches but never decrements `inventory_stock` and writes no movement (`sales.service.ts:2249-2270`); batches drift short vs stock, later breaking transfer ship (`stockTransfers.service.ts:458-463`), counts, purchase returns. The test *codifies* the bug (`exchanges.integration.test.ts:255-265` asserts stock unchanged).
- **R2 MEDIUM-HIGH — dual invoice regimes:** per-business `document_sequences` (POS) vs global `sale_invoice_number_seq` (online orders) both start at 1; first year where both channels are active → `sales_business_invoice_unique` violation → storefront order creation 500s.
- **R3 MEDIUM — lock-order inversion:** POS sale locks stock→batches; online-order confirm touches batches→stock without the stock lock first → AB-BA deadlock window; PG aborts one side as 500.
- **R4 LOW-MED — idempotency not payload-bound** (A3).
- **R5 LOW — invoice-number gaps on replay path** (A3).
- **R6 LOW — business rules as HTTP 500** (A3) — directly harms offline replay UX.
- **R7 LOW — no test proves the last-unit concurrent-sale property** (nearest: `commerce.integration.test.ts:241`, `securityLoad.integration.test.ts:260` cover storefront); register cash attribution is silently skipped when the cashier's open session register is at a different location than the sale (`cashRegisters.service.ts:757-767`); POS-vs-storefront reserved stock oversell is documented-by-design.
- **R8 LOW — batch selection is FIFO-by-id, not FEFO** (`sales.service.ts:321` selects expiry but never orders by it).

## A5. Cash drawer / registers

- `registers` = physical drawer at one location (unique `(location_id, name)`); `register_sessions` = cashier shift with opening/expected/counted cash + difference; **DB-enforced single open session per register** (partial unique) **and per user per business** (`BE/src/db/schema/registers.ts:133-141`), plus `FOR UPDATE` pre-checks with friendly 409s (`cashRegisters.service.ts:302-332`).
- `register_transactions`: 8 movement types, `amount >= 0` CHECK, partial-unique idempotency on `(business_id, reference_type, reference_id)` for non-manual entries.
- Expected cash = `opening + Σ signed deltas` (`CASH_MOVEMENT_DELTA`, `cashRegisters.service.ts:20-24,53-65`); close persists difference; auto-attribution: cash portion of a sale posts to the cashier's open session **in the sale transaction** (`recordCashSaleInTx` :635-660), refunds post `cash_refund`, due collections post `cash_in` — each locks the session and requires register location == sale location.
- Z/X reporting: `GET /api/reports/registers` and `/api/reports/financial/register-close` (session SQL + period aggregates).
- Permissions: register create/patch need `settings.edit`; open/close/movement need `requireFullAccess` + owner-or-self (`assertSessionMayBeOperated` :397-410). **No terminal association anywhere in the register schema** (grep-verified) — drawer sessions follow the *user*, not the PC.
- **No audit entries for register open/close/manual movements** (only hardware drawer kicks are audited); purchases/transfers/customers also unaudited.

## A6. Frontend (`pos/`)

- Single axios instance; baseURL `VITE_API_URL` **baked at build time** (`pos/src/api/axios.ts:4-6`); access token memory-only, restored via HttpOnly refresh cookie at boot; request interceptor sends `Authorization`, `X-Business-Id`, `X-Location-Id`; 401 → one deduped refresh retry → hard redirect to website sign-in. **No axios timeout configured anywhere** (a hanging checkout never resolves into the offline path).
- **Cart:** single module-global `useCartStore` (no user/location/terminal dimension, `pos/src/features/pos/stores/useCartStore.ts:85-232`); persistence is a module-level subscribe → IndexedDB `active_cart` keyed by **user+business only** (`cartPersistence.ts:33`). Two tabs on one PC share one cart. Holds are **server-side** (`held_sales` table, per business+location) — already multi-terminal-safe.
- **Offline engine already exists (Module 10):** raw IndexedDB DB `ezpos-offline` v2 — stores `catalog_products`, `catalog_customers`, `active_cart`, `outbox` (keyPath `clientSaleId`), `sync_log` (`pos/src/features/pos/offline/db.ts:18-83`); scope = user+business. `recordOfflineSale` is called when `!navigator.onLine` and all payments are cash/due, and in the catch-block on network failure; `clientSaleId = crypto.randomUUID()` is sent as the backend idempotency key; `syncNow()` replays sequentially with exponential backoff 5s→5min; backend rejections → `failed` state (manual review, `retryFailed()` re-queues with the SAME key); `SyncStatus` UI pill + history dialog with Sync-now/Re-queue. `navigator.storage.persist()` requested. **Limitations:** cash/due sales only; no offline returns/purchases/cash-drawer ops/customers; no terminal scoping; catalog cache has no TTL/invalidation; `purgeSyncedBefore` exported but never called; no service worker/PWA (tab must stay alive).
- **Checkout:** `beginCheckout()` claims a UUID idempotency key reused across retries, persisted with the cart in IndexedDB so a post-crash retry reuses it; payload carries `idempotencyKey`, **no terminalId** (location rides the header); client-side quote fallback (local pricing math) replaced by debounced `POST /sales/quote` when online — client/server pricing parity is pinned by tests.
- **Realtime:** SSE-only; `POST /realtime/ticket` (30 s one-time ticket) → `EventSource /realtime/stream?ticket=…`; revision counters for `sale.created` (stock), `held_sales.changed`, `register.changed`, `notification.created` (`pos/src/features/pos/offline/realtime.ts`). Consumers: PosPage stock/holds refresh, NotificationBell. **Products/customers live in zustand stores outside TanStack Query**, so query-invalidation can't reach them; there is no `product.changed` event.
- **Terminal UI already exists:** `/settings/hardware` (terminal cards: rename/deactivate/rotate-secret/delete + pairing dialog + command history) and `/register` (register session page). Drawer commands route backend→bridge with WebUSB fallback (`drawerCommands.ts`).
- Tests: vitest + MSW (28 files), Playwright e2e 8 specs incl. full checkout workflow; known pre-existing vitest/e2e collection fix sits unpushed on local `feature/testing`.

## A7. Deployment & infrastructure

- Compose stack: postgres:16-alpine, backend, minio (+init), storefront, **caddy edge** (api/app/root/cdn + `*.ezpos.store` wildcard), website, pos (static behind nginx-spa). Migrations are manual (`docker compose run --rm backend npm run db:migrate`). nginx/ kept only for rollback; SSE passes through (backend sets `X-Accel-Buffering: no`, 25 s heartbeats).
- CI: single `ci.yml`, 5 jobs (backend w/ postgres:16 service + migrations + integration tests; pos test+build; bridge; storefront; website build). **No deployment automation at all.**
- Backend runtime: Node 22 (`.nvmrc`), `tsx watch` dev / `node dist` prod, PORT 3000, graceful SIGTERM. `AUTH_JWT_SECRET` hard-required (≥32 chars); `STOREFRONT_RENDERER_TOKEN` + non-mock `PAYMENT_PROVIDER` throw in prod; `INTEGRATION_ENCRYPTION_KEY`/`BACKUP_ENCRYPTION_KEY` degrade to `""` and fail at use-time (a Windows-installer bootstrap must generate all four). Two separate `pg` Pools from `DATABASE_URL`, **no pool max configured** (default 10).
- **No `CREATE EXTENSION` anywhere** — vanilla Postgres 16 suffices (important for a Windows local server).
- **Windows feasibility: backend is clean** — no Unix-only paths, no child processes, native deps are prebuilds (`@node-rs/argon2` win32); the bridge project already establishes the Windows patterns (Node 22, koffi optional, credentials at `~/.ezpos-bridge` overridable for service accounts, NSSM/Task Scheduler service docs). **Absent:** any packaging for the backend itself (no pkg/esbuild/electron/node-windows), no embedded-Postgres provisioning, no backend-as-Windows-service docs, no LAN discovery.
- Billing: SSLCommerz subscription IPN (no Stripe); plan/entitlement data lives in the **same Postgres** as POS data; the marketing site has no DB. Today activation is effectively trial + manual SaaS-admin ops.
- **Not an npm workspace** — root package.json is just `concurrently` scripts; each app has its own lockfile; **no shared packages** (zod schemas and API types duplicated across apps).
- Docs: `docs/cash-management/` (10 files incl. ARCHITECTURE — the bridge/terminal design), `docs/backup-restore/` (incl. DEPLOYMENT with S3/encryption-key requirements), `docs/DEPLOYMENT.md` (stale vs Caddy in places). **Nothing on LAN servers or offline terminals.**

## A8. Offline-compatibility assessment (summary)

| Requirement (master prompt) | Status today |
|---|---|
| Terminal registry, pairing, revocation, heartbeat | ✅ exists (`pos_terminals` + admin UI) — needs enforcement on POS routes |
| Terminal attribution on transactions | ❌ absent (no columns) |
| Independent carts per terminal | ⚠️ holds true across PCs (separate browsers) but not keyed by terminal; two tabs share one cart; IndexedDB scope is user+business |
| Concurrent-sale protection | ✅ FOR UPDATE + serialized batches; idempotent replay; **no dedicated last-unit race test** |
| Per-terminal cash drawer | ⚠️ sessions follow the user (one open per user); no terminal binding |
| Realtime cross-terminal updates | ✅ SSE exists (8 event kinds, business/location scoped) — needs more events + FE wiring |
| Local printing per PC | ✅ WebUSB ESC/POS + browser print + bridge relay already per-browser |
| Server-side holds | ✅ |
| Offline sales (cash/due) | ⚠️ browser engine exists: IndexedDB outbox + idempotent replay + sync UI — cash/due only, no terminal scoping, no returns/drawer/customers, no PWA durability |
| Offline returns/purchases/drawer | ❌ absent |
| Inventory allocation/reconciliation | ❌ absent (no allocation, no movement idempotency, no conflict records) |
| Offline-safe invoice numbering | ⚠️ idempotency key exists; provisional numbering not designed |
| LAN server mode | ❌ absent (backend is Windows-clean; packaging/provisioning/discovery all greenfield) |
| Sync engine (any kind) | ❌ absent server-side; FE has the outbox half only |

## Security risk summary

1. (Open, user-owned) `AUTH_JWT_SECRET` rotation + optional history purge — still pending from the cash-management program.
2. Admin password reset doesn't revoke sessions (A1-G2).
3. In-memory rate limiting + in-memory SSE registry + in-memory scheduler: single-instance assumption throughout — fine for Phase 1 cloud (single node) and Phase 2 LAN (single node by definition), must be re-visited only if the cloud backend ever scales horizontally.
4. No terminal enforcement on POS routes means "revoked terminal" is currently decorative for browsers (A1).
5. No CSP; no PWA — offline terminals hold plaintext business data in IndexedDB (acceptable, must be documented; revocation is best-effort until reconnect, per master prompt §8.2).
