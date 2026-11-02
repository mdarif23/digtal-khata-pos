import express from "express";
import * as attendanceController from "./attendance.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";

/**
 * Attendance / timeclock (Module 8). Self-service clock in/out and breaks
 * for anyone with attendance.view; managers (attendance.manage) see all
 * records, approve, and read the summary. Records are immutable once
 * clocked out — approval is a signal, never a time edit.
 */
const router = express.Router();

const self = [
  requireAuth,
  requireBusinessContext(),
  requireFullAccess,
] as const;

const clock = [...self, requireLocationAccess()] as const;

router.post(
  "/api/attendance/clock-in",
  ...clock,
  requirePermission("attendance.view"),
  attendanceController.clockIn,
);
router.post(
  "/api/attendance/clock-out",
  ...self,
  requirePermission("attendance.view"),
  attendanceController.clockOut,
);
router.post(
  "/api/attendance/break/start",
  ...self,
  requirePermission("attendance.view"),
  attendanceController.startBreak,
);
router.post(
  "/api/attendance/break/end",
  ...self,
  requirePermission("attendance.view"),
  attendanceController.endBreak,
);
router.get(
  "/api/attendance/me",
  ...self,
  requirePermission("attendance.view"),
  attendanceController.myStatus,
);
router.get(
  "/api/attendance/me/history",
  ...self,
  requirePermission("attendance.view"),
  attendanceController.myHistory,
);
router.get(
  "/api/attendance",
  ...self,
  requirePermission("attendance.manage"),
  attendanceController.allAttendance,
);
router.post(
  "/api/attendance/:id/approve",
  ...self,
  requirePermission("attendance.manage"),
  attendanceController.approve,
);
router.get(
  "/api/attendance/summary",
  ...self,
  requirePermission("attendance.manage"),
  attendanceController.summary,
);

export default router;
