import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessContext } from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";
import * as controller from "./auditLog.controller.js";

const router = express.Router();

// Phase 1: the centralized audit view is permission-gated server-side —
// users without audit.view never reach the data (master prompt F12-E).
const read = [
  requireAuth,
  requireBusinessContext(),
  requirePermission("audit.view"),
] as const;
const exporter = [
  requireAuth,
  requireBusinessContext(),
  requirePermission("audit.export"),
] as const;

router.get("/api/audit-log", ...read, controller.getAuditLog);
router.get("/api/audit-log/export", ...exporter, controller.getAuditLogExport);

export default router;
