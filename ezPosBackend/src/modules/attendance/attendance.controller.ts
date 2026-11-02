import type { Request, Response } from "express";
import * as attendanceService from "../../services/attendance.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

export async function clockIn(req: Request, res: Response) {
  try {
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : null;
    const record = await attendanceService.clockIn(
      getBusinessId(req),
      getLocationIdSafe(req),
      req.user!.id,
      note,
    );
    return res.status(201).json({ success: true, data: record });
  } catch (err) {
    return sendSafeError(res, err, "Unable to clock in.");
  }
}

export async function clockOut(req: Request, res: Response) {
  try {
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : null;
    const record = await attendanceService.clockOut(getBusinessId(req), req.user!.id, note);
    return res.status(200).json({ success: true, data: record });
  } catch (err) {
    return sendSafeError(res, err, "Unable to clock out.");
  }
}

export async function startBreak(req: Request, res: Response) {
  try {
    const created = await attendanceService.startBreak(getBusinessId(req), req.user!.id);
    return res.status(201).json({ success: true, data: created });
  } catch (err) {
    return sendSafeError(res, err, "Unable to start the break.");
  }
}

export async function endBreak(req: Request, res: Response) {
  try {
    const result = await attendanceService.endBreak(getBusinessId(req), req.user!.id);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to end the break.");
  }
}

export async function myStatus(req: Request, res: Response) {
  try {
    const status = await attendanceService.getMyStatus(
      getBusinessId(req),
      req.user!.id,
    );
    return res.status(200).json({ success: true, data: status });
  } catch (err) {
    return sendSafeError(res, err, "Unable to read the attendance status.");
  }
}

export async function myHistory(req: Request, res: Response) {
  try {
    const rows = await attendanceService.getMyHistory(getBusinessId(req), req.user!.id);
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to read the attendance history.");
  }
}

export async function allAttendance(req: Request, res: Response) {
  try {
    const rows = await attendanceService.getAllAttendance(getBusinessId(req));
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to read the attendance records.");
  }
}

export async function approve(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    await attendanceService.assertAttendanceExists(getBusinessId(req), id);
    const result = await attendanceService.approveAttendance(
      getBusinessId(req),
      id,
      req.user!.id,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to approve the record.");
  }
}

export async function summary(req: Request, res: Response) {
  try {
    const days = Number(req.query.days ?? 30);
    const windowDays = Number.isFinite(days) && days >= 1 && days <= 365 ? Math.floor(days) : 30;
    const rows = await attendanceService.getAttendanceSummary(
      getBusinessId(req),
      windowDays,
    );
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to build the attendance summary.");
  }
}

function getLocationIdSafe(req: Request): number {
  // The clock-in route runs requireLocationAccess; the resolved id lands here.
  const location = (req as Request & { location?: { locationId: number } }).location;
  if (!location) throw new Error("attendance clock-in requires location access");
  return location.locationId;
}
