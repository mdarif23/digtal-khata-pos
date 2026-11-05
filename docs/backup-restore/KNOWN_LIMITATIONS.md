# Known Limitations — Backup & Restore

Honest list of what this program deliberately does NOT do.

1. **Product/variant images are URLs, not bytes.** The platform has no
   product-image upload pipeline (images are client-supplied URL strings),
   so packages carry the URLs only. Expense-attachment and storefront-media
   BYTES are included. Business logos ride in the package (inline data URLs).
2. **Scheduled backups require object storage.** Without S3 credentials the
   sweep is a documented no-op — scheduled backups never depend on ephemeral
   server disk. Manual backups use a server-local fallback and are lost if
   that disk is wiped; the UI says so.
3. **Storage-limit notifications are not implemented.** There is no quota
   concept on MinIO/R2 yet, so there is nothing to approach. The retention
   cleanup notifications ship as audit entries instead.
4. **Restore does not merge concurrent writes.** A full restore reverts the
   business to the package state; rows created after the backup that can be
   deleted are deleted, and FK-protected rows are kept (reported). There is
   no three-way merge — that is what the pre-restore safety backup is for.
5. **No PITR / cross-business point-in-time.** Platform-level pg_dump/PITR
   is an ops runbook, not a product feature (and is never exposed to
   businesses).
6. **Single-instance scheduler.** Sweeps are SKIP LOCKED-safe but the
   hourly scheduler remains in-process (pre-existing architecture); before
   horizontal scaling, move to a dedicated worker (as documented in
   `scheduler.ts`).
7. **Verification is count/orphan based.** Financial deep-checks (recomputed
   COGS, batch-vs-stock reconciliation) report counts and orphan references,
   not full accounting re-derivation. Mismatches are surfaced, not auto-fixed.
8. **document_sequences are restored as-is** — after a full restore the
   next invoice/PO/SKU numbers are the package's values. If newer sales were
   kept (FK-protected), their numbers may exceed `next_value`; the platform
   numbering allocator tolerates gaps but a duplicate number is theoretically
   possible in that edge (reported in the restore result).
9. **Shoppers restored into a new business cannot sign in** (password hashes
   stripped by design; sessions excluded).
10. **Uploaded packages from OTHER ezPos businesses** can be restored into
    a NEW business (deliberate — that is the migration path), but never into
    an existing different business (identity gate).
11. **No CSV/Excel export changed** — the reserved `PlanFeatures.exports`
    flag remains unwired; backups are not plan-gated in this version
    (decision recorded in the approved proposal).
12. **Rate limits are in-memory** (pre-existing stance) — restarts reset
    them; multi-instance needs a shared store.
