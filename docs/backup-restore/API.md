# Backup & Restore — API

All endpoints require `Authorization: Bearer <access token>` and the
`X-Business-Id` tenant header (verified against an active membership — the
header is a hint, never proof). Errors use the platform shape
`{ success: false, message, code? }`. Permission keys: `backups.view`,
`backups.create`, `backups.download`, `backups.verify`, `backups.delete`,
`backups.restore` (restore is owner-tier: staff role templates never include
it; only the owner wildcard reaches it).

Rate limits (keyed by user): mutations 30/hour (`backupMutationRateLimit`),
download link/stream 60/hour.

| Method & path | Permission | Notes |
|---|---|---|
| `GET /api/backups/modules` | backups.view | Module groups + whether object storage is enabled |
| `POST /api/backups` | backups.create | `{modules?: string[]}` — starts async job, `202 {data: backupRow}`; 409 if a backup is already in flight |
| `GET /api/backups` | backups.view | `page`, `pageSize`, `type`, `status` — server-paginated history |
| `GET /api/backups/:id` | backups.view | Row incl. manifest snapshot |
| `POST /api/backups/:id/verify` | backups.verify | Re-reads the archive: size, sha256, manifest checksums. `200 {verified, manifest}` — failures notify in-app |
| `DELETE /api/backups/:id` | backups.delete | Retention rules: refuses in-flight jobs and the last completed backup; deletes the object; audited |
| `GET /api/backups/:id/download-url` | backups.download | `{url, expiresIn}` short-lived presigned GET (object storage only; 409 for local fallback — use the stream) |
| `GET /api/backups/:id/download` | backups.download | Authenticated stream (`application/octet-stream`) — works for both storage modes |
| `POST /api/backups/upload/presign` | backups.create | `{storageKey, uploadUrl, maxMb}` — PUT the file directly to the private bucket |
| `POST /api/backups/upload/register` | backups.create | `{storageKey, fileName}` — verifies size cap + integrity, records an `upload` row; bad packages are deleted from storage |
| `POST /api/backups/restore/preview` | backups.restore | `{backupId, mode, modules?}` — checks + warnings + counts; **no writes** |
| `POST /api/backups/restore` | backups.restore | `{backupId, mode, modules?, confirm:"RESTORE"}` — refuses unless the preview checks pass; `202 {data: restoreJob}` |
| `GET /api/backups/restore/:id` | backups.view | Job status/stage/progress/result report |
| `GET /api/backups/schedule` | backups.view | `{schedule, storageEnabled}` |
| `PUT /api/backups/schedule` | backups.create | `{enabled, frequency, hour, dayOfWeek?, retentionDays}` |

### Restore modes

- `full` — same business only; requires a package containing every module;
  takes a `pre_restore` safety backup before changing anything.
- `new_business` — package may originate from any business the user can
  access (they uploaded it); creates a fresh business owned by the caller.
- `selective` — module subset; dependencies auto-included (and reported).

### Notifications (in-app, deduped per day)

`backup` — completed / failed / verification failed. `restore` — completed
(with mismatch count) / failed. Never contains download links — packages are
downloaded only through authenticated endpoints or short-lived presigned
URLs the user clicks for themselves.

### Audit trail (audit_log)

`backup.manual.completed`, `backup.scheduled.completed`, `backup.*.failed`,
`backup.deleted`, `backup.retention.deleted`, `backup.uploaded`,
`backup.schedule.updated`, `restore.completed`, `restore.failed`.
