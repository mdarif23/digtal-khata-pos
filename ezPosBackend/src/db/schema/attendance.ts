import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
import { users } from "./users.js";

/**
 * Attendance / timeclock (Module 8). Records are immutable once clocked
 * out — corrections go through manager approval, never edits. Hours are
 * computed from UTC timestamps; display is client-local. Breaks are
 * tracked on the open record (one open break at a time).
 */
export const attendanceRecords = pgTable(
  "attendance_records",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    locationId: integer("location_id").notNull(),
    clockIn: timestamp("clock_in", { withTimezone: true })
      .defaultNow()
      .notNull(),
    clockOut: timestamp("clock_out", { withTimezone: true }),
    clockInNote: text("clock_in_note"),
    clockOutNote: text("clock_out_note"),
    approvedByUserId: integer("approved_by_user_id").references(
      () => users.id,
    ),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.locationId, t.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "attendance_records_location_business_fkey",
    }),
    index("attendance_records_business_user_idx").on(t.businessId, t.userId),
    check(
      "attendance_records_clock_order",
      sql`${t.clockOut} is null or ${t.clockOut} > ${t.clockIn}`,
    ),
  ],
);

export const attendanceBreaks = pgTable(
  "attendance_breaks",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    recordId: integer("record_id")
      .notNull()
      .references(() => attendanceRecords.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("attendance_breaks_record_idx").on(t.recordId),
    check(
      "attendance_breaks_order",
      sql`${t.endedAt} is null or ${t.endedAt} > ${t.startedAt}`,
    ),
  ],
);
