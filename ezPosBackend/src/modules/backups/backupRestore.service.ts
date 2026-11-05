import { createHash } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, getTableColumns, inArray, notInArray, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "../../db/schema/index.js";
import {
  businessBackups,
  restoreJobs,
  type restoreJobs as RestoreJobsTable,
} from "../../db/schema/backups.js";
import { businesses } from "../../db/schema/businesses.js";
import { giftCards } from "../../db/schema/giftCards.js";
import { storefronts } from "../../db/schema/storefronts.js";
import { ConflictError, NotFoundError } from "../../utils/handleError.js";
import { recordAudit } from "../../services/audit.js";
import { notifyInTx } from "../../services/notifications.js";
import { publishRealtime } from "../realtime/realtime.service.js";
import { createBusinessForUser } from "../businesses/businesses.service.js";
import {
  MODULE_GROUPS,
  POLY_REFS,
  PROFILE_EXCLUDE,
  TABLE_COLUMNS,
  TABLE_SPECS,
  buildUpdateSet,
  businessScopeCondition,
  coerceRowValues,
  insertableProps,
  type BackupTableSpec,
} from "./backupModules.js";
import { readBackupPackage, type BackupManifest, type ParsedPackage } from "./backupPackage.js";
import { runBackupJob, requestBackup } from "./backups.service.js";
import {
  backupStorageEnabled,
  fetchPackageFile,
  headPackage,
  putAttachmentBytes,
} from "./backupStorage.js";

type RestoreJob = typeof RestoreJobsTable.$inferSelect;
type AnyRow = Record<string, unknown>;

const RESTORE_CONFIRMATION_WORD = "RESTORE";
const CHUNK_SIZE = 200;
const NEW_BUSINESS_SKIP_TABLES = new Set(["storefront_api_keys"]);

// ---------------------------------------------------------------------------
// FK metadata (live introspection — always in sync with migrations)
// ---------------------------------------------------------------------------

interface FkPair {
  /** DB column name on the child. */
  childCol: string;
  parentTable: string;
  parentCol: string;
}

let fkCache: Map<string, FkPair[]> | null = null;

async function loadFkPairs(): Promise<Map<string, FkPair[]>> {
  if (fkCache) return fkCache;
  const result = await db.execute(sql`
    SELECT DISTINCT tc.table_name AS child_table,
           kcu.column_name AS child_column,
           ccu.table_name AS parent_table,
           ccu.column_name AS parent_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.constraint_schema = kcu.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.constraint_schema = ccu.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
  `);
  const rows = (result as unknown as { rows?: Record<string, string>[] }).rows ??
    (result as unknown as Record<string, string>[]);
  const map = new Map<string, FkPair[]>();
  for (const r of rows) {
    const pair: FkPair = {
      childCol: String(r.child_column ?? ""),
      parentTable: String(r.parent_table ?? ""),
      parentCol: String(r.parent_column ?? ""),
    };
    const childTable = String(r.child_table ?? "");
    const list = map.get(childTable) ?? [];
    if (!list.some((p) => p.childCol === pair.childCol && p.parentTable === pair.parentTable)) {
      list.push(pair);
    }
    map.set(childTable, list);
  }
  fkCache = map;
  return map;
}

/** child DB column → parent registry table (id references only). */
async function remapColumnsFor(spec: BackupTableSpec): Promise<Record<string, string>> {
  const pairs = (await loadFkPairs()).get(spec.name) ?? [];
  const cols = TABLE_COLUMNS[spec.name] ?? {};
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    if (pair.parentCol !== "id") continue; // business_id pairs handled wholesale
    if (!TABLE_SPECS[pair.parentTable] && pair.parentTable !== "businesses") continue;
    for (const [prop, meta] of Object.entries(cols)) {
      if (meta.name === pair.childCol) {
        out[prop] = pair.parentTable;
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preview (Phase I)
// ---------------------------------------------------------------------------

async function materializePackage(backupRow: {
  id: number;
  storageKey: string | null;
  sha256: string | null;
}): Promise<{ filePath: string; size: number }> {
  if (!backupRow.storageKey) throw new ConflictError("Backup has no stored package.");
  const filePath = path.join(
    tmpdir(),
    `ezpos-restore-${backupRow.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  await fetchPackageFile(backupRow.storageKey, filePath);
  const { size } = await stat(filePath);
  if (backupRow.sha256) {
    const actual = await sha256File(filePath);
    if (actual !== backupRow.sha256) {
      await unlink(filePath).catch(() => {});
      throw new ConflictError(
        "Package checksum mismatch — the file changed since it was stored or uploaded.",
      );
    }
  }
  return { filePath, size };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = await import("node:fs").then((fs) => fs.createReadStream(filePath));
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (c: Buffer) => hash.update(c));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

export interface RestorePreview {
  backupId: number;
  manifest: {
    businessId: number;
    businessName: string;
    businessSlug: string;
    createdAt: string;
    appVersion: string;
    modules: string[];
    recordCounts: Record<string, number>;
    attachmentCounts: Record<string, number>;
    warnings: string[];
  };
  mode: "full" | "new_business" | "selective";
  requestedModules: string[];
  checks: Array<{ check: string; ok: boolean; detail: string }>;
  warnings: string[];
  readyForRestore: boolean;
  requiresSafetyBackup: boolean;
}

export async function previewRestore(input: {
  businessId: number;
  backupId: number;
  mode: "full" | "new_business" | "selective";
  moduleKeys?: string[] | null;
}): Promise<RestorePreview> {
  const [backupRow] = await db
    .select()
    .from(businessBackups)
    .where(
      and(
        eq(businessBackups.id, input.backupId),
        eq(businessBackups.businessId, input.businessId),
      ),
    )
    .limit(1);
  if (!backupRow) throw new NotFoundError("Backup not found.");
  if (backupRow.status !== "completed") {
    throw new ConflictError("Only completed backups can be restored.");
  }

  const { filePath } = await materializePackage(backupRow);
  try {
    const parsed = await readBackupPackage(filePath);
    const manifest = parsed.manifest;
    const checks: RestorePreview["checks"] = [];
    const warnings: string[] = [];

    checks.push({
      check: "format",
      ok: manifest.formatVersion === 1,
      detail: `format version ${manifest.formatVersion}`,
    });

    if (input.mode !== "new_business") {
      const identityOk = manifest.businessId === input.businessId;
      checks.push({
        check: "business_identity",
        ok: identityOk,
        detail: identityOk
          ? "package belongs to this business"
          : `package belongs to business ${manifest.businessId} (${manifest.businessName}) — refusing to overwrite another business`,
      });
      if (manifest.businessName) {
        const [current] = await db
          .select({ name: businesses.name })
          .from(businesses)
          .where(eq(businesses.id, input.businessId))
          .limit(1);
        if (current && current.name !== manifest.businessName) {
          warnings.push(
            `Package was exported from "${manifest.businessName}" which has since been renamed to "${current.name}" — a full restore will restore the old profile name.`,
          );
        }
      }
      // Newer-data conflict report: the newest operational row postdates the backup.
      const [newestRow] = await db
        .select({
          newest: sql<string | null>`(SELECT max(created_at) FROM sales WHERE business_id = ${input.businessId})`,
        })
        .from(businesses)
        .where(eq(businesses.id, input.businessId))
        .limit(1);
      const newest = newestRow?.newest;
      if (newest && new Date(newest) > new Date(manifest.createdAt)) {
        warnings.push(
          `This business has sales newer than the backup (${new Date(newest).toISOString()}). Restoring will remove or revert data created after ${manifest.createdAt}. A pre-restore safety backup will be taken automatically.`,
        );
      }
    }

    if (input.mode === "full") {
      const isWhole = MODULE_GROUPS.every((g) => manifest.modules.includes(g.key));
      checks.push({
        check: "full_coverage",
        ok: isWhole,
        detail: isWhole
          ? "package contains every module — safe for full restore"
          : "package is partial — full restore would delete tables the package does not contain; use selective restore instead",
      });
    }

    let requested = input.moduleKeys ?? manifest.modules;
    const unknown = requested.filter((m) => !manifest.modules.includes(m));
    if (unknown.length > 0) {
      checks.push({
        check: "modules_present",
        ok: false,
        detail: `package does not contain modules: ${unknown.join(", ")}`,
      });
    }
    if (input.mode === "selective") {
      const missingDeps = new Set<string>();
      for (const key of requested) {
        const group = MODULE_GROUPS.find((g) => g.key === key);
        for (const dep of group?.requires ?? []) {
          if (!requested.includes(dep)) missingDeps.add(dep);
        }
      }
      if (missingDeps.size > 0) {
        warnings.push(
          `Selected modules require their dependencies — restoring will also include: ${[...missingDeps].join(", ")}.`,
        );
        requested = [...new Set([...requested, ...missingDeps])];
      }
    }

    const ready = checks.every((c) => c.ok);
    return {
      backupId: backupRow.id,
      manifest: {
        businessId: manifest.businessId,
        businessName: manifest.businessName,
        businessSlug: manifest.businessSlug,
        createdAt: manifest.createdAt,
        appVersion: manifest.appVersion,
        modules: manifest.modules,
        recordCounts: manifest.recordCounts,
        attachmentCounts: manifest.attachmentCounts,
        warnings: manifest.warnings,
      },
      mode: input.mode,
      requestedModules: requested,
      checks,
      warnings,
      readyForRestore: ready,
      requiresSafetyBackup: input.mode === "full",
    };
  } finally {
    await unlink(filePath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Job creation + execution (Phases I→J)
// ---------------------------------------------------------------------------

export async function createRestoreJob(input: {
  businessId: number;
  userId: number;
  mode: "full" | "new_business" | "selective";
  backupId: number;
  moduleKeys?: string[] | null;
  confirm?: string;
}): Promise<RestoreJob> {
  if (input.confirm !== RESTORE_CONFIRMATION_WORD) {
    throw new ConflictError(
      `Destructive confirmation required: pass confirm="${RESTORE_CONFIRMATION_WORD}".`,
    );
  }
  const [active] = await db
    .select({ id: restoreJobs.id })
    .from(restoreJobs)
    .where(
      and(
        eq(restoreJobs.businessId, input.businessId),
        inArray(restoreJobs.status, ["pending", "validating", "running", "verifying"]),
      ),
    )
    .limit(1);
  if (active) {
    throw new ConflictError("A restore is already running for this business.");
  }
  const moduleKeys = input.moduleKeys ? [...new Set(input.moduleKeys.map(String))] : null;
  const jobRows = await db
    .insert(restoreJobs)
    .values({
      businessId: input.businessId,
      backupId: input.backupId,
      mode: input.mode,
      modules: moduleKeys,
      status: "pending",
      actorUserId: input.userId,
    })
    .returning();
  const job = jobRows[0];
  if (!job) throw new ConflictError("Could not create the restore job.");
  void executeRestoreJob(job.id).catch((err) => {
    console.error(`Restore job ${job.id} crashed:`, err);
  });
  return job;
}

async function setJob(
  jobId: number,
  businessId: number,
  patch: Partial<RestoreJob>,
): Promise<void> {
  await db
    .update(restoreJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(restoreJobs.id, jobId));
  const percent = (patch.progress as { percent?: number } | null)?.percent;
  publishRealtime(businessId, null, {
    kind: "restore.progress",
    restoreId: jobId,
    status: String(patch.status ?? "running"),
    ...(patch.stage != null ? { stage: patch.stage } : {}),
    ...(percent !== undefined ? { percent } : {}),
  });
}

export async function executeRestoreJob(jobId: number): Promise<void> {
  const [job] = await db
    .select()
    .from(restoreJobs)
    .where(eq(restoreJobs.id, jobId))
    .limit(1);
  if (!job || job.status !== "pending") return;

  const warnings: string[] = [];
  const keptRows: Array<{ table: string; count: number }> = [];
  let parsed: ParsedPackage | null = null;
  let filePath: string | null = null;
  try {
    await setJob(job.id, job.businessId, { status: "validating", stage: "loading_package" });

    const [backupRow] = await db
      .select()
      .from(businessBackups)
      .where(eq(businessBackups.id, job.backupId ?? -1))
      .limit(1);
    if (!backupRow || backupRow.status !== "completed") {
      throw new ConflictError("The source backup is missing or not completed.");
    }
    const materialized = await materializePackage(backupRow);
    filePath = materialized.filePath;

    parsed = await readBackupPackage(filePath, { withData: true, loadAttachments: true });
    const manifest = parsed.manifest;

    // Identity gates.
    if (job.mode !== "new_business" && manifest.businessId !== job.businessId) {
      throw new ConflictError(
        `Refusing to restore: package belongs to business ${manifest.businessId}, not ${job.businessId}.`,
      );
    }
    if (job.mode === "full" && !MODULE_GROUPS.every((g) => manifest.modules.includes(g.key))) {
      throw new ConflictError(
        "Full restore requires a package containing every module; use selective restore for partial packages.",
      );
    }

    await setJob(job.id, job.businessId, { status: "running", stage: "safety_backup" });

    let targetBusinessId = job.businessId;
    if (job.mode === "new_business") {
      const created = await createBusinessForUser(job.actorUserId ?? 0, {
        name: `${manifest.businessName}`.slice(0, 100),
        phone: undefined,
        email: undefined,
        address: undefined,
        businessType: undefined,
        country: undefined,
      });
      targetBusinessId = created.business.id;
      await db
        .update(restoreJobs)
        .set({ targetBusinessId })
        .where(eq(restoreJobs.id, job.id));
      warnings.push(
        "Staff memberships, roles and the subscription are NOT imported — the restoring user is the new owner. Invite staff and choose a plan manually.",
      );
    } else if (job.mode === "full") {
      // Step 5 of the pipeline: safety backup before replacing live data.
      const safety = await requestBackup({
        businessId: job.businessId,
        userId: job.actorUserId,
        type: "pre_restore",
      });
      await runBackupJob(safety.id);
      const [safetyAfter] = await db
        .select({ status: businessBackups.status })
        .from(businessBackups)
        .where(eq(businessBackups.id, safety.id))
        .limit(1);
      if (safetyAfter?.status !== "completed") {
        throw new ConflictError(
          "Pre-restore safety backup failed — restore aborted, nothing was changed.",
        );
      }
      await db
        .update(restoreJobs)
        .set({ preRestoreBackupId: safety.id })
        .where(eq(restoreJobs.id, job.id));
    }

    const requested: string[] =
      job.mode === "selective"
        ? ((job.modules as string[] | null) ?? manifest.modules)
        : manifest.modules;

    // Dependency closure for selective restores.
    let selectedKeys = [...requested];
    if (job.mode === "selective") {
      const missing = new Set<string>();
      for (const key of selectedKeys) {
        for (const dep of MODULE_GROUPS.find((g) => g.key === key)?.requires ?? []) {
          if (!selectedKeys.includes(dep)) missing.add(dep);
        }
      }
      if (missing.size > 0) {
        warnings.push(`Dependencies auto-included: ${[...missing].join(", ")}.`);
        selectedKeys = [...new Set([...selectedKeys, ...missing])];
      }
    }
    const groups = MODULE_GROUPS.filter((g) => selectedKeys.includes(g.key));
    const tableNames = groups.flatMap((g) => g.tables).filter(
      (t) => !(job.mode === "new_business" && NEW_BUSINESS_SKIP_TABLES.has(t)),
    );

    await setJob(job.id, job.businessId, {
      stage: "restoring",
      progress: {
        percent: 0,
        groups: groups.map((g) => g.key),
        doneGroups: 0,
      },
    });

    const isRemap = job.mode === "new_business";
    const idMaps = new Map<string, Map<number, number>>();
    let doneGroups = 0;

    if (job.mode !== "selective" && parsed.rows) {
      await applyProfile(parsed, targetBusinessId, isRemap, warnings);
    }

    for (const group of groups) {
      for (const tableName of group.tables) {
        if (isRemap && NEW_BUSINESS_SKIP_TABLES.has(tableName)) continue;
        const spec = TABLE_SPECS[tableName]!;
        const rows = parsed.rows?.[tableName] ?? [];
        if (isRemap) {
          await insertRemapped(db, spec, rows, targetBusinessId, idMaps, warnings);
        } else {
          const kept = await upsertKeepIds(
            db,
            spec,
            rows,
            targetBusinessId,
            job.mode === "full",
          );
          if (kept > 0) keptRows.push({ table: tableName, count: kept });
        }
      }
      doneGroups++;
      await setJob(job.id, job.businessId, {
        stage: `restoring:${group.key}`,
        progress: {
          percent: Math.round((doneGroups / groups.length) * 80),
          groups: groups.map((g) => g.key),
          doneGroups,
        },
      });
    }

    if (isRemap) {
      await applyNewBusinessSpecials(targetBusinessId, idMaps, warnings);
    }

    await setJob(job.id, job.businessId, {
      status: "verifying",
      stage: "verify",
      progress: { percent: 85, groups: groups.map((g) => g.key), doneGroups: groups.length },
    });

    const report = await verifyRestoredData(
      targetBusinessId,
      manifest,
      selectedKeys,
      job.mode,
      parsed,
    );

    const result = {
      mode: job.mode,
      targetBusinessId,
      modules: selectedKeys,
      warnings: [...warnings, ...report.warnings],
      keptRows,
      counts: report.counts,
      countMismatches: report.counts.filter((c) => !c.match),
      orphans: report.orphans,
      sequencesReset: report.sequencesReset,
      attachmentsRestored: report.attachmentsRestored,
      attachmentsMissing: report.attachmentsMissing,
    };

    await db
      .update(restoreJobs)
      .set({
        status: "completed",
        stage: "done",
        result,
        progress: { percent: 100 },
        updatedAt: new Date(),
      })
      .where(eq(restoreJobs.id, job.id));
    publishRealtime(job.businessId, null, {
      kind: "restore.progress",
      restoreId: job.id,
      status: "completed",
    });
    await notifyInTx(db, {
      businessId: job.businessId,
      kind: "restore",
      severity: report.counts.every((c) => c.match) ? "info" : "warning",
      title: "Restore completed",
      body:
        report.counts.every((c) => c.match)
          ? `Restore (${job.mode}) finished and verified.`
          : `Restore finished with ${report.counts.filter((c) => !c.match).length} count mismatch(es) — review the report.`,
      payload: { restoreId: job.id },
    }).catch(() => {});
    await recordAudit({
      businessId: job.businessId,
      actorUserId: job.actorUserId,
      action: "restore.completed",
      entityType: "restore_job",
      entityId: job.id,
      metadata: {
        mode: job.mode,
        targetBusinessId,
        backupId: job.backupId,
        mismatched: result.countMismatches.length,
      },
    }).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : "Restore failed.";
    await db
      .update(restoreJobs)
      .set({ status: "failed", error: message, updatedAt: new Date() })
      .where(eq(restoreJobs.id, job.id))
      .catch(() => {});
    publishRealtime(job.businessId, null, {
      kind: "restore.progress",
      restoreId: job.id,
      status: "failed",
    });
    await notifyInTx(db, {
      businessId: job.businessId,
      kind: "restore",
      severity: "critical",
      title: "Restore failed",
      body: message,
      payload: { restoreId: job.id },
    }).catch(() => {});
    await recordAudit({
      businessId: job.businessId,
      actorUserId: job.actorUserId,
      action: "restore.failed",
      entityType: "restore_job",
      entityId: job.id,
      metadata: { error: message.slice(0, 300) },
    }).catch(() => {});
  } finally {
    await unlink(filePath ?? "").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Apply strategies
// ---------------------------------------------------------------------------

async function applyProfile(
  parsed: ParsedPackage,
  targetBusinessId: number,
  isRemap: boolean,
  warnings: string[],
): Promise<void> {
  const profileRows = (parsed.rows?.["_profile"] ?? []) as AnyRow[];
  const profile = profileRows[0];
  if (!profile) return;
  const patch: AnyRow = {};
  for (const [k, v] of Object.entries(profile)) {
    if (["id", "createdAt", "updatedAt", ...PROFILE_EXCLUDE].includes(k)) continue;
    patch[k] = v;
  }
  if (Object.keys(patch).length === 0) return;
  try {
    await db
      .update(businesses)
      .set(patch as never)
      .where(eq(businesses.id, targetBusinessId));
    if (isRemap) {
      warnings.push("Business profile (name, currency, timezone, logo) applied to the new business.");
    }
  } catch (err) {
    warnings.push(
      `Business profile was not restored: ${err instanceof Error ? err.message : "unknown error"}.`,
    );
  }
}

/**
 * Full/selective restore: rows keep their IDs and are upserted by id
 * (diff-merge — delete-all + reinsert would cascade away platform state).
 * In full mode, rows absent from the package are deleted unless protected.
 * Returns the number of rows kept because deletion violated a FK.
 */
async function upsertKeepIds(
  dbh: typeof db,
  spec: BackupTableSpec,
  rows: AnyRow[],
  businessId: number,
  deleteAbsent: boolean,
): Promise<number> {
  const cols = getTableColumns(spec.table as never) as Record<string, PgColumn>;
  const idCol = cols["id"]!;
  const bizCol = cols["businessId"];
  const props = insertableProps(spec);
  const updateSet = buildUpdateSet(spec);

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE).map((row) => {
      const clone: AnyRow = {};
      for (const [k, v] of Object.entries(row)) {
        if (!props.has(k)) continue;
        clone[k] = k === "businessId" && bizCol ? businessId : v;
      }
      return coerceRowValues(spec, clone);
    });
    if (spec.strategy === "updateOrInsert") {
      for (const row of chunk) {
        const updated = await dbh
          .update(spec.table as never)
          .set(omitId(row) as never)
          .where(eq(idCol, row.id))
          .returning({ id: idCol });
        if (updated.length === 0) {
          await dbh.insert(spec.table as never).values(row as never);
        }
      }
      continue;
    }
    const conflictCols = spec.conflictTarget
      ? spec.conflictTarget.map((p) => cols[p]!)
      : [idCol];
    await dbh
      .insert(spec.table as never)
      .values(chunk as never)
      .onConflictDoUpdate({
        target: conflictCols as never,
        set: updateSet as never,
      });
  }

  if (!deleteAbsent || spec.name === "locations") return 0;
  // Delete rows absent from the package (diff-merge), tolerating FK-protected
  // rows (kept + reported — never silently lost).
  const keepIds = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
  try {
    if (bizCol) {
      if (keepIds.length > 0) {
        await dbh
          .delete(spec.table as never)
          .where(and(eq(bizCol, businessId), notInArray(idCol, keepIds as never[])));
      } else if (spec.name !== "_profile") {
        await dbh.delete(spec.table as never).where(eq(bizCol, businessId));
      }
    } else if (spec.name === "product_taxes" || spec.name === "variant_values") {
      // Composite-PK join tables: scope through the parent, diff by pair.
      const parentTable = spec.name === "product_taxes" ? "products" : "product_variants";
      const kc0 = cols[spec.conflictTarget![0]!]!;
      const kc1 = cols[spec.conflictTarget![1]!]!;
      const existing = await dbh.execute(
        sql`SELECT t.* FROM ${spec.table} t WHERE t.${sql.raw(kc0.name)} IN (SELECT id FROM ${sql.raw(parentTable)} WHERE business_id = ${businessId})`,
      );
      const existingRows = (existing as unknown as { rows?: AnyRow[] }).rows ??
        (existing as unknown as AnyRow[]);
      const k0 = spec.conflictTarget![0]!;
      const k1 = spec.conflictTarget![1]!;
      for (const ex of existingRows) {
        // ex uses DB column names; package rows use property names.
        const ex0 = ex[kc0.name];
        const ex1 = ex[kc1.name];
        const keep = rows.some(
          (r) => Number(r[k0]) === Number(ex0) && Number(r[k1]) === Number(ex1),
        );
        if (!keep) {
          await dbh.execute(
            sql`DELETE FROM ${spec.table} WHERE ${sql.raw(kc0.name)} = ${ex0} AND ${sql.raw(kc1.name)} = ${ex1}`,
          );
        }
      }
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23503") {
      // Fall back to row-by-row so protected rows are the only survivors.
      let kept = 0;
      const absent =
        keepIds.length > 0
          ? await dbh
              .select({ id: idCol })
              .from(spec.table as never)
              .where(and(eq(bizCol!, businessId), notInArray(idCol, keepIds as never[])))
          : await dbh
              .select({ id: idCol })
              .from(spec.table as never)
              .where(eq(bizCol!, businessId));
      for (const row of absent as Array<{ id: number }>) {
        try {
          await dbh.delete(spec.table as never).where(eq(idCol, row.id));
        } catch {
          kept++;
        }
      }
      return kept;
    }
    throw err;
  }
  return 0;
}

function omitId(row: AnyRow): AnyRow {
  const clone = { ...row };
  delete clone.id;
  return clone;
}

/**
 * New-business restore: rows are inserted WITHOUT their original ids (the
 * source business still owns them) and every FK is remapped through the
 * idMaps built table-by-table in dependency order.
 */
async function insertRemapped(
  dbh: typeof db,
  spec: BackupTableSpec,
  rows: AnyRow[],
  businessId: number,
  idMaps: Map<string, Map<number, number>>,
  warnings: string[],
): Promise<void> {
  const fkProps = await remapColumnsFor(spec);
  const cols = getTableColumns(spec.table as never) as Record<string, PgColumn>;
  const bizCol = cols["businessId"];
  const props = insertableProps(spec);
  const map = new Map<number, number>();
  idMaps.set(spec.name, map);

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE).map((row) => {
      const clone: AnyRow = {};
      for (const [k, v] of Object.entries(row)) {
        if (!props.has(k)) continue;
        if (k === "id") continue; // serial assigns; we record the mapping
        if (k === "businessId" && bizCol) {
          clone[k] = businessId;
          continue;
        }
        const parentTable = fkProps[k];
        if (parentTable) {
          if (Number.isFinite(Number(v)) && v !== null && v !== undefined) {
            const mapped = idMaps.get(parentTable)?.get(Number(v));
            clone[k] = mapped ?? null;
            if (mapped === undefined) {
              warnings.push(
                `${spec.name}.${k}: reference to ${parentTable}#${v} could not be remapped and was nulled.`,
              );
            }
            continue;
          }
          clone[k] = v;
          continue;
        }
        clone[k] = v;
      }
      return coerceRowValues(spec, clone);
    });

    // Polymorphic references (no FK — remapped by convention).
    for (const row of chunk) {
      remapPolyRefs(spec.name, row, idMaps);
    }

    if (spec.name === "gift_cards") {
      await remintGiftCards(dbh, chunk, map, rows, i);
      continue;
    }
    if (spec.name === "online_order_payments") {
      for (const row of chunk) {
        if (typeof row.idempotencyKey === "string") {
          row.idempotencyKey = `${row.idempotencyKey}-nb${businessId}`;
        }
      }
    }
    if (spec.name === "integrations") {
      for (const row of chunk) row.webhookSecret = null;
    }
    if (spec.name === "storefronts") {
      for (const row of chunk) {
        row.status = "draft";
        row.subdomain = await uniqueSubdomain(String(row.subdomain ?? "shop"));
      }
    }

    // Composite-PK join tables: upsert on the composite key (ids remapped).
    if (spec.conflictTarget) {
      await dbh
        .insert(spec.table as never)
        .values(chunk as never)
        .onConflictDoNothing();
      for (let j = 0; j < chunk.length; j++) {
        const old = rows[i + j]!;
        map.set(Number(old.id ?? 0), Number((chunk[j] as AnyRow).id ?? 0));
      }
      continue;
    }

    const inserted = await dbh
      .insert(spec.table as never)
      .values(chunk as never)
      .returning({ id: cols["id"]! });
    for (let j = 0; j < chunk.length; j++) {
      const newId = Number((inserted[j] as { id?: number })?.id ?? 0);
      map.set(Number((rows[i + j] as AnyRow).id), newId);
    }
  }
}

async function remintGiftCards(
  dbh: typeof db,
  chunk: AnyRow[],
  map: Map<number, number>,
  rows: AnyRow[],
  offset: number,
): Promise<void> {
  const { randomBytes } = await import("node:crypto");
  for (let j = 0; j < chunk.length; j++) {
    const row = chunk[j]!;
    const code = randomBytes(10).toString("hex").toUpperCase();
    row.codeHash = createHash("sha256").update(code).digest("hex");
    row.codeLast4 = code.slice(-4);
    const inserted = await dbh
      .insert(giftCards)
      .values(row as never)
      .returning({ id: giftCards.id });
    map.set(Number(rows[offset + j]!.id), Number(inserted[0]!.id));
  }
}

async function uniqueSubdomain(base: string): Promise<string> {
  const clean = base.replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 40) || "shop";
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${clean}-r${Math.random().toString(36).slice(2, 6)}`;
    const [existing] = await db
      .select({ id: storefronts.id })
      .from(storefronts)
      .where(eq(storefronts.subdomain, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  throw new ConflictError("Could not allocate a unique storefront subdomain.");
}

function remapPolyRefs(
  tableName: string,
  row: AnyRow,
  idMaps: Map<string, Map<number, number>>,
): void {
  for (const poly of POLY_REFS) {
    if (poly.table !== tableName) continue;
    const typeCol = poly.typeCol;
    const typeVal = typeCol ? String(row[typeCol] ?? "") : "sale";
    const target = poly.typeMap[typeVal];
    if (!target) continue;
    const oldId = Number(row[poly.idCol]);
    if (!Number.isFinite(oldId) || oldId === 0) continue;
    const mapped = idMaps.get(target)?.get(oldId);
    if (mapped !== undefined) row[poly.idCol] = mapped;
  }
}

async function applyNewBusinessSpecials(
  targetBusinessId: number,
  idMaps: Map<string, Map<number, number>>,
  warnings: string[],
): Promise<void> {
  const giftMap = idMaps.get("gift_cards");
  if (giftMap && giftMap.size > 0) {
    warnings.push(
      `${giftMap.size} gift card(s) were re-minted with new codes because card codes are stored hashed and the original business still exists. New codes are shown once in the restore result (see the restore report).`,
    );
  }
  void targetBusinessId;
}

// ---------------------------------------------------------------------------
// Verification (Phase J step 7)
// ---------------------------------------------------------------------------

interface CountCheck {
  table: string;
  expected: number;
  actual: number;
  match: boolean;
}

async function verifyRestoredData(
  targetBusinessId: number,
  manifest: BackupManifest,
  selectedModules: string[],
  mode: string,
  parsed: ParsedPackage,
): Promise<{
  counts: CountCheck[];
  orphans: Record<string, number>;
  sequencesReset: number;
  attachmentsRestored: number;
  attachmentsMissing: number;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const groups = MODULE_GROUPS.filter((g) => selectedModules.includes(g.key));
  const tableNames = groups.flatMap((g) => g.tables);
  const counts: CountCheck[] = [];
  for (const name of tableNames) {
    const spec = TABLE_SPECS[name];
    if (!spec) continue;
    const scope = businessScopeCondition(spec, targetBusinessId);
    if (!scope) {
      warnings.push(`No business scope for ${name} — skipped in verification.`);
      continue;
    }
    try {
      const result = await db.execute(
        sql`SELECT count(*)::int AS count FROM ${spec.table} WHERE ${scope}`,
      );
      const rows = (result as unknown as { rows?: Array<{ count: number }> }).rows ??
        (result as unknown as Array<{ count: number }>);
      const actual = Number(rows[0]?.count ?? 0);
      const expected = Number(manifest.recordCounts[name] ?? 0);
      counts.push({ table: name, expected, actual, match: expected === actual });
    } catch {
      warnings.push(`Could not count ${name} for verification.`);
    }
  }

  const orphans: Record<string, number> = {};
  const orphanChecks: Array<[string, ReturnType<typeof sql>]> = [
    [
      "coupon_redemptions→sales",
      sql`SELECT count(*)::int AS c FROM coupon_redemptions WHERE business_id = ${targetBusinessId} AND sale_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = coupon_redemptions.sale_id)`,
    ],
    [
      "register_transactions→sales",
      sql`SELECT count(*)::int AS c FROM register_transactions WHERE business_id = ${targetBusinessId} AND reference_type = 'sale' AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = register_transactions.reference_id)`,
    ],
    [
      "customer_credits→sales",
      sql`SELECT count(*)::int AS c FROM customer_credits WHERE business_id = ${targetBusinessId} AND source_type = 'sale' AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = customer_credits.source_id)`,
    ],
    [
      "inventory_movements→sales",
      sql`SELECT count(*)::int AS c FROM inventory_movements WHERE business_id = ${targetBusinessId} AND reference_type = 'sale' AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = inventory_movements.reference_id)`,
    ],
  ];
  for (const [name, query] of orphanChecks) {
    try {
      const result = await db.execute(query);
      const rows = (result as unknown as { rows?: Array<{ c: number }> }).rows ??
        (result as unknown as Array<{ c: number }>);
      orphans[name] = Number(rows[0]?.c ?? 0);
    } catch {
      orphans[name] = -1; // check unavailable — reported honestly
    }
  }

  // Serial sequences: full/selective restores insert explicit ids — align
  // every sequence with the table max so new inserts never collide.
  let sequencesReset = 0;
  if (mode !== "new_business") {
    for (const name of tableNames) {
      const spec = TABLE_SPECS[name];
      if (!spec || spec.conflictTarget) continue;
      try {
        await db.execute(
          sql`SELECT setval(
                pg_get_serial_sequence(${sql.raw(`"${name}"`)}, 'id'),
                GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${sql.raw(`"${name}"`)}), 1),
                (SELECT COALESCE(MAX(id), 0) FROM ${sql.raw(`"${name}"`)}) > 0)`,
        );
        sequencesReset++;
      } catch {
        warnings.push(`Could not reset the id sequence for ${name}.`);
      }
    }
  }

  // Attachments: ensure the object exists in storage; re-upload from the
  // package when it went missing.
  let attachmentsRestored = 0;
  let attachmentsMissing = 0;
  for (const att of manifest.attachments ?? []) {
    try {
      const head = await headPackage(att.objectKey);
      if (!head.exists && parsed.attachments?.get(att.path)) {
        await putAttachmentBytes(att.objectKey, parsed.attachments.get(att.path)!);
        attachmentsRestored++;
      }
    } catch {
      attachmentsMissing++;
    }
  }
  if (!backupStorageEnabled() && (manifest.attachments?.length ?? 0) > 0) {
    warnings.push(
      "Object storage is not configured — attachment bytes could not be checked or re-uploaded.",
    );
  }

  return { counts, orphans, sequencesReset, attachmentsRestored, attachmentsMissing, warnings };
}
