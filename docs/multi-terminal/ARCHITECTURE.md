# ezPos Multi-Terminal Architecture Proposal — One Core, Three Connection Modes

Status: **PROPOSAL — awaiting explicit user approval. Nothing below has been implemented.**
Companion to `docs/multi-terminal/AUDIT.md` (Phase A read-only audit, tip `50e9efc`).

## 0. Guiding principle (user directive)

> Do not build three independent POS systems. Build one shared business-logic architecture with three different ways of connecting to it: Cloud API, Local LAN API, Offline local transaction engine.

How that maps onto what actually exists (audit §A7): **the Express backend already is the shared core.** Cloud and LAN modes run the *same artifact* — same routes, same services, same Drizzle schema, same migrations — against different Postgres instances. There is no second business-logic implementation to write, which is exactly the duplication the directive forbids. The offline engine is a *browser-side transaction buffer*, not a POS implementation: it records ops, prices them with the already-parity-tested local fallback, and replays them through the **same cloud/LAN API** with idempotency keys. What gets extracted into shared code is the *contract layer* (zod payloads, pricing rules, sync op types), not a second business engine.

```text
                         ┌────────────────────────────────────────────┐
                         │        SHARED CORE (one implementation)    │
                         │  Express services · Drizzle schema · RBAC  │
                         │  inventory ledger · document numbering     │
                         │  shared contract package (zod/pricing/sync)│
                         └───────────────┬────────────────────────────┘
              ┌──────────────────────────┼───────────────────────────┐
        Mode A: CLOUD              Mode B: LAN                 Mode C: OFFLINE
        same backend,              same backend dist,          browser engine in pos/
        cloud Postgres             local Postgres 16,          (existing IndexedDB outbox,
        (today's deployment)       sync agent → cloud          extended per approved spec)
              │                          │                          │
        PC1 PC2 PC3 ── internet ── LAN: PC1..3 ── Wi-Fi ── each PC fully alone
```

Non-goals (protecting the directive): no SQLite (Postgres 16 on Windows needs no extensions — audit §A7); no Electron/pkg rewrite of the backend; no browser-side re-implementation of pricing/tax/inventory rules beyond the existing quote fallback; no table-copying synchronization.

---

## 1. Current state in one page

Everything below exists today and is verified in the audit: multi-tenant auth with per-location assignment enforcement; a **terminal registry** (`pos_terminals`, pairing codes, hashed secrets, heartbeat, revocation, admin UI at `/settings/hardware`) currently wired only to the hardware bridge; a **single-transaction sale path** with `FOR UPDATE` stock locking, FIFO batches, serial allocation, atomic per-business invoice numbering, and **business-scoped idempotent replay** (proven by `offlineReplay.integration.test.ts`); **cash drawer sessions** with DB-enforced single-open-per-register/per-user and in-transaction cash posting; an **SSE realtime channel** (8 event kinds, ticket auth); **server-side held carts**; a **browser offline engine** (IndexedDB outbox + sequential idempotent replay + sync UI) for cash/due sales; per-PC printing (WebUSB / browser / bridge). A Windows-clean backend (Node 22, no extensions) with NSSM service precedent from the bridge.

What's missing is precisely the multi-terminal and sync layer: terminal enforcement/attribution on POS routes, terminal-scoped carts and drawer sessions, more realtime events, a server-side sync protocol, offline allocations/reconciliation, and LAN packaging. Plus five pre-existing bugs (audit R1–R3, R6, schema divergence) that would corrupt a multi-terminal deployment and must be fixed first.

---

## 2. Shared terminal identity model (all modes)

Reuse `pos_terminals` as the single terminal identity. Changes:

- **DB (migration 0049, additive):** nullable `terminal_id` on `sales` (FK → `pos_terminals(id)`), on `register_sessions`, and on `terminal_pairing_codes`-style pairing already fine. Nullable preserves storefront/online orders and existing rows. Add index `(business_id, terminal_id)` on sales.
- **Header:** FE sends optional `X-Terminal-Id` on POS-family routes (sales, refunds, held-sales, registers, expenses). Backend middleware `requireTerminalContext()`: if header present → terminal must exist, belong to the caller's business AND current location, and be `active`; inactive → 403 `TERMINAL_REVOKED`; if absent → allowed (backward compatible) unless the business enables a new setting **`requireTerminalForPos`** (default off; shops that want strict control turn it on).
- **Heartbeat reuse:** the FE sends the header on ordinary API traffic; backend touches `last_seen_at` on those requests the same way `terminalAuth` already does for the bridge (`middleware/terminalAuth.ts:94-97` pattern) — no new poller needed.
- **Pairing for browsers:** reuse `terminal_pairing_codes`. A PC claims a terminal once in `/settings/hardware` (or first POS boot dialog); the browser stores only the **terminal id** (not a secret) in localStorage. Security note (documented limitation): the browser-held id *attributes and restricts with user auth still mandatory*; it is not a bearer credential — the user's session remains the authenticator, and `requireTerminalForPos` mode makes an unregistered PC unable to sell at all.
- **Attribution:** `sales.terminal_id`, `register_sessions.terminal_id`, and audit metadata record the terminal on every transaction; offline-originated records carry the terminal id in the op payload. Existing columns stay untouched (per master-prompt rule "do not add redundant columns").

## 3. Phase 1 — Cloud multi-terminal (full spec)

Scope guard: Phase 1 touches only cloud mode. No LAN packaging, no offline-engine expansion — those need separate approvals (stages 3/4 of the master prompt).

### 3.1 Terminal management
`/settings/hardware` already covers register/rename/deactivate/rotate-secret/delete/pair (audit §A6). Phase 1 adds: explicit **location assignment + reassignment** control, **activate** action, last-active display from `last_seen_at` (data already flows), and the `requireTerminalForPos` business toggle. Backend: extend `pos_terminal.manage` routes; no new tables.

### 3.2 Enforcement & attribution
`requireTerminalContext()` middleware (§2) on `POST /api/sales`, refund endpoints, `/api/held-sales`, `/api/registers/*`; `terminal_id` written inside the sale/refund/session transactions. Cross-business access is already impossible (composite FK + middleware), now also enforced for terminals.

### 3.3 Independent carts per terminal
- IndexedDB `active_cart` and outbox scope key becomes **`user:business:terminal`** (`cartPersistence.ts:33` scope extension); a terminal-less session falls back to the current key (no data migration needed — old snapshots are simply abandoned, carts are ephemeral).
- Two tabs on one PC remain one cart (documented; a POS PC is one tab). Cross-PC independence already holds via separate browsers; the terminal key makes it *explicit and revoke-safe*.
- Holds stay server-side per business+location (already correct for multi-terminal).

### 3.4 Cash drawer per terminal
- `register_sessions.terminal_id` set at open time (from the terminal context).
- Attribution rule (extends today's user-based rule, `cashRegisters.service.ts:735-767`): a cash sale prefers the **open session bound to the sale's terminal**; falls back to the cashier's own open session at the sale location (current behavior); if neither, no-op (unchanged). The one-open-per-user constraint stays by default; a new business setting **`allowMultipleDrawerSessionsPerUser`** (default off) relaxes it for shops where one cashier runs two counters — enforced via the existing partial-unique-index pattern (replace the per-user index with a per-user-or-terminal variant only when the setting is on).
- Fix the silent-skip gap (audit R7): when attribution fails because the session's register is in a different location, record an audit entry instead of silently dropping cash.

### 3.5 Real-time updates (SSE, no WebSockets)
Extend the existing typed union (`BE/src/modules/realtime/realtime.service.ts:112-129`) with `product.changed`, `customer.changed`, `terminal.changed`; publish from product/variant/barcode, customer, and terminal services (pattern: `publishRealtime(businessId, locationId|null, event)`). FE: subscribe in `useProductStore`/`useCustomerStore` fetch paths (they're zustand-imperative, outside TanStack Query — refresh on revision bump, same as PosPage does today). Keep the "signal only, clients refetch" design (no payload fan-out → no leak risk), single-instance in-memory registry (documented caveat, consistent with rate limiting). TanStack Query consumers get `invalidateQueries` on the same signals.

### 3.6 Printing & scanners
Already per-PC (WebUSB/browser print/bridge relay, barcode scanner service). No backend printing exists — keep it that way (master prompt §6.8 satisfied). Terminal-scoped printer preference: move `ezpos.drawerTerminalId` and receipt fallback settings under the terminal binding key.

### 3.7 Included bug fixes (prerequisites — these corrupt multi-terminal deployments)
1. **R1 (HIGH):** exchange replacement sale must decrement `inventory_stock` + write the movement (`sales.service.ts:2249-2270`); flip the codifying test.
2. **R2 (MEDIUM-HIGH):** single invoice regime — allocate `INV-` numbers for online orders from the business `document_sequences` (same in-tx call the POS path uses), stop relying on the global column default; backfill guard: keep `sales_business_invoice_unique` as the safety net.
3. **R6 (LOW but offline-critical):** map business-rule failures to 4xx (`BadRequestError`/`ConflictError`) for serial mismatch/unavailable, batch shortage — offline terminals must distinguish "no stock" from "server bug".
4. **Schema divergence:** align `sales.ts:59` with the composite unique from migration 0015 so `drizzle-kit generate` can never regress it.
5. **R4 (cheap now):** bind idempotency to payload — store a hash of the canonical sale payload and return 409 `IDEMPOTENCY_PAYLOAD_MISMATCH` on key-reuse with a different body (offline correctness depends on trusting replays).
6. **A1-G2:** admin password reset revokes refresh tokens (2-line fix in `users.service.ts:378-397`).

### 3.8 Database / API / FE change summary — Phase 1
- **Migration 0049** (next free number; `when` > 1794200000000; apply via `scripts/apply-migration.mjs` playbook): additive columns `sales.terminal_id`, `register_sessions.terminal_id`, indexes; no data backfill needed (nulls allowed); **no enum changes**.
- **API:** all changes additive (new middleware, new optional header, extended terminal admin endpoints, 3 new SSE event kinds, 409 on payload-mismatched idempotent replay, 4xx for the R6 cases).
- **FE:** terminal binding dialog + header injection in `axios.ts`, scope-key change in `cartPersistence`, terminal column in register UI, SSE wiring for product/customer stores, `/settings/hardware` additions. **Compatibility:** the SPA continues to work without a bound terminal (header simply absent).
- **Tests:** real-Postgres concurrency suite — two simultaneous last-unit sales (Promise.all against two HTTP sessions; **this is the test the audit found missing, R7**), concurrent duplicate idempotency keys (both in flight), terminal revocation mid-session, cross-business terminal use, attribution rules, per-terminal drawer sessions; FE vitest for scope-key + binding; e2e happy path with two bound browsers.

### 3.9 Phase 1 completion criteria → mechanism
Master prompt §6.9: two+ PCs same business ✅ (already true); simultaneous cashiers ✅; independent carts ✅ (terminal-keyed persistence); inventory consistency ✅ (existing FOR UPDATE + new race tests prove it); duplicate sales prevented ✅ (existing idempotency + payload binding); per-terminal drawer ✅ (§3.4); local printing ✅ (existing); revocable terminals ✅ (`requireTerminalContext` 403); realtime ✅ (extended SSE); cross-business prevented ✅ (existing + composite FKs); existing POS intact ✅ (nullable columns, optional header, additive API).

**STOP — Stage 2 gate: deliver test report, wait for approval before Phase 2.**

---

## 4. Phase 2 — LAN server mode (outline; separate approval required)

**Same artifact, new deployment.** The local server is the unmodified backend (`node dist` or Docker) on a Windows machine with a local Postgres 16, plus a **sync agent** module in the same process. Terminals connect to `http://<lan-host>:3000/api` via the same SPA.

- **Runtime API base URL:** ship the SPA as the same-origin build (`VITE_API_URL` default `/api`, audit §A7) behind a tiny local reverse proxy (or Caddy), so **one build serves cloud and LAN** — no rebuild per shop. Add a runtime override (e.g. `window.ezposConfig.apiUrl` from `/config.json`) as a second escape hatch.
- **Windows packaging:** Node 22 + Postgres 16 installers, `ezpos-local-setup` CLI (generate the four prod-critical secrets — audit §A7 — init DB, run migrations via `apply-migration.mjs`, write `.env`), NSSM/Task-Scheduler service registration (bridge precedent), health page, log location, backup = existing backup module pointed at a local directory (S3 optional), upgrade = replace dist + migrate. No Electron/pkg.
- **Provisioning:** shop pairs the LAN server as a special terminal (`pos_terminals.is_sync_agent` or equivalent capability flag); cloud issues it a device credential (reuse `requireTerminalAuth`). **Two-server prevention:** only one active sync-agent terminal per business+location; cloud grants a **sync lease** (heartbeat-held row) so a second accidentally-started server uploads nothing and reports itself.
- **Authority rules:** cloud is authoritative for catalog/reference data (products, variants, barcodes, prices, customers master, settings); local is authoritative for transactions it created; inventory reconciles **only through movements** (append), never balance overwrites. Cloud-origin product/price edits flow down; local sales flow up; simultaneous edits resolve by rule table (financial rows append-only; catalog rows last-write-wins with `updated_at` since they are non-financial and versioned by the sync cursor).
- **Sync protocol (operation-based, never table-copy):**
  - *Upload:* local `outbox` table (mirrors the FE outbox design) → batched `POST /api/sync/ops` on the cloud, each op carrying `opId` (UUID), `type`, `payload`, `terminalId`, `recordedAt`. Cloud applies idempotently: sales via existing `idempotency_key`; refunds/purchases/register transactions via new client-key columns or the `reference_type/reference_id` unique pattern; movements deduped by op id. Dependency order per master prompt §7.6, derived from FK graph (catalog → customers/suppliers → purchases → sales → returns → drawer/expenses).
  - *Download:* cursor-based delta pulls `GET /api/sync/changes?stream=catalog&cursor=…` (new `terminal_sync_state` table per agent+stream; `updated_at` watermarks — requires adding `updated_at` triggers/columns to catalog tables, migration 0050+).
  - *Acks + dead-letter:* per-op `applied | conflict | failed(reason)`; failed ops retry with backoff; conflicts land in a review queue (Phase 3's conflict UI reused).
  - LAN inventory consistency: same server, same transactions — Phase 1's concurrency guarantees apply verbatim (master prompt §7.7).
- Migration 0050+; endpoints under `/api/sync/*` gated by the sync-agent credential.

### 4.1 Phase 2 as implemented (2026-11-06)

Refinements locked in during implementation (all covered by integration tests):

- **The sales table IS the durable outbox.** `sales.synced_at IS NULL` +
  attempt counter + partial index — no separate queue table; a committed
  sale can never be lost, and retries are idempotent via the existing
  business-scoped idempotency key (plus `lan-<saleId>` fallback for legacy
  keyless rows).
- **Identity = full snapshot every sweep** (business, locations, users
  *with password hashes* so cashiers can log in offline, roles,
  memberships, plans + subscription, POS settings). Catalog/customers =
  microsecond-precision watermark deltas (`updated_at` now trigger-maintained
  on products, variants, aliases, customers); **stock = full per-location
  snapshot**, applied only after a successful push (push-before-pull gate).
- **Customer id mapping**: locally-created customers upload first with a
  `client_uuid`; the cloud adopts them and the agent rewrites dependent
  sale payloads to the cloud id on the next sweep (one-sweep latency).
- **Two-server prevention is DB-enforced**: partial unique index — one
  `is_sync_agent` terminal per business+location; ops from non-agents are
  403. Replicated sales carry `channel='offline'` and never appear in the
  online-orders portal.
- **Tenancy inside the agent**: every push query is explicitly
  business-scoped (the pushOnce business filter was added after a test
  run proved cross-business leakage on a shared test DB).
- Windows packaging: `ezPosLocalServer/setup.mjs` + `pair.mjs` +
  README/DEPLOYMENT (UNVERIFIED on real hardware, flagged); SPA gains a
  runtime `public/config.js` API-URL override (no rebuild per shop) and a
  Local server sync card at Settings → Hardware.

## 5. Phase 3 — Full offline per-terminal (outline; separate approval required — includes the inventory-allocation design the user flagged as the hard problem)

Extend the **existing** browser engine (`pos/src/features/pos/offline/`) rather than adding a framework: IndexedDB stays, add Dexie only if raw-IDB maintenance cost proves it (audit: deliberately dependency-free today).

**5.1 The disconnected-terminals problem, stated honestly:** two PCs offline cannot know each other's sales; any scheme is a policy, not a fix. Design — three explicit modes per product (business setting, default conservative):
1. **Allocated (default):** when a terminal goes offline it receives a server-computed **offline allowance** per sellable variant: `min(policyCap, stock − Σ(active allowances) − safetyBuffer)`. Allowances are server-side ledger rows (`offline_allocations`: terminal, variant, qty, TTL, unique per terminal+variant) — **enforced by the authoritative server, non-reusable by two terminals**. The terminal may sell up to its allowance offline; the allowance refreshes on every connectivity window and expires (TTL, default 24 h). Sales beyond allowance are blocked at add-to-cart time offline.
2. **Blocked:** high-value/serial-tracked products default to *no offline selling*. Serial-tracked products are always blocked offline (prevents the same serial selling twice — audit: serial uniqueness is DB-enforced only online).
3. **Open (explicit opt-in):** sell freely offline; sync may produce negative stock → **conflict record + manager review**, never silent overwrite.
Batch-tracked products under Allocated mode: the offline sale records a batch-less consumption intent; on sync the server assigns batches FEFO (fixing R8 makes this correct); insufficient batch coverage → conflict review.

**5.2 Reconciliation:** ops replay in dependency order (same protocol as Phase 2 — the LAN outbox and FE outbox speak the same op format); inventory moves only via `inventory_movements` (append-only, master prompt §8.9); per-op outcomes `applied | conflict | failed`; conflicts create `sync_conflicts` records surfaced in a review UI (manager permission). Financial rows are append-only; document numbers: offline receipts print a **provisional** number `OFFLINE-<terminal>-<localSeq>` + the client UUID; the server assigns the canonical `INV-…` at sync; the distinction is displayed on the receipt and in sales history (never reused, never falsely "cloud-confirmed" — statuses Pending/Syncing/Synced/Failed/Conflict already exist in the SyncStatus UI and extend).

**5.3 Scope of ops offline:** sales (already), returns against locally-known sales only (original sale id + quantity ceilings, refund cap setting), cash drawer open/movements/close (unique session UUID per terminal), customer create (client UUID; server adopts), price checks against cached catalog. Purchases/receiving: **out of scope offline by default** (master prompt §8.5 allows policy-deferral; recommend deferring unless requested).

**5.4 Durability & security:** PWA/service-worker for app-shell reload (the current engine dies with the tab); encrypted-at-rest is out of scope for IndexedDB (documented limitation, master prompt §8.1 requires it be documented); offline auth = cached session with expiry (reuse refresh-token TTL) + terminal must have been bound; **revoked terminal/user takes effect on first contact** (offline mode refuses after TTL); sync credentials = the user session + terminal id (no new secrets in the browser).

**5.5 Migration 0051+** (`offline_allocations`, `sync_conflicts`, outbox ack columns, catalog `updated_at`), `/api/offline/*` endpoints. Testing: the master prompt's Phase-3 list (18 scenarios) incl. two-offline-terminals-same-stock under each policy mode, browser-restart persistence (Playwright), storage-corruption recovery.

## 6. Cross-cutting (all phases)

- **Tenant isolation:** unchanged mechanisms (membership + location + permission middleware); terminals add one more scoping axis (§2). Never trust client business/location/terminal ids — already the codebase convention.
- **Audit trail:** `recordAuditInTx` gains terminal context on sale/refund/drawer events; add the missing register/purchase/transfer audit events (audit §A5).
- **Backup/recovery:** cloud = existing module; LAN = same module to a local directory; terminal outbox = existing unsynced-sales JSON export (backups program already gates restore on `pendingCount`) extended to the full op outbox; restore never replays synced ops (idempotency keys make replay safe regardless).
- **Monitoring:** scheduler sweep for sync health (pending/failed/conflict counts per terminal → notification kinds exist as free strings; SSE events for terminal.changed).
- **Known limitations (documented, accepted):** single-instance cloud backend (in-memory rate limit/SSE/scheduler); browser-held terminal id is not a bearer credential; offline IndexedDB is plaintext; offline returns restricted to locally-known sales; provisional offline invoice numbers.

## 7. Roadmap & gates (mirrors master prompt §11)

| Stage | Work | Gate |
|---|---|---|
| 2 | Phase 1 §3 incl. prerequisite bug fixes R1/R2/R6/divergence/payload-binding/A1-G2; migration 0049 | Test report → **user approval** |
| 3 | Phase 2 §4 (LAN packaging, sync agent, `sync/*` API, migrations 0050+) | Test report → **user approval** |
| 4 | Phase 3 §5 (offline expansion, allocations, conflicts, migrations 0051+) | Test report → **user approval** |
| 5 | Cross-mode integration testing (cloud↔LAN↔offline transitions per master prompt) | Final report |

Each stage is separately approved before it starts; nothing in stages 3–5 is implemented now.
