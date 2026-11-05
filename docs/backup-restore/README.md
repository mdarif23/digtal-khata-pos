# ezPos Backup & Restore

Commercial backup & restore for individual businesses: encrypted
`.ezbackup` packages, manual + scheduled backups, upload/download,
integrity verification, and safe restore (full / new-business / selective).

Program delivered 2026-11-05 on branch `feature/backup-restor`.
Backend: `ezPosBackend/src/modules/backups/`. Frontend: `/settings/backup`
(`pos/src/features/backups/`). Migration: `0047_backup_restore` (additive —
three tables + five enum types; no existing table was altered).

## What business owners get

| Capability | Where |
|---|---|
| Manual backup (optionally module-scoped) | Settings → Backup & Restore → **Back up now** |
| Automatic daily/weekly schedule | **Automatic backups** card (default: daily at 02:00 business timezone, 30-day retention) |
| Download `.ezbackup` | History row → **Download** (authenticated stream, works for object storage and local fallback) |
| Upload a `.ezbackup` | **Upload package** (integrity-checked on registration; failed checks are rejected and deleted) |
| Verify integrity any time | Details dialog → **Verify** (re-reads the stored archive, checksums every entry) |
| Restore with preview + confirmation | **Restore** → mode → preview (checks/warnings) → type `RESTORE` → progress → verification report |
| Offline safety | Restore is blocked while the device holds unsynced offline sales; one-click **export unsynced sales (JSON)** |

## Guaranteed invariants

1. **Never claims success before verification.** A backup row becomes
   `completed` only after the archive is written, checksummed, re-read
   (decrypt + per-entry sha256) and the manifest is `completion:"complete"`.
2. **Tenant isolation.** Every endpoint re-derives the business from the
   membership-checked context; a package whose `manifest.businessId` differs
   from the caller's business is refused for full/selective restore.
3. **Never destroys platform state.** Users, memberships, roles, role
   assignments, invitations, subscriptions, SaaS billing, support tickets and
   credential tables are never exported and never restored. Full restore
   upserts rows by id instead of delete-all + reinsert, so FK-referenced
   platform state (e.g. staff location assignments) survives.
4. **Last known-good protection.** The newest completed backup of a business
   cannot be deleted. `pre_restore`/`safety` copies are exempt from automatic
   retention cleanup.
5. **Credentials never leave.** Webhook signing secrets, storefront API-key
   hashes and shopper password hashes are stripped from packages and
   preserved on same-business restore (rows may be restored, secrets stay).

## Quick reference

- Package format & restore pipeline: [ARCHITECTURE.md](ARCHITECTURE.md)
- Endpoints: [API.md](API.md)
- Security controls & open items: [SECURITY_REVIEW.md](SECURITY_REVIEW.md)
- Honest limitations: [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)
- Deployment checklist: [DEPLOYMENT.md](DEPLOYMENT.md)
- Test results: [TEST_REPORT.md](TEST_REPORT.md)
