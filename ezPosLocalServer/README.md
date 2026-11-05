# ezPos Local Server (LAN mode — Phase 2)

One Windows machine in the shop runs the **same ezPos backend** against a
**local PostgreSQL 16**. All PCs in the shop point their browser at this
server over the LAN; it serves the POS frontend, enforces the same
permissions and business rules, and keeps working when the internet is
down. A built-in **sync agent** pushes local sales/customers to the cloud
and pulls identity, catalog, stock and customer changes back whenever the
internet returns.

> **Status: UNVERIFIED ON REAL WINDOWS HARDWARE.** The backend itself is
> Windows-clean (no Unix-only code, no Postgres extensions needed), and the
> service-registration paths follow the ezPosHardwareBridge precedent — but
> the setup script and service steps must be walked through manually on the
> first Windows deployment and the checklist annotated with findings.

## Architecture in one paragraph

The LAN server is not a second POS implementation — it is the identical
backend artifact (same dist, same migrations) with two extra pieces: a
`sync_state`/`sync_id_map` bookkeeping pair and the sync agent loop
(`EZPOS_SYNC_ENABLED=true`). On the cloud, the shop pairs a terminal and
marks it `isSyncAgent`; a DB partial unique index allows **at most one sync
agent per business+location**, so two accidentally-started local servers
can never both become inventory authorities. Ops uploaded to the cloud are
idempotent by construction (sales carry the client idempotency key; cloud
replays return the original invoice — proven by tests), and stock is pulled
as a full location snapshot **only after a successful push**, which makes
the snapshot overwrite safe.

## Data flows

| Direction | What | How |
|---|---|---|
| Pull (every sweep) | identity: business, locations, users+password hashes, roles, memberships, plans+subscription | full upsert by id — small tables |
| Pull (delta) | catalog: products+variants+barcode aliases+taxes (+ categories/brands/units full) | `updated_at` watermark (trigger-maintained), `GET /api/sync/catalog?since=` |
| Pull (every sweep) | stock for THIS location: inventory_stock + batches + in-stock serials | full snapshot; safe only after a successful push |
| Pull (delta) | customers | `updated_at` watermark |
| Push (every sweep) | completed POS sales not yet synced (`sales.synced_at IS NULL` — the durable outbox) | `POST /api/sync/ops` — per-op results, failed ops retry with attempt cap |
| Push (every sweep) | locally-created customers | `customer.create` op keyed by `client_uuid`; the cloud's response fills `sync_id_map` and the NEXT sweep pushes dependent sales with the cloud customer id |

## Quick start (Windows)

1. Install Node 22 LTS and PostgreSQL 16 (standard installers; no
   extensions required).
2. `node ezPosLocalServer\setup.mjs --pg-url postgresql://postgres:<pass>@localhost:5432/postgres --cloud https://api.ezpos.com`
   — creates the local DB, generates the four secrets into
   `ezPosBackend/.env` (0600), installs deps, applies all migrations.
3. On the CLOUD POS: Settings → Hardware → pair a terminal named
   `LAN Server`, then mark it as the sync agent (the PATCH body
   `{ "isSyncAgent": true }`; the UI exposes a "Make sync agent" action).
4. `node ezPosLocalServer\pair.mjs --terminal-id <id> --secret <ezpos_tb_...>`
   — stores the credential locally and verifies one authenticated call.
5. Serve the POS frontend from the same origin (see DEPLOYMENT.md) so
   `VITE_API_URL=/api` works without a rebuild, then `npm start`.
6. Watch `/settings/sync` (Local server sync card) — pending count,
   cursors, last push/pull, last error.

## Windows service

Both options are printed by `setup.mjs --service nssm|task` and documented
in DEPLOYMENT.md. NSSM is the recommended path (log redirection, restart
throttling). The data directory defaults to `%USERPROFILE%\.ezpos-local`
(override with `EZPOS_LOCAL_DATA_DIR` for service accounts).

## Security notes (read before go-live)

- The identity pull replicates **password hashes** (argon2) to the local
  machine so cashiers can sign in during internet outages. The local
  Postgres must therefore never be exposed beyond localhost — terminals
  talk to the backend API only, never to the DB port.
- The sync credential (`ezpos_tb_…`) grants catalog/stock/identity read and
  op upload for exactly one business+location. Rotate it via the terminal
  secret rotation; un-pairing or deactivating the terminal revokes access
  immediately (every request re-reads the terminal row).
- Use HTTPS at the edge where possible (Caddy on the LAN server works with
  an internal CA or a shop domain); otherwise restrict the LAN to trusted
  Wi-Fi. The cloud connection must be HTTPS (`EZPOS_SYNC_CLOUD_URL`).
- Offline authorization limits: a local server keeps enforcing its last
  synced identity/permissions while the internet is down. Revoking a user
  on the cloud takes effect locally at the next successful pull — document
  this window in staff policy.

## Known limitations (Phase 2 scope decisions)

- **Invoice numbers differ per server.** The LAN receipt shows the local
  number; the cloud replica carries the cloud's canonical number. The
  idempotency key links them; the audit entry `sale.sync_applied` records
  the originating terminal name.
- **Purchases/receiving are not synced** (recommended: receive stock on the
  cloud; the LAN pulls the new stock within one sweep). Local purchase
  entries would not reach the cloud in Phase 2.
- **Refunds/exchanges, cash-drawer sessions, expenses stay local-only**
  until Phase 3 adds their op types.
- **Hard-deleted products are invisible to the catalog delta** — use the
  force-full-refresh (since=0) after destructive catalog operations.
- **Serial/batch fidelity:** a locally-rung serial sale marks the local
  serial sold; the cloud replica marks the matching cloud serial sold (same
  serial numbers, same ids). If stock was received locally (not synced),
  serial/batch ops can fail and will dead-letter with a clear error.
- **Two-server prevention is enforced** (one sync agent per business+
  location, DB-level), but a stolen agent credential could still upload —
  rotate/unpair on hardware loss.
