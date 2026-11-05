# Security Review — Backup & Restore

## Controls implemented

1. **Encryption at rest**: AES-256-GCM envelope (random per-backup DEK,
   master key from `BACKUP_ENCRYPTION_KEY`, `keyVersion` for rotation).
   Auth-tag verification on every read — bit-flips and truncation fail
   loudly (tested). The wrapped DEK lives only in the `business_backups`
   row; the master key only in env.
2. **Tenant isolation**: every route requires membership-checked business
   context (`requireBusinessContext`); all queries filter by that id; the
   restore identity gate refuses packages from another business (404 on
   cross-business access, tested for get/verify/delete/download/preview).
3. **No public storage**: packages live in the dedicated `S3_BACKUP_BUCKET`
   (must have no anonymous policy — see DEPLOYMENT), served only through
   authenticated streams or 10-minute presigned GETs minted after permission
   checks. Never via the public CDN host.
4. **Upload hardening**: presign-PUT-register flow (no multipart parser),
   `.ezbackup` extension enforcement, size cap (`BACKUP_MAX_UPLOAD_MB`,
   default 200 MB), key-prefix ownership check, immediate integrity parse on
   register (bad packages deleted), 24 h upload TTL.
5. **Archive hardening**: entry-name allow-list (no absolute paths, no
   `..`), max 5 000 entries, 2 GiB uncompressed guard, GCM auth before any
   entry is used, manifest checksum verification for every entry, no
   unexpected extras. We only ever read our own format — no third-party
   archive extractor is exposed to attacker-controlled trees.
6. **Destructive-action gates**: typed `confirm:"RESTORE"`, preview checks
   must pass in the same request flow, mandatory verified pre-restore safety
   backup, restore refuses while another restore runs, concurrent duplicate
   backups blocked by a partial unique index.
7. **Least privilege**: `backups.restore` is absent from every staff role
   template; owner wildcard is the only path. Cashier access is 403 (tested).
8. **Rate limits + audit**: mutations 30/h, downloads 60/h per user; every
   backup/restore/delete/schedule change writes `audit_log`.
9. **Sensitive data never exported**: webhook secrets, storefront API-key
   hashes, shopper password hashes stripped; credential tables excluded;
   restore preserves live secret values on existing rows.

## Pre-existing risks this program touches (flagged, not introduced)

- `integrations.webhook_secret` is stored PLAINTEXT (pre-existing). It is
  excluded from packages and preserved on same-business restore, but it
  remains plaintext at rest — worth fixing platform-wide.
- `BACKUP_ENCRYPTION_KEY` has a deterministic dev fallback like
  `INTEGRATION_ENCRYPTION_KEY`; production validation refuses to run without
  it only in the sense that encryption/decryption throws — set it explicitly
  in production (DEPLOYMENT checklist).
- Rate limiting remains in-process (single-instance stance, documented in
  `rateLimit.ts`); the backup sweeps are SKIP LOCKED-safe if a second
  instance appears, but the scheduler itself is single-instance.
- The encryption `keyVersion` mechanism is implemented for backups; the
  legacy `INTEGRATION_ENCRYPTION_KEY` path still hardcodes version 1.

## Residual risks (accepted, documented in KNOWN_LIMITATIONS)

- A compromised owner account can export the business's own data — by
  design (it is their data; credentials are excluded).
- Restore into a new business with a stripped-shopper password hash means
  those shopper accounts cannot sign in until re-issued credentials.
- Verification detects corruption/tamper, but cannot distinguish a
  maliciously re-signed package from an operator-made one (a person with the
  master key is inside the trust boundary by definition).
