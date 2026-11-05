import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { backupSchedules, businessBackups } from "../../db/schema/backups.js";
import { businesses } from "../../db/schema/businesses.js";
import { env } from "../../config/env.js";
import { ConflictError, NotFoundError } from "../../utils/handleError.js";
import { recordAudit } from "../../services/audit.js";
import { notifyInTx } from "../../services/notifications.js";
import { publishRealtime } from "../realtime/realtime.service.js";
import { ALL_MODULE_KEYS } from "./backupModules.js";
import { buildBackupPackage, readBackupPackage, type BackupManifest } from "./backupPackage.js";
import {
  backupStorageEnabled,
  deletePackageObject,
  fetchPackageFile,
  headPackage,
  presignPackageDownload,
  storePackageFile,
} from "./backupStorage.js";

type BackupRow = typeof businessBackups.$inferSelect;

const UPLOAD_RETENTION_HOURS = 24;

function tmpPackagePath(tag: string): string {
  return path.join(tmpdir(), `ezpos-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
}

async function cleanupFile(filePath: string | null | undefined): Promise<void> {
  if (filePath) await unlink(filePath).catch(() => {});
}

/** Validates/normalizes a module selection (null = all modules). */
export function normalizeModuleKeys(
  input: unknown,
): string[] | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) throw new ConflictError("modules must be an array.");
  const keys = input.map(String);
  const unknown = keys.filter((k) => !ALL_MODULE_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ConflictError(`Unknown backup modules: ${unknown.join(", ")}`);
  }
  if (keys.length === 0) return null;
  return [...new Set(keys)];
}

// ---------------------------------------------------------------------------
// Backup job
// ---------------------------------------------------------------------------

export async function getActiveBackup(
  businessId: number,
): Promise<BackupRow | undefined> {
  const [row] = await db
    .select()
    .from(businessBackups)
    .where(
      and(
        eq(businessBackups.businessId, businessId),
        inArray(businessBackups.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Creates a backup row and starts the job in the background. Concurrent
 * duplicates are rejected by the partial unique index (and checked here for
 * a friendlier 409). Returns immediately — the row is the progress handle.
 */
export async function requestBackup(input: {
  businessId: number;
  userId: number | null;
  type: "manual" | "scheduled" | "safety" | "pre_restore";
  moduleKeys?: string[] | null;
}): Promise<BackupRow> {
  const active = await getActiveBackup(input.businessId);
  if (active) {
    throw new ConflictError(
      "A backup is already running for this business. Wait for it to finish.",
    );
  }
  const moduleKeys = normalizeModuleKeys(input.moduleKeys);
  const inserted = await db
    .insert(businessBackups)
    .values({
      businessId: input.businessId,
      type: input.type,
      status: "pending",
      moduleSelection: moduleKeys,
      triggeredBy: input.userId,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new ConflictError("Could not create the backup job.");
  void runBackupJob(row.id).catch((err) => {
    console.error(`Backup job ${row.id} crashed:`, err);
  });
  return row;
}

/**
 * Runs a backup job to completion: builds the package, stores it, verifies
 * it by reading it back, and only THEN marks it completed (prompt rule:
 * never claim success before integrity verification).
 */
export async function runBackupJob(backupId: number): Promise<BackupRow> {
  const [row] = await db
    .select()
    .from(businessBackups)
    .where(eq(businessBackups.id, backupId))
    .limit(1);
  if (!row) throw new NotFoundError("Backup not found.");
  if (row.status !== "pending") return row;

  await db
    .update(businessBackups)
    .set({ status: "running", error: null, updatedAt: new Date() })
    .where(eq(businessBackups.id, backupId));
  publishRealtime(row.businessId, null, {
    kind: "backup.progress",
    backupId,
    status: "running",
  });

  const filePath = tmpPackagePath(`backup-${backupId}`);
  try {
    const moduleKeys =
      (row.moduleSelection as string[] | null) ?? ALL_MODULE_KEYS;
    const built = await buildBackupPackage({
      businessId: row.businessId,
      type: row.type,
      moduleKeys,
      filePath,
    });

    // Read-back verification BEFORE declaring success: re-parse the archive
    // (decrypt + checksums) without materializing row data.
    const parsed = await readBackupPackage(filePath);
    if (parsed.manifest.completion !== "complete") {
      throw new Error("Read-back verification failed: incomplete package.");
    }

    const stored = await storePackageFile(row.businessId, filePath);
    await cleanupFile(filePath);

    const completedRows = await db
      .update(businessBackups)
      .set({
        status: "completed",
        storageKey: stored.storageKey,
        fileName: built.fileName,
        fileSize: stored.size,
        sha256: built.sha256,
        manifest: built.manifest,
        encryption: built.envelope.header,
        verifiedAt: new Date(),
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(businessBackups.id, backupId))
      .returning();
    const completed = completedRows[0];
    if (!completed) throw new Error("Backup completion could not be recorded.");

    publishRealtime(row.businessId, null, {
      kind: "backup.progress",
      backupId,
      status: "completed",
    });
    await notifyInTx(db, {
      businessId: row.businessId,
      kind: "backup",
      severity: "info",
      title: "Backup completed",
      body: `${built.fileName} (${(stored.size / 1024 / 1024).toFixed(1)} MB) is ready.`,
      payload: { backupId },
    });
    await recordAudit({
      businessId: row.businessId,
      actorUserId: row.triggeredBy,
      action: `backup.${row.type}.completed`,
      entityType: "backup",
      entityId: backupId,
      metadata: { size: stored.size, modules: built.manifest.modules },
    });
    return completed;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backup failed.";
    await cleanupFile(filePath);
    await db
      .update(businessBackups)
      .set({ status: "failed", error: message, updatedAt: new Date() })
      .where(eq(businessBackups.id, backupId))
      .catch(() => {});
    publishRealtime(row.businessId, null, {
      kind: "backup.progress",
      backupId,
      status: "failed",
    });
    await notifyInTx(db, {
      businessId: row.businessId,
      kind: "backup",
      severity: "critical",
      title: "Backup failed",
      body: message,
      payload: { backupId },
    }).catch(() => {});
    await recordAudit({
      businessId: row.businessId,
      actorUserId: row.triggeredBy,
      action: `backup.${row.type}.failed`,
      entityType: "backup",
      entityId: backupId,
      metadata: { error: message.slice(0, 300) },
    }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// History / CRUD
// ---------------------------------------------------------------------------

export async function listBackups(
  businessId: number,
  opts: {
    page: number;
    pageSize: number;
    type?: string | undefined;
    status?: string | undefined;
  },
): Promise<{ items: BackupRow[]; total: number }> {
  const conditions = [eq(businessBackups.businessId, businessId)];
  if (opts.type) {
    conditions.push(sql`${businessBackups.type} = ${opts.type}`);
  }
  if (opts.status) {
    conditions.push(sql`${businessBackups.status} = ${opts.status}`);
  }
  const where = and(...conditions);
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(businessBackups)
    .where(where);
  const count = countRow?.count ?? 0;
  const items = await db
    .select()
    .from(businessBackups)
    .where(where)
    .orderBy(desc(businessBackups.createdAt))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  return { items, total: Number(count) };
}

export async function getBackup(
  businessId: number,
  id: number,
): Promise<BackupRow> {
  const [row] = await db
    .select()
    .from(businessBackups)
    .where(
      and(
        eq(businessBackups.id, id),
        eq(businessBackups.businessId, businessId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Backup not found.");
  return row;
}

/** Re-verifies a stored package: object exists, sha256 matches, manifest
 * checksums pass. Failures notify — a backup that silently rots is worse
 * than a loud one. */
export async function verifyBackup(
  businessId: number,
  id: number,
): Promise<{ verified: boolean; manifest: BackupManifest | null; error?: string }> {
  const row = await getBackup(businessId, id);
  if (row.status !== "completed" || !row.storageKey) {
    throw new ConflictError("Only completed backups can be verified.");
  }
  try {
    const head = await headPackage(row.storageKey);
    if (!head.exists) throw new Error("Stored package is missing from storage.");
    if (row.fileSize && head.size !== null && head.size !== row.fileSize) {
      throw new Error(
        `Stored package size changed (expected ${row.fileSize}, found ${head.size}).`,
      );
    }
    const filePath = tmpPackagePath(`verify-${id}`);
    try {
      await fetchPackageFile(row.storageKey, filePath);
      const actual = await sha256File(filePath);
      if (row.sha256 && actual !== row.sha256) {
        throw new Error("Package checksum does not match the recorded sha256.");
      }
      const parsed = await readBackupPackage(filePath);
      await db
        .update(businessBackups)
        .set({ verifiedAt: new Date(), error: null, updatedAt: new Date() })
        .where(eq(businessBackups.id, id));
      return { verified: true, manifest: parsed.manifest };
    } finally {
      await cleanupFile(filePath);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed.";
    await db
      .update(businessBackups)
      .set({ error: `Verification failed: ${message}`, updatedAt: new Date() })
      .where(eq(businessBackups.id, id))
      .catch(() => {});
    await notifyInTx(db, {
      businessId,
      kind: "backup",
      severity: "critical",
      title: "Backup verification failed",
      body: `Backup #${id}: ${message}`,
      payload: { backupId: id },
    }).catch(() => {});
    return { verified: false, manifest: null, error: message };
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (c: Buffer) => hash.update(c));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * Deletion with retention rules: never the only completed backup (last
 * known-good protection), never an in-flight job, always audited.
 */
export async function deleteBackup(
  businessId: number,
  id: number,
  userId: number | null,
): Promise<void> {
  const row = await getBackup(businessId, id);
  if (row.status === "pending" || row.status === "running") {
    throw new ConflictError("Cannot delete a backup while it is being created.");
  }
  if (row.status === "deleted") return;
  if (row.status === "completed") {
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(businessBackups)
      .where(
        and(
          eq(businessBackups.businessId, businessId),
          eq(businessBackups.status, "completed"),
        ),
      );
    const count = countRow?.count ?? 0;
    if (Number(count) <= 1) {
      throw new ConflictError(
        "This is the last known-good backup — create a new backup before deleting it.",
      );
    }
  }
  if (row.storageKey) {
    await deletePackageObject(row.storageKey).catch((err) => {
      console.error(`Failed to delete backup object ${row.storageKey}:`, err);
    });
  }
  await db
    .update(businessBackups)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(eq(businessBackups.id, id));
  await recordAudit({
    businessId,
    actorUserId: userId,
    action: "backup.deleted",
    entityType: "backup",
    entityId: id,
    metadata: { type: row.type, fileName: row.fileName },
  });
}

/** Short-lived presigned download URL (remote storage only). */
export function getDownloadUrl(row: BackupRow): string {
  if (!row.storageKey) throw new ConflictError("Backup has no stored package.");
  if (row.storageKey.startsWith("local:")) {
    throw new ConflictError(
      "This backup is stored in server-local fallback storage — use the streaming download endpoint.",
    );
  }
  return presignPackageDownload(row.storageKey);
}

export async function openPackageStream(
  row: BackupRow,
): Promise<{ stream: Readable; fileName: string; size: number | null }> {
  if (!row.storageKey) throw new ConflictError("Backup has no stored package.");
  if (row.storageKey.startsWith("local:")) {
    const p = row.storageKey.slice("local:".length);
    const filePath = path.join(tmpdir(), "ezpos-backups", p);
    const s = await stat(filePath);
    return {
      stream: createReadStream(filePath),
      fileName: row.fileName ?? p,
      size: s.size,
    };
  }
  const filePath = tmpPackagePath(`download-${row.id}`);
  await fetchPackageFile(row.storageKey, filePath);
  const s = await stat(filePath);
  const stream = createReadStream(filePath);
  // Eager cleanup once streamed out.
  stream.on("close", () => cleanupFile(filePath).catch(() => {}));
  return { stream, fileName: row.fileName ?? `backup-${row.id}.ezbackup`, size: s.size };
}

// ---------------------------------------------------------------------------
// Upload (.ezbackup) flow
// ---------------------------------------------------------------------------

export async function registerUploadedPackage(input: {
  businessId: number;
  userId: number;
  storageKey: string;
  fileName: string;
}): Promise<BackupRow> {
  const active = await getActiveBackup(input.businessId);
  void active; // uploads don't conflict with running backups
  const filePath = tmpPackagePath(`upload-${Date.now()}`);
  try {
    await fetchPackageFile(input.storageKey, filePath);
    const size = (await stat(filePath)).size;
    const maxBytes = env.backupMaxUploadMb * 1024 * 1024;
    if (size > maxBytes) {
      throw new ConflictError(
        `Package exceeds the ${env.backupMaxUploadMb} MB upload limit.`,
      );
    }
    const sha = await sha256File(filePath);
    const parsed = await readBackupPackage(filePath);
    const manifest = parsed.manifest as BackupManifest;
    const uploadRows = await db
      .insert(businessBackups)
      .values({
        businessId: input.businessId,
        type: "upload",
        status: "completed",
        storageKey: input.storageKey,
        fileName: input.fileName,
        fileSize: size,
        sha256: sha,
        manifest,
        verifiedAt: new Date(),
        triggeredBy: input.userId,
        expiresAt: new Date(Date.now() + UPLOAD_RETENTION_HOURS * 3600 * 1000),
      })
      .returning();
    const uploadRow = uploadRows[0];
    if (!uploadRow) throw new ConflictError("Could not register the uploaded package.");
    await recordAudit({
      businessId: input.businessId,
      actorUserId: input.userId,
      action: "backup.uploaded",
      entityType: "backup",
      entityId: uploadRow.id,
      metadata: { fileName: input.fileName, sourceBusinessId: manifest.businessId },
    });
    return uploadRow;
  } catch (err) {
    await deletePackageObject(input.storageKey).catch(() => {});
    throw err;
  } finally {
    await cleanupFile(filePath);
  }
}

// ---------------------------------------------------------------------------
// Schedule (Phase G)
// ---------------------------------------------------------------------------

export interface ScheduleInput {
  enabled: boolean;
  frequency: "daily" | "weekly";
  hour: number;
  dayOfWeek?: number | null;
  retentionDays: number;
}

function timezoneOffsetMs(timeZone: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

/** Next due instant for a schedule, computed in the business timezone. */
export function computeNextRun(
  input: ScheduleInput,
  from: Date,
  timeZone: string | null,
): Date {
  const tz = timeZone || "UTC";
  const step = (instant: Date): Date => {
    const local = new Date(instant.getTime() + timezoneOffsetMs(tz, instant));
    const candidate = new Date(local);
    candidate.setUTCHours(input.hour, 0, 0, 0);
    if (input.frequency === "weekly" && input.dayOfWeek !== null && input.dayOfWeek !== undefined) {
      const dow = candidate.getUTCDay();
      let delta = (input.dayOfWeek - dow + 7) % 7;
      if (delta === 0 && candidate.getTime() <= local.getTime()) delta = 7;
      candidate.setUTCDate(candidate.getUTCDate() + delta);
    } else if (candidate.getTime() <= local.getTime()) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    // Convert the wall-clock candidate back to a UTC instant.
    const ts = candidate.getTime() - timezoneOffsetMs(tz, new Date(candidate.getTime()));
    return new Date(ts);
  };
  let next = step(from);
  // Two-pass correction for DST edges: recompute once from the candidate.
  next = step(new Date(next.getTime() - 60 * 1000));
  return next;
}

export async function getSchedule(businessId: number) {
  const [row] = await db
    .select()
    .from(backupSchedules)
    .where(eq(backupSchedules.businessId, businessId))
    .limit(1);
  return row ?? null;
}

export async function upsertSchedule(
  businessId: number,
  userId: number | null,
  input: ScheduleInput,
): Promise<typeof backupSchedules.$inferSelect> {
  const [business] = await db
    .select({ timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const nextRunAt = input.enabled
    ? computeNextRun(input, new Date(), business?.timezone ?? null)
    : null;
  const rowRows = await db
    .insert(backupSchedules)
    .values({
      businessId,
      enabled: input.enabled,
      frequency: input.frequency,
      hour: input.hour,
      dayOfWeek: input.frequency === "weekly" ? (input.dayOfWeek ?? 0) : null,
      retentionDays: input.retentionDays,
      nextRunAt,
    })
    .onConflictDoUpdate({
      target: backupSchedules.businessId,
      set: {
        enabled: input.enabled,
        frequency: input.frequency,
        hour: input.hour,
        dayOfWeek: input.frequency === "weekly" ? (input.dayOfWeek ?? 0) : null,
        retentionDays: input.retentionDays,
        nextRunAt,
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = rowRows[0];
  if (!row) throw new ConflictError("Could not save the backup schedule.");
  await recordAudit({
    businessId,
    actorUserId: userId,
    action: "backup.schedule.updated",
    entityType: "backup_schedule",
    entityId: row.id,
    metadata: { ...input },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Sweeps (Phases G + H): scheduled backups + retention cleanup
// ---------------------------------------------------------------------------

export interface BackupSweepResult {
  backupsStarted: number;
  schedulesSkipped: number;
  expiredDeleted: number;
}

/**
 * Claims due schedules with FOR UPDATE SKIP LOCKED (the codebase's sweep
 * convention — safe if a second instance ever appears) and starts one
 * backup per due business. Idempotent per due-window: lastRunAt/nextRunAt
 * only advance after the backup is requested.
 */
export async function runBackupSweeps(): Promise<BackupSweepResult> {
  const result: BackupSweepResult = {
    backupsStarted: 0,
    schedulesSkipped: 0,
    expiredDeleted: 0,
  };
  if (!backupStorageEnabled()) {
    // Local-fallback mode: scheduled backups are deliberately disabled —
    // they must never depend on ephemeral server disk.
    return result;
  }
  const now = new Date();
  const due = await db
    .select()
    .from(backupSchedules)
    .where(
      and(
        eq(backupSchedules.enabled, true),
        sql`(${backupSchedules.nextRunAt} IS NULL OR ${backupSchedules.nextRunAt} <= ${now})`,
      ),
    )
    .for("update", { skipLocked: true })
    .limit(50);

  for (const schedule of due) {
    try {
      const active = await getActiveBackup(schedule.businessId);
      if (active) {
        result.schedulesSkipped++;
      } else {
        await requestBackup({
          businessId: schedule.businessId,
          userId: null,
          type: "scheduled",
        });
        result.backupsStarted++;
      }
    } catch (err) {
      result.schedulesSkipped++;
      console.error(
        `Scheduled backup for business ${schedule.businessId} failed to start:`,
        err,
      );
    }
    const [business] = await db
      .select({ timezone: businesses.timezone })
      .from(businesses)
      .where(eq(businesses.id, schedule.businessId))
      .limit(1);
    const nextRunAt = computeNextRun(
      {
        enabled: true,
        frequency: schedule.frequency,
        hour: schedule.hour,
        dayOfWeek: schedule.dayOfWeek,
        retentionDays: schedule.retentionDays,
      },
      now,
      business?.timezone ?? null,
    );
    await db
      .update(backupSchedules)
      .set({ lastRunAt: now, nextRunAt, updatedAt: now })
      .where(eq(backupSchedules.id, schedule.id));
  }
  result.expiredDeleted = await sweepRetention();
  return result;
}

/**
 * Retention cleanup (Phase H): deletes expired scheduled/manual/upload
 * packages, never the newest completed backup of a business, and never
 * safety/pre_restore copies (those stay until deleted explicitly).
 */
export async function sweepRetention(): Promise<number> {
  let deleted = 0;
  // Expired uploads first (24h TTL).
  const expiredUploads = await db
    .select()
    .from(businessBackups)
    .where(
      and(
        eq(businessBackups.type, "upload"),
        eq(businessBackups.status, "completed"),
        sql`${businessBackups.expiresAt} IS NOT NULL AND ${businessBackups.expiresAt} < now()`,
      ),
    )
    .limit(100);
  for (const row of expiredUploads) {
    if (row.storageKey) await deletePackageObject(row.storageKey).catch(() => {});
    await db
      .update(businessBackups)
      .set({ status: "deleted", updatedAt: new Date() })
      .where(eq(businessBackups.id, row.id));
    deleted++;
  }

  // Retention window per business schedule (default env window).
  const rows = await db
    .select({
      id: businessBackups.id,
      businessId: businessBackups.businessId,
      type: businessBackups.type,
      status: businessBackups.status,
      storageKey: businessBackups.storageKey,
      createdAt: businessBackups.createdAt,
      retentionDays: backupSchedules.retentionDays,
    })
    .from(businessBackups)
    .leftJoin(backupSchedules, eq(backupSchedules.businessId, businessBackups.businessId))
    .where(
      and(
        eq(businessBackups.status, "completed"),
        inArray(businessBackups.type, ["manual", "scheduled"]),
      ),
    )
    .orderBy(businessBackups.businessId, desc(businessBackups.createdAt))
    .limit(2000);

  const newestCompleted = new Map<number, number>();
  for (const row of rows) {
    if (row.status !== "completed") continue;
    if (!newestCompleted.has(row.businessId)) {
      newestCompleted.set(row.businessId, row.id);
    }
  }
  for (const row of rows) {
    const cutoffDays = row.retentionDays ?? env.backupRetentionDays;
    const cutoff = Date.now() - cutoffDays * 24 * 3600 * 1000;
    if (row.createdAt.getTime() >= cutoff) continue;
    // Last known-good protection: skip the newest completed backup.
    if (newestCompleted.get(row.businessId) === row.id) continue;
    if (row.storageKey) await deletePackageObject(row.storageKey).catch(() => {});
    await db
      .update(businessBackups)
      .set({ status: "deleted", updatedAt: new Date() })
      .where(eq(businessBackups.id, row.id));
    await recordAudit({
      businessId: row.businessId,
      actorUserId: null,
      action: "backup.retention.deleted",
      entityType: "backup",
      entityId: row.id,
      metadata: { type: row.type, ageDays: cutoffDays },
    }).catch(() => {});
    deleted++;
  }
  return deleted;
}

export type { BackupRow };
