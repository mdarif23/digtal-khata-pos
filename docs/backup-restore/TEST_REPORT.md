# Test Report — Backup & Restore (2026-11-05)

## Backend

- **New suite** `src/test/backups.integration.test.ts` — **18/18 green**:
  - manual backup completes with verified manifest (counts, profile,
    encryption metadata, read-back verification before `completed`)
  - concurrent duplicate backup → 409
  - verify endpoint re-checks integrity
  - download streams the encrypted package (`EZBACKUP1` magic asserted)
  - download-url refuses local-fallback storage
  - **tamper rejection** (byte-flipped stored package fails verification)
  - tenant isolation across get/verify/delete/download (404s)
  - restore refuses without typed `RESTORE` confirmation (400)
  - preview reports ready-for-restore
  - **full restore reverts later mutations** — safety backup taken, count
    report matches manifest exactly, row absent from the package deleted
  - selective restore upserts without deleting newer rows
  - cross-business restore blocked by identity check
  - last known-good backup cannot be deleted
  - schedule save/load round-trip (daily + weekly)
  - sweep is a no-op without object storage
  - cashier role → 403
- **Full backend regression: 611 pass / 0 fail** (95 suites, 612 tests incl.
  the previously failing pre-existing suites). `tsc --noEmit` clean.
- Unit-level smoke (in-session): package build → read-back → tamper detect
  round-trip against real data in `ezpos_test`.

## Frontend (`pos/`)

- **New suite** `BackupSettingsPage.test.tsx` — 4/4: history rows + actions,
  empty state, backup-now dialog start flow, details dialog with record
  counts + verify action.
- **Full pos suite: 157/157** (24 files), `tsc --noEmit` clean (only the
  pre-existing tsconfig `baseUrl` deprecation notice), `vite build` green.

## Bugs the tests caught before merge (kept as regressions)

1. Cross-tenant scope leak: tables without `business_id` (storefront
   children, product_taxes, variant_values) were exported/counted
   business-wide and upserted cross-tenant on restore → now hard-scoped via
   `PARENT_SCOPED_TABLES`, unscoped tables refused.
2. Envelope prelude was never written to the output stream.
3. Decryptor held back plaintext instead of the 16-byte ciphertext auth tag.
4. `manifest.json` was written first, so its checksum table could not cover
   the package → manifest now written last; post-hoc verification for every
   entry + no-unexpected-extras rule.
5. JSON ISO strings broke drizzle timestamp inserts → `coerceRowValues`.
6. Zod validation failures surfaced as 500s → now 400.
