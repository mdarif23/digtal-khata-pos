# Deployment — Backup & Restore

## Server-side checklist (per environment)

1. **Set `BACKUP_ENCRYPTION_KEY`** (32+ chars, e.g. `openssl rand -base64 48`).
   This is the master key that unwraps every backup's DEK — losing it (and
   the `business_backups` rows) makes all packages unreadable. Back it up
   with the same care as the database credentials. `BACKUP_ENCRYPTION_KEY_VERSION`
   defaults to 1; bump only when you rotate and re-wrap.
2. **Create the dedicated private bucket** (`S3_BACKUP_BUCKET`, default
   `ezpos-backups`) on MinIO/R2/S3 with **NO anonymous-access policy**. The
   media bucket grants bucket-wide anonymous download for the storefront CDN
   (`docker/minio-init`) — backups must NOT share that bucket. If the bucket
   does not exist yet:

   ```sh
   docker compose exec minio mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
   docker compose exec minio mc mb local/ezpos-backups
   # deliberately NO anonymous set here — private by default
   ```

3. **Apply migration 0047** on every machine that pulls this branch:
   `cd ezPosBackend && DATABASE_URL=<connection string> npm run db:migrate`.
   (The user's Windows dev box: set `DATABASE_URL` in the same PowerShell
   session or `.env` first — drizzle-kit silently exits when it is missing.)
   Success signature: `[✓] migrations applied successfully!` with 0047 in the
   list.
4. **Restart the backend** — `ensureRbacSeed()` seeds the new `backups.*`
   permissions and the owner/manager/accountant role templates on boot.
5. **Verify** (go-live smoke):
   - `GET /api/backups/modules` → `storageEnabled: true`
   - Settings → Backup & Restore → **Back up now** → row completes with
     `verifiedAt`
   - **Download** → file starts with `EZBACKUP1`
   - **Verify** on the stored row → verified
   - Restore → preview passes → (optionally) full restore into a scratch
     business first.

## Frontend

`pos/` builds are unchanged apart from the new route/nav; pull + `npm ci`
is only needed if dependencies changed (none were added for this feature).

## Disaster-recovery runbook (platform level — operators only)

- Nightly full-DB backup (Postgres 16 container, volume `pgdata`):

  ```sh
  docker compose exec postgres pg_dump -Fc -U postgres postgres \
    > "backups/db-$(date +%F).dump"
  ```

  Keep N days off-box. Restore proof: restore into a scratch database and
  run row-count spot checks before trusting any dump.
- Business-level recovery: use the product itself (`.ezbackup` restore) —
  NEVER restore the shared database for one business.
- If `BACKUP_ENCRYPTION_KEY` is lost: packages are unrecoverable; restore
  from the platform-level `pg_dump` instead. This is why the key is backed
  up with credentials.
