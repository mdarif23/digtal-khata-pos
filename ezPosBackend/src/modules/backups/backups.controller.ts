import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/handleError.js";
import { z } from "zod";
import { MODULE_GROUPS } from "./backupModules.js";
import { backupStorageEnabled } from "./backupStorage.js";
import {
  createRestoreJob,
  previewRestore,
} from "./backupRestore.service.js";
import {
  deleteBackup,
  getBackup,
  getDownloadUrl,
  getSchedule,
  listBackups,
  normalizeModuleKeys,
  openPackageStream,
  registerUploadedPackage,
  requestBackup,
  runBackupJob,
  upsertSchedule,
  verifyBackup,
} from "./backups.service.js";
import {
  createBackupSchema,
  listBackupsQuerySchema,
  registerUploadSchema,
  restorePreviewSchema,
  restoreSchema,
  scheduleSchema,
} from "./backups.schema.js";

function success(res: Response, data: unknown, message?: string): void {
  res.json({ success: true, data, ...(message ? { message } : {}) });
}

/** Zod validation failures are client errors, never 500s. */
function parseBody<T>(schema: { parse: (v: unknown) => T }, body: unknown): T {
  try {
    return schema.parse(body ?? {});
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new BadRequestError(
        err.issues[0]?.message ?? "Invalid request payload.",
      );
    }
    throw err;
  }
}

export function getModules(_req: Request, res: Response): void {
  success(res, {
    storageEnabled: backupStorageEnabled(),
    groups: MODULE_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      requires: g.requires,
      tables: g.tables.length,
    })),
  });
}

export async function postCreateBackup(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(createBackupSchema, req.body);
    const row = await requestBackup({
      businessId,
      userId: req.user!.id,
      type: "manual",
      moduleKeys: input.modules ?? null,
    });
    res.status(202).json({
      success: true,
      data: row,
      message: "Backup started. Progress is available on the backup history page.",
    });
  } catch (err) {
    sendSafeError(res, err, "Could not start the backup.");
  }
}

export async function getList(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const query = listBackupsQuerySchema.parse(req.query);
    const { items, total } = await listBackups(businessId, query);
    success(res, { items, total, page: query.page, pageSize: query.pageSize });
  } catch (err) {
    sendSafeError(res, err, "Could not load backup history.");
  }
}

export async function getOne(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const row = await getBackup(businessId, Number(req.params.id));
    success(res, row);
  } catch (err) {
    sendSafeError(res, err, "Backup not found.");
  }
}

export async function postVerify(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const result = await verifyBackup(businessId, Number(req.params.id));
    success(res, result);
  } catch (err) {
    sendSafeError(res, err, "Verification failed.");
  }
}

export async function deleteOne(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    await deleteBackup(businessId, Number(req.params.id), req.user!.id);
    success(res, { deleted: true });
  } catch (err) {
    sendSafeError(res, err, "Could not delete the backup.");
  }
}

export async function getDownloadUrlHandler(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const row = await getBackup(businessId, Number(req.params.id));
    const url = getDownloadUrl(row);
    success(res, { url, expiresIn: 600, fileName: row.fileName });
  } catch (err) {
    sendSafeError(res, err, "Could not create a download link.");
  }
}

export async function getDownloadStream(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const row = await getBackup(businessId, Number(req.params.id));
    if (row.status !== "completed") {
      throw new ConflictError("Only completed backups can be downloaded.");
    }
    const { stream, fileName, size } = await openPackageStream(row);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName.replace(/"/g, "")}"`,
    );
    if (size) res.setHeader("Content-Length", String(size));
    stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) sendSafeError(res, err, "Could not download the backup.");
  }
}

// --- upload ------------------------------------------------------------------

export async function postUploadPresign(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    if (!backupStorageEnabled()) {
      throw new ConflictError(
        "Upload requires object storage to be configured (S3 credentials).",
      );
    }
    const { presignPackageUpload } = await import("./backupStorage.js");
    const { storageKey, uploadUrl } = presignPackageUpload(businessId);
    success(res, { storageKey, uploadUrl, maxMb: 200 });
  } catch (err) {
    sendSafeError(res, err, "Could not create an upload link.");
  }
}

export async function postUploadRegister(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(registerUploadSchema, req.body);
    if (!input.storageKey.startsWith(`businesses/${businessId}/uploads/`)) {
      throw new ConflictError("Upload key does not belong to this business.");
    }
    const row = await registerUploadedPackage({
      businessId,
      userId: req.user!.id,
      storageKey: input.storageKey,
      fileName: input.fileName,
    });
    success(res, row);
  } catch (err) {
    sendSafeError(res, err, "Could not register the uploaded package.");
  }
}

// --- restore -----------------------------------------------------------------

export async function postRestorePreview(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(restorePreviewSchema, req.body);
    const preview = await previewRestore({
      businessId,
      backupId: input.backupId,
      mode: input.mode,
      moduleKeys: normalizeModuleKeys(input.modules),
    });
    success(res, preview);
  } catch (err) {
    sendSafeError(res, err, "Could not preview the restore.");
  }
}

export async function postRestore(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(restoreSchema, req.body);
    // Preview first — restore refuses to run without a ready preview this
    // session (the preview performs integrity + identity validation).
    const preview = await previewRestore({
      businessId,
      backupId: input.backupId,
      mode: input.mode,
      moduleKeys: input.modules ?? null,
    });
    if (!preview.readyForRestore) {
      throw new ConflictError(
        `Restore is not safe to run: ${preview.checks
          .filter((c) => !c.ok)
          .map((c) => c.check)
          .join(", ")}.`,
      );
    }
    const job = await createRestoreJob({
      businessId,
      userId: req.user!.id,
      mode: input.mode,
      backupId: input.backupId,
      moduleKeys: preview.requestedModules,
      confirm: input.confirm,
    });
    res.status(202).json({
      success: true,
      data: job,
      message: "Restore started. You will be notified when it finishes.",
    });
  } catch (err) {
    sendSafeError(res, err, "Could not start the restore.");
  }
}

export async function getRestoreJob(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const { db } = await import("../../db/schema/index.js");
    const { restoreJobs } = await import("../../db/schema/backups.js");
    const { and, eq } = await import("drizzle-orm");
    const [job] = await db
      .select()
      .from(restoreJobs)
      .where(
        and(
          eq(restoreJobs.id, Number(req.params.id)),
          eq(restoreJobs.businessId, businessId),
        ),
      )
      .limit(1);
    if (!job) throw new NotFoundError("Restore job not found.");
    success(res, job);
  } catch (err) {
    sendSafeError(res, err, "Restore job not found.");
  }
}

// --- schedule ----------------------------------------------------------------

export async function getScheduleHandler(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    success(res, {
      schedule: await getSchedule(businessId),
      storageEnabled: backupStorageEnabled(),
    });
  } catch (err) {
    sendSafeError(res, err, "Could not load the backup schedule.");
  }
}

export async function putSchedule(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(scheduleSchema, req.body);
    const row = await upsertSchedule(businessId, req.user!.id, {
      enabled: input.enabled,
      frequency: input.frequency,
      hour: input.hour,
      dayOfWeek: input.dayOfWeek ?? null,
      retentionDays: input.retentionDays,
    });
    success(res, row);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: err.issues[0]?.message ?? "Invalid schedule settings.",
      });
      return;
    }
    sendSafeError(res, err, "Could not save the backup schedule.");
  }
}

// Re-exported for tests that want to await a job synchronously.
export { runBackupJob };
