import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { users } from "./users.js";

/**
 * Backup & Restore (commercial program). These tables track backup PACKAGES
 * (business-scoped data extracts, encrypted at rest), per-business backup
 * schedules, and restore jobs. The packages themselves live in private
 * object storage — these rows are the catalog, audit trail and state machine
 * ("never claim success before the archive is verified").
 */

export const backupTypeEnum = pgEnum("backup_type", [
  "manual",
  "scheduled",
  "safety",
  "pre_restore",
  "upload",
]);

export const backupStatusEnum = pgEnum("backup_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "expired",
  "deleted",
]);

export const backupFrequencyEnum = pgEnum("backup_frequency", [
  "daily",
  "weekly",
]);

export const restoreModeEnum = pgEnum("restore_mode", [
  "full",
  "new_business",
  "selective",
]);

export const restoreStatusEnum = pgEnum("restore_status", [
  "pending",
  "validating",
  "running",
  "verifying",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * One catalog row per backup package. `type` distinguishes who/what created
 * it: manual (user action), scheduled (scheduler sweep), safety (automatic
 * per-policy copy kept longer), pre_restore (mandatory safety copy before a
 * destructive restore), upload (externally supplied .ezbackup).
 */
export const businessBackups = pgTable(
  "business_backups",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    type: backupTypeEnum("type").notNull().default("manual"),
    status: backupStatusEnum("status").notNull().default("pending"),
    /** Object-storage key of the encrypted package (or local fallback key). */
    storageKey: varchar("storage_key", { length: 500 }),
    /** Download filename, e.g. ezpos-backup-<slug>-2026-11-05.ezbackup */
    fileName: varchar("file_name", { length: 250 }),
    fileSize: bigint("file_size", { mode: "number" }),
    /** sha256 of the exact encrypted package bytes (integrity anchor). */
    sha256: varchar("sha256", { length: 64 }),
    /** Envelope metadata: alg, keyVersion, wrapped DEK, IVs, auth tag. */
    encryption: jsonb("encryption"),
    /** Parsed manifest snapshot (counts, modules, versions, checksums). */
    manifest: jsonb("manifest"),
    /** Requested module selection (null = all modules). */
    moduleSelection: jsonb("module_selection"),
    error: text("error"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    triggeredBy: integer("triggered_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // One in-flight backup per business — prevents concurrent duplicate jobs
    // (manual double-clicks and scheduler/manual races share this guarantee).
    uniqueIndex("business_backups_one_active_uq")
      .on(table.businessId)
      .where(sql`status IN ('pending', 'running')`),
    index("business_backups_business_created_idx").on(
      table.businessId,
      table.createdAt,
    ),
  ],
);

/** Per-business automatic backup schedule (singleton per business). */
export const backupSchedules = pgTable(
  "backup_schedules",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    frequency: backupFrequencyEnum("frequency").notNull().default("daily"),
    /** Local hour of day (0-23) in the BUSINESS timezone. */
    hour: integer("hour").notNull().default(2),
    /** 0=Sunday..6=Saturday; only meaningful for weekly frequency. */
    dayOfWeek: integer("day_of_week"),
    retentionDays: integer("retention_days").notNull().default(30),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("backup_schedules_business_uq").on(table.businessId),
    index("backup_schedules_due_idx").on(table.enabled, table.nextRunAt),
  ],
);

/**
 * Restore job state machine: pending → validating → running → verifying →
 * completed | failed | cancelled. Progress/stage feed the SSE channel and
 * the UI; `result` carries the verification report (counts, orphans,
 * sequence state, warnings) — a restore is only reported successful after
 * verification passes.
 */
export const restoreJobs = pgTable(
  "restore_jobs",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** Target business for new_business mode (same as businessId otherwise). */
    targetBusinessId: integer("target_business_id").references(
      () => businesses.id,
      { onDelete: "set null" },
    ),
    backupId: integer("backup_id").references(() => businessBackups.id, {
      onDelete: "set null",
    }),
    mode: restoreModeEnum("mode").notNull(),
    modules: jsonb("modules"),
    status: restoreStatusEnum("status").notNull().default("pending"),
    stage: varchar("stage", { length: 80 }),
    progress: jsonb("progress"),
    preRestoreBackupId: integer("pre_restore_backup_id").references(
      () => businessBackups.id,
      { onDelete: "set null" },
    ),
    result: jsonb("result"),
    error: text("error"),
    actorUserId: integer("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("restore_jobs_business_created_idx").on(
      table.businessId,
      table.createdAt,
    ),
  ],
);
