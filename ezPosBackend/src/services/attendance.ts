import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import {
  attendanceBreaks,
  attendanceRecords,
} from "../db/schema/attendance.js";
import { users } from "../db/schema/users.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/handleError.js";
import { roundMoney } from "../utils/roundMoney.js";
import { recordAudit } from "./audit.js";

/**
 * Attendance / timeclock (Module 8). One open record per user; breaks on
 * the open record (one open break at a time); records immutable once
 * clocked out — managers approve, they do not edit times. All timestamps
 * are UTC; the client renders local time.
 */

export async function clockIn(
  businessId: number,
  locationId: number,
  userId: number,
  note?: string | null,
) {
  return db.transaction(async (tx) => {
    const [open] = await tx
      .select({ id: attendanceRecords.id })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.businessId, businessId),
          eq(attendanceRecords.userId, userId),
          isNull(attendanceRecords.clockOut),
        ),
      )
      .limit(1);
    if (open) {
      throw new ConflictError(
        "You are already clocked in — clock out first.",
      );
    }
    const [created] = await tx
      .insert(attendanceRecords)
      .values({
        businessId,
        userId,
        locationId,
        clockInNote: note ?? null,
      })
      .returning();
    if (!created) throw new Error("Attendance insert returned no row.");
    await recordAudit({
      businessId,
      actorUserId: userId,
      action: "attendance.clock_in",
      entityType: "attendance_record",
      entityId: created.id,
      metadata: { locationId },
    });
    return created;
  });
}

async function getOpenRecord(
  businessId: number,
  userId: number,
): Promise<{ id: number } | null> {
  const [open] = await db
    .select({ id: attendanceRecords.id })
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.businessId, businessId),
        eq(attendanceRecords.userId, userId),
        isNull(attendanceRecords.clockOut),
      ),
    )
    .limit(1);
  return open ?? null;
}

export async function clockOut(
  businessId: number,
  userId: number,
  note?: string | null,
) {
  return db.transaction(async (tx) => {
    const open = await getOpenRecord(businessId, userId);
    if (!open) throw new ConflictError("You are not clocked in.");
    // Close any open break automatically — clocking out ends the day.
    await tx
      .update(attendanceBreaks)
      .set({ endedAt: new Date() })
      .where(
        and(
          eq(attendanceBreaks.recordId, open.id),
          isNull(attendanceBreaks.endedAt),
        ),
      );
    const [updated] = await tx
      .update(attendanceRecords)
      .set({ clockOut: new Date(), clockOutNote: note ?? null, updatedAt: new Date() })
      .where(
        and(
          eq(attendanceRecords.id, open.id),
          eq(attendanceRecords.businessId, businessId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundError("Attendance record not found.");
    await recordAudit({
      businessId,
      actorUserId: userId,
      action: "attendance.clock_out",
      entityType: "attendance_record",
      entityId: open.id,
      metadata: {},
    });
    return updated;
  });
}

export async function startBreak(businessId: number, userId: number) {
  const open = await getOpenRecord(businessId, userId);
  if (!open) throw new ConflictError("You are not clocked in.");
  const [openBreak] = await db
    .select({ id: attendanceBreaks.id })
    .from(attendanceBreaks)
    .where(
      and(
        eq(attendanceBreaks.recordId, open.id),
        isNull(attendanceBreaks.endedAt),
      ),
    )
    .limit(1);
  if (openBreak) {
    throw new ConflictError("You are already on a break.");
  }
  const [created] = await db
    .insert(attendanceBreaks)
    .values({ businessId, recordId: open.id })
    .returning();
  if (!created) throw new Error("Break insert returned no row.");
  return created;
}

export async function endBreak(businessId: number, userId: number) {
  const open = await getOpenRecord(businessId, userId);
  if (!open) throw new ConflictError("You are not clocked in.");
  const [ended] = await db
    .update(attendanceBreaks)
    .set({ endedAt: new Date() })
    .where(
      and(
        eq(attendanceBreaks.recordId, open.id),
        isNull(attendanceBreaks.endedAt),
      ),
    )
    .returning({ id: attendanceBreaks.id });
  if (!ended) throw new ConflictError("You are not on a break.");
  return { ended: true };
}

export interface AttendanceStatus {
  clockedIn: boolean;
  onBreak: boolean;
  recordId: number | null;
  clockIn: string | null;
  openBreakStartedAt: string | null;
}

export async function getMyStatus(
  businessId: number,
  userId: number,
): Promise<AttendanceStatus> {
  const open = await getOpenRecord(businessId, userId);
  if (!open) {
    return {
      clockedIn: false,
      onBreak: false,
      recordId: null,
      clockIn: null,
      openBreakStartedAt: null,
    };
  }
  const [record] = await db
    .select({ clockIn: attendanceRecords.clockIn })
    .from(attendanceRecords)
    .where(eq(attendanceRecords.id, open.id))
    .limit(1);
  const [openBreak] = await db
    .select({ startedAt: attendanceBreaks.startedAt })
    .from(attendanceBreaks)
    .where(
      and(
        eq(attendanceBreaks.recordId, open.id),
        isNull(attendanceBreaks.endedAt),
      ),
    )
    .limit(1);
  return {
    clockedIn: true,
    onBreak: openBreak !== undefined,
    recordId: open.id,
    clockIn: record?.clockIn?.toISOString() ?? null,
    openBreakStartedAt: openBreak?.startedAt.toISOString() ?? null,
  };
}

export async function getMyHistory(businessId: number, userId: number) {
  const records = await db
    .select({
      id: attendanceRecords.id,
      clockIn: attendanceRecords.clockIn,
      clockOut: attendanceRecords.clockOut,
      clockInNote: attendanceRecords.clockInNote,
      clockOutNote: attendanceRecords.clockOutNote,
      approvedAt: attendanceRecords.approvedAt,
      locationId: attendanceRecords.locationId,
    })
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.businessId, businessId),
        eq(attendanceRecords.userId, userId),
      ),
    )
    .orderBy(desc(attendanceRecords.clockIn))
    .limit(60);
  return records.map((record) => ({
    ...record,
    workedHours:
      record.clockOut !== null
        ? roundMoney(
            (record.clockOut.getTime() - record.clockIn.getTime()) / 3_600_000,
          )
        : null,
  }));
}

/** Manager view: every user's records. */
export async function getAllAttendance(businessId: number) {
  const records = await db
    .select({
      id: attendanceRecords.id,
      userId: attendanceRecords.userId,
      userName: users.fullName,
      clockIn: attendanceRecords.clockIn,
      clockOut: attendanceRecords.clockOut,
      approvedAt: attendanceRecords.approvedAt,
      locationId: attendanceRecords.locationId,
    })
    .from(attendanceRecords)
    .innerJoin(users, eq(users.id, attendanceRecords.userId))
    .where(eq(attendanceRecords.businessId, businessId))
    .orderBy(desc(attendanceRecords.clockIn))
    .limit(200);
  return records.map((record) => ({
    ...record,
    workedHours:
      record.clockOut !== null
        ? roundMoney(
            (record.clockOut.getTime() - record.clockIn.getTime()) / 3_600_000,
          )
        : null,
  }));
}

/** Managers approve records — an audit signal, not a time edit. */
export async function approveAttendance(
  businessId: number,
  recordId: number,
  approverUserId: number,
) {
  const [updated] = await db
    .update(attendanceRecords)
    .set({
      approvedByUserId: approverUserId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(attendanceRecords.id, recordId),
        eq(attendanceRecords.businessId, businessId),
        isNull(attendanceRecords.approvedAt),
      ),
    )
    .returning({ id: attendanceRecords.id });
  if (!updated) {
    throw new NotFoundError(
      "Open record not found or already approved — clocked-out records can be approved once.",
    );
  }
  await recordAudit({
    businessId,
    actorUserId: approverUserId,
    action: "attendance.approved",
    entityType: "attendance_record",
    entityId: recordId,
    metadata: {},
  });
  return { approved: true };
}

/** Per-user worked-hours summary (attendance report). */
export async function getAttendanceSummary(
  businessId: number,
  sinceDays: number,
) {
  const result = await db.execute(sql`
    SELECT u.id AS "userId", u.full_name AS "userName",
           COUNT(r.id)::int AS shifts,
           COALESCE(SUM(EXTRACT(EPOCH FROM (r.clock_out - r.clock_in)) / 3600), 0)::numeric AS "workedHours",
           COALESCE(SUM((
             SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (b.ended_at - b.started_at)) / 3600), 0)
             FROM attendance_breaks b WHERE b.record_id = r.id
           )), 0)::numeric AS "breakHours"
    FROM attendance_records r
    JOIN users u ON u.id = r.user_id
    WHERE r.business_id = ${businessId}
      AND r.clock_out IS NOT NULL
      AND r.clock_in >= now() - (${sinceDays} || ' days')::interval
    GROUP BY u.id, u.full_name
    ORDER BY "workedHours" DESC
  `);
  return (result.rows as Record<string, unknown>[]).map((row) => ({
    userId: Number(row.userId),
    userName: String(row.userName ?? ""),
    shifts: Number(row.shifts ?? 0),
    workedHours: roundMoney(Number(row.workedHours ?? 0)),
    breakHours: roundMoney(Number(row.breakHours ?? 0)),
  }));
}

export async function assertAttendanceExists(
  businessId: number,
  recordId: number,
): Promise<void> {
  const [record] = await db
    .select({ id: attendanceRecords.id })
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.id, recordId),
        eq(attendanceRecords.businessId, businessId),
      ),
    )
    .limit(1);
  if (!record) throw new NotFoundError("Attendance record not found.");
  void BadRequestError;
}
