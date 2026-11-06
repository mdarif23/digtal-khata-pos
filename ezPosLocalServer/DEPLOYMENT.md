# ezPos Local Server — Deployment & go-live checklist (Phase 2)

Status: **UNVERIFIED ON REAL WINDOWS HARDWARE** — annotate every step with
its result on the first deployment. Linux preview: the setup script and the
backend are platform-clean; only the service-registration and firewall
steps are Windows-specific.

## 0. Prerequisites

- [ ] Windows 10/11 or Windows Server with **Node 22 LTS** (`node -v`)
- [ ] **PostgreSQL 16** installed, service running, `psql` on PATH
- [ ] Cloud backend reachable at `https://api.ezpos.com` (or the shop's domain)
- [ ] Shop has a paired terminal plan: which PC is the LAN server; which
      terminals (PCs) bind to which registers

## 1. Local database

- [ ] Create a dedicated role + database (setup.mjs does this with
      `--pg-url`; otherwise run manually):
      ```sql
      CREATE ROLE ezpos_local LOGIN PASSWORD '<generated>';
      CREATE DATABASE ezpos_local OWNER ezpos_local;
      ```
- [ ] Verify: `psql postgresql://ezpos_local:<pass>@localhost:5432/ezpos_local -c "select 1;"`
- [ ] Confirm Postgres listens on **localhost only** (`listen_addresses` in
      postgresql.conf) — the DB is never exposed to the LAN.

## 2. Backend setup

- [ ] `node ezPosLocalServer\setup.mjs --pg-url ... --cloud https://api.ezpos.com`
- [ ] Confirm `ezPosBackend/.env` exists (0600) with AUTH_JWT_SECRET,
      INTEGRATION_ENCRYPTION_KEY, BACKUP_ENCRYPTION_KEY, DATABASE_URL,
      EZPOS_SYNC_ENABLED=true. **Back up the two encryption keys** — losing
      BACKUP_ENCRYPTION_KEY makes local backups unreadable.
- [ ] `cd ezPosBackend && npm start` → `http://localhost:3000/api/health`
      responds (or any cheap authenticated route).

## 3. Sync-agent pairing

- [ ] Cloud POS → Settings → Hardware → **Pair a terminal** named `LAN Server`
- [ ] Mark it as sync agent (`{ "isSyncAgent": true }` — UI action on the
      terminal card). The DB enforces one agent per business+location.
- [ ] `node ezPosLocalServer\pair.mjs --terminal-id <id> --secret <ezpos_tb_…>`
      → prints `cloud responded 200`.
- [ ] Restart the backend. Within one interval (60 s default) the sync card
      at `/settings/sync` shows identity/catalog/stock pulls with cursors.

## 4. LAN serving of the POS app

- [ ] Build the POS once with the same-origin default:
      `VITE_API_URL=/api npm run build` in `pos/` (or use the shipped dist
      with `public/config.js` — see below).
- [ ] Serve `pos/dist` statically on the LAN server with `/api` proxied to
      `localhost:3000` — Caddy example:
      ```
      :8080 {
        handle /api/* { reverse_proxy localhost:3000 }
        handle { root * C:/ezpos/pos/dist
                 try_files {path} /index.html
                 file_server }
      }
      ```
- [ ] Runtime override (no rebuild per shop): edit `pos/dist/config.js` →
      `window.ezposConfig = { apiUrl: "http://<lan-ip>:8080/api" }`.
- [ ] Windows Firewall: allow inbound TCP on the serving port (8080) for
      the LAN profile ONLY.
- [ ] Reserve the server's LAN IP (DHCP reservation) or use mDNS hostname;
      terminals bookmark `http://<lan-ip>:8080`.

## 5. Verification (Phase 2 test pass)

- [ ] Cashier login works on a LAN terminal (identity sync brought users).
- [ ] Catalog visible with correct stock; barcode scan finds products.
- [ ] Ring a cash sale → receipt prints → cloud shows the sale within one
      sweep (`sales.channel='offline'`, audit `sale.sync_applied`).
- [ ] Create a customer offline → appears on the cloud after sync; a
      customer-attached sale follows within one sweep (mapping wave).
- [ ] Pull the LAN cable → sell for a few minutes → replug → all sales
      appear on the cloud; no duplicates (idempotency keys).
- [ ] Cloud price edit → LAN catalog updates within one sweep.
- [ ] Cloud-side receiving → LAN stock snapshot reflects it after push+pull.
- [ ] Restart the LAN server mid-sales → no transaction lost
      (sales are committed locally before upload).
- [ ] `POST /api/sync/ops` with a NON-agent credential → 403.
- [ ] Try a second LAN server for the same shop → pairing as agent fails
      (partial unique index) or its ops get 403 SYNC_AGENT_REQUIRED.
- [ ] Deactivate the agent terminal on the cloud → local pushes stop
      failing closed (401/403), sync card shows the error.

## 6. Backup & recovery

- [ ] Nightly `pg_dump` of the local DB (Task Scheduler) to a second disk.
- [ ] Optional: the in-app backup module targets a local directory
      (`S3_BACKUP_BUCKET` unset → local-fallback mode).
- [ ] Restore = install fresh + `setup.mjs` + restore dump + re-pair. The
      agent re-pushes any sale whose `synced_at` is NULL — restore cannot
      double-upload (idempotency keys).

## 7. Rollback / uninstall

- [ ] Stop the service (`nssm stop ezPosLocal` / `schtasks /End`).
- [ ] Un-pair the agent terminal on the cloud (or deactivate it).
- [ ] Unregister the service; drop the local DB if desired. The cloud never
      depended on the local server.
