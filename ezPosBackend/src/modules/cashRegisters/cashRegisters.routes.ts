import express from "express";
import * as cashRegistersController from "./cashRegisters.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requireTerminalContext } from "../../middleware/terminalContext.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
// Register operations are location-scoped: the X-Location-Id header (or the
// business default) is validated against membership + assignment.
const locationRead = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
// Writes resolve the optional X-Terminal-Id header — opening a session from
// a bound terminal records that terminal on the drawer session (and a
// revoked terminal cannot open one at all).
const locationWrite = [
  ...locationRead,
  requireTerminalContext(),
  requireFullAccess,
] as const;
const manage = [
  ...locationWrite,
  requirePermission("settings.edit"),
] as const;

router.get("/api/registers", ...locationRead, cashRegistersController.getRegisters);
router.post("/api/registers", ...manage, cashRegistersController.postRegister);
router.patch("/api/registers/:registerId", ...manage, cashRegistersController.patchRegister);
router.post("/api/registers/:registerId/open", ...locationWrite, cashRegistersController.postRegisterOpen);

// Session routes are user-scoped (no X-Location-Id requirement): the
// service enforces that only the session owner (or the owner account)
// operates a session.
const sessionRead = [requireAuth, requireBusinessContext()] as const;
const sessionWrite = [...sessionRead, requireFullAccess] as const;

router.get("/api/sessions/current", ...sessionRead, cashRegistersController.getCurrentSessionHandler);
// Register summaries feed the reports hub — financial report scope.
router.get(
  "/api/reports/registers",
  ...sessionRead,
  requirePermission("reports.financial.view"),
  cashRegistersController.getRegisterSessionReportHandler,
);
router.get("/api/sessions/:sessionId", ...sessionRead, cashRegistersController.getSessionHandler);
router.post("/api/sessions/:sessionId/cash-movement", ...sessionWrite, cashRegistersController.postCashMovement);
router.post("/api/sessions/:sessionId/close", ...sessionWrite, cashRegistersController.postCloseSession);

export default router;
