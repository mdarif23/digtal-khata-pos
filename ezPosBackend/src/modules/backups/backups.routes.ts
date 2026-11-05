import express from "express";
import * as backupsController from "./backups.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import {
  requirePermission,
  requireAnyPermission,
} from "../../middleware/permissions.js";
import { backupMutationRateLimit, backupDownloadRateLimit } from "../../middleware/rateLimit.js";

const router = express.Router();

/**
 * Backups are owner/manager territory: backups.view to see anything,
 * backups.restore is deliberately owner-tier (only the owner template gets
 * it — the wildcard covers it, staff templates never include it).
 */
const read = [
  requireAuth,
  requireBusinessContext(),
  requirePermission("backups.view"),
] as const;
const write = [...read, requireFullAccess, requirePermission("backups.create")] as const;
const download = [...read, requireFullAccess, requirePermission("backups.download")] as const;
const verify = [...read, requireFullAccess, requirePermission("backups.verify")] as const;
const remove = [...read, requireFullAccess, requirePermission("backups.delete")] as const;
const restore = [
  ...read,
  requireFullAccess,
  requirePermission("backups.restore"),
] as const;

// Module metadata for the settings UI.
router.get("/api/backups/modules", ...read, backupsController.getModules);

// Manual backup + history.
router.post(
  "/api/backups",
  ...write,
  backupMutationRateLimit,
  backupsController.postCreateBackup,
);
router.get("/api/backups", ...read, backupsController.getList);
// Static segment before /:id.
router.get(
  "/api/backups/schedule",
  ...read,
  backupsController.getScheduleHandler,
);
router.put("/api/backups/schedule", ...write, backupsController.putSchedule);
router.get("/api/backups/:id", ...read, backupsController.getOne);
router.post("/api/backups/:id/verify", ...verify, backupsController.postVerify);
router.delete("/api/backups/:id", ...remove, backupsController.deleteOne);
router.get(
  "/api/backups/:id/download-url",
  ...download,
  backupDownloadRateLimit,
  backupsController.getDownloadUrlHandler,
);
router.get(
  "/api/backups/:id/download",
  ...download,
  backupDownloadRateLimit,
  backupsController.getDownloadStream,
);

// Upload flow (.ezbackup packages).
router.post(
  "/api/backups/upload/presign",
  ...write,
  backupMutationRateLimit,
  backupsController.postUploadPresign,
);
router.post(
  "/api/backups/upload/register",
  ...write,
  backupsController.postUploadRegister,
);

// Restore pipeline.
router.post("/api/backups/restore/preview", ...restore, backupsController.postRestorePreview);
router.post(
  "/api/backups/restore",
  ...restore,
  backupMutationRateLimit,
  backupsController.postRestore,
);
router.get("/api/backups/restore/:id", ...read, backupsController.getRestoreJob);

export default router;
