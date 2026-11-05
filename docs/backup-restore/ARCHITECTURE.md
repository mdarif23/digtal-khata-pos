# Backup & Restore — Architecture

## Two layers (per the approved proposal)

- **Platform-level** (operators): documented `pg_dump` runbook — the shared
  multi-tenant PostgreSQL is never restored for a single business. No
  business owner can ever reach a full database backup. (Runbook item below.)
- **Business-level** (owners): per-business row extraction packaged as
  `.ezbackup` — what this module implements.

## Package format (`.ezbackup` v1)

```
bytes 0..8     ASCII magic "EZBACKUP1"
bytes 9..12    uint32 BE header length (H)
bytes 13..H    JSON envelope header (plaintext):
               { formatVersion, alg:"AES-256-GCM", keyVersion,
                 wrappedDek, wrappedIv, wrappedTag, payloadIv, createdAt }
then..end-16   AES-256-GCM ciphertext of gzip( tar )
last 16        GCM authentication tag
```

- **Envelope encryption**: every package gets a random 32-byte DEK; the DEK
  is wrapped with the master key derived from `BACKUP_ENCRYPTION_KEY`
  (sha-256). Rotating the master key later only requires re-writing headers
  (`keyVersion` records which key wrapped the DEK) — payloads never need
  re-encryption. The wrapped DEK is stored ONLY in the `business_backups`
  row; losing the row or the master key makes the package unreadable.
- **Tar entries** (written in this order, manifest LAST so its checksum
  table covers everything):
  - `metadata.json` — export context
  - `data/_profile.json` — the `businesses` row minus `slug`/`status` (and
    audit timestamps); applied on full/new-business restore only
  - `data/<table>.json` — row arrays keyed by ORM property names, in
    restore-dependency order
  - `attachments/expenses|storefront/<uuid>.<ext>` — attachment bytes from
    object storage
  - `manifest.json` — version, identity, counts, per-file sha256, warnings,
    `completion:"complete"`
- **Readers verify everything**: magic, header, GCM tag (tamper fails
  loudly), entry-name allow-list, entry count and uncompressed-size caps,
  manifest checksums for every data/attachment entry, and no unexpected
  extras.

## Module registry (`backupModules.ts`)

~95 business tables grouped in restore order: configuration → catalog →
contacts → purchasing → sales → inventory → expenses → operations →
channels → storefront → engagement. The `businesses` profile row rides
alongside as `_profile`.

**Excluded entirely** (platform state / secrets): users, memberships,
invitations, roles, role_permissions, user_roles, user_location_assignments,
permissions, subscription_plans/subscriptions/subscription_payments/
subscription_events, saas_invoices, saas_admin_audit, refresh/reset/verify
tokens, support tickets, integration_credentials, payment_provider_configs,
pos_terminals, terminal_pairing_codes, hardware_commands, shopper_sessions,
notification_reads/prefs, storefront_domains (global-unique, platform-managed).

**Stripped columns** (`exportExclude` + `preserveOnRestore`): webhook
signing secrets, storefront API-key hashes, shopper password hashes.

**Generated columns** excluded from export/restore: `purchase_items.total`,
`purchase_return_items.line_total`, `inventory_batches.landed_cost_per_unit`.

**Scoping rule**: every table either carries `business_id` or is in
`PARENT_SCOPED_TABLES` (product_taxes→products, variant_values→
product_variants, storefront children→storefronts). A table with no
resolvable scope is refused — the engine never falls back to "all rows"
(this was a real cross-tenant bug the test suite caught pre-merge).

## Backup pipeline (phases F–H)

1. `POST /api/backups` inserts a `pending` row (partial unique index
   `business_backups_one_active_uq` blocks concurrent duplicates) and fires
   the job.
2. The job builds the package streamed to a temp file (tar-stream → gzip →
   AES-GCM → sha256 tap), **re-reads it** for verification, uploads it
   (presigned PUT to the dedicated private `S3_BACKUP_BUCKET`), then marks
   the row `completed` with size/sha/manifest/envelope.
3. Object storage not configured → documented local-fallback mode: manual
   backups work (stored under `os.tmpdir()/ezpos-backups/`, streamed through
   the authenticated download endpoint); **scheduled backups and uploads are
   disabled** — they must never depend on ephemeral server disk.
4. Scheduler sweep (`runBackupSweeps`, SKIP LOCKED claimed, hourly): due
   schedules (tz-aware `next_run_at`) each start one `scheduled` backup.
5. Retention sweep: deletes completed manual/scheduled backups past the
   per-business retention window, never the newest completed; uploads expire
   after 24 h; safety/pre_restore copies are never auto-deleted.

## Restore pipeline (phases I–J)

`preview → confirm("RESTORE") → job → validating → running → verifying →
completed | failed`

- **preview** (also enforced before execute): format/completion checks,
  business-identity gate, full-coverage gate (a partial package can never
  run as full restore), dependency closure for selective, newer-data and
  rename warnings.
- **full mode**: mandatory `pre_restore` safety backup first (aborts if it
  fails — nothing is touched). Applies `_profile` then each group in
  dependency order via **upsert-by-id diff-merge**: `INSERT … ON CONFLICT
  (id) DO UPDATE` (preserveOnRestore columns skipped), rows absent from the
  package deleted — `locations` deletion skipped entirely (cascades staff
  location assignments), FK-protected rows (e.g. variants still referenced
  by newer sales via RESTRICT) are kept and reported. Stripped-sensitive
  columns keep their live values on existing rows.
- **new_business mode**: creates the business via the standard
  `createBusinessForUser` (owner = restorer; trial/subscription handled by
  normal platform rules), then inserts every package row WITHOUT its
  original id, remapping all FKs through live `information_schema`
  introspection (always in sync with migrations), polymorphic references by
  convention table, gift cards **re-minted** (codes hashed — originals
  belong to the source business), storefront forced to `draft` with a
  mangled unique subdomain, storefront API keys skipped, order-payment
  idempotency keys suffixed.
- **selective mode**: subset of groups with dependency closure; upsert only
  — never deletes outside the selection.
- **verification** (before `completed`): per-table counts vs manifest,
  orphan sweeps (coupon_redemptions, register_transactions,
  customer_credits, inventory_movements → sales), serial sequence `setval`
  (full/selective), attachment HEAD checks + re-upload of missing objects
  from the package. The report (counts, mismatches, kept rows, warnings) is
  stored on the job and shown in the UI.

## Offline integration (Phase K)

The only unrecoverable device data is the IndexedDB `outbox` (pending/failed
offline sales). The restore dialog refuses to run while `pendingCount > 0`
and the settings page offers a one-click JSON export of the outbox. Catalog
carts/caches are regenerable; sync state is inspected via the existing
`listOutbox()` API.
