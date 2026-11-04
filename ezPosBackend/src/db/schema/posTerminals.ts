import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { locations } from "./locations.js";
import { users } from "./users.js";
import { sales } from "./sales.js";

export const terminalStatusEnum = pgEnum("terminal_status", [
  "active",
  "inactive",
]);

export const hardwareCommandTypeEnum = pgEnum("hardware_command_type", [
  "drawer_open",
]);

/**
 * Terminal command lifecycle. Terminal acks: received → validated →
 * executing → completed | failed | unknown_outcome. pending → received
 * happens when the bridge claims the command. expired is set server-side.
 * completed/failed/expired/unknown_outcome are terminal states.
 */
export const hardwareCommandStatusEnum = pgEnum("hardware_command_status", [
  "pending",
  "received",
  "validated",
  "executing",
  "completed",
  "failed",
  "expired",
  "unknown_outcome",
]);

/**
 * A POS terminal: one Windows computer running the local hardware bridge.
 * Registered by a pos_terminal.manage holder, then PAIRED by the bridge
 * through a one-time code. The bridge secret is stored SHA-256 hashed —
 * shown once at pairing/rotation, never retrievable.
 */
export const posTerminals = pgTable(
  "pos_terminals",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    locationId: integer("location_id").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    status: terminalStatusEnum("status").default("active").notNull(),
    secretHash: varchar("secret_hash", { length: 64 }),
    pairedAt: timestamp("paired_at", { withTimezone: true }),
    createdBy: integer("created_by")
      .references(() => users.id, { onDelete: "set null" }),
    deviceInfo: jsonb("device_info"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("pos_terminals_location_name_unique").on(
      table.locationId,
      table.name,
    ),
    unique("pos_terminals_id_business_uq").on(table.id, table.businessId),
    index("pos_terminals_business_location_idx").on(
      table.businessId,
      table.locationId,
    ),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "pos_terminals_location_business_fkey",
    }),
  ],
);

/**
 * One-time pairing codes: a pos_terminal.manage holder mints a code in the
 * POS UI, types it into the local bridge, and the bridge exchanges it for
 * a terminal secret. Codes are stored hashed, expire quickly, and are
 * single-use (used_at set transactionally on redemption).
 */
export const terminalPairingCodes = pgTable(
  "terminal_pairing_codes",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    locationId: integer("location_id").notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    createdBy: integer("created_by")
      .references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("terminal_pairing_codes_code_hash_uq").on(table.codeHash),
    index("terminal_pairing_codes_business_idx").on(table.businessId),
  ],
);

/**
 * Targeted hardware commands. The backend authors the command (a drawer
 * kick, currently) and the PAIRED terminal claims and executes it. The
 * command row is the audit trail: requested_by, every ack, and the final
 * outcome — never a financial record. Duplicate execution is prevented by
 * the terminal-state machine (terminal states are immutable) and expiry.
 */
export const hardwareCommands = pgTable(
  "hardware_commands",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    terminalId: integer("terminal_id").notNull(),
    type: hardwareCommandTypeEnum("type").notNull(),
    status: hardwareCommandStatusEnum("status").default("pending").notNull(),
    requestedBy: integer("requested_by")
      .references(() => users.id, { onDelete: "set null" }),
    saleId: integer("sale_id").references(() => sales.id, {
      onDelete: "set null",
    }),
    reason: varchar("reason", { length: 200 }),
    note: text(),
    result: jsonb("result"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("hardware_commands_id_business_uq").on(table.id, table.businessId),
    index("hardware_commands_terminal_status_idx").on(
      table.terminalId,
      table.status,
    ),
    index("hardware_commands_business_idx").on(
      table.businessId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.terminalId, table.businessId],
      foreignColumns: [posTerminals.id, posTerminals.businessId],
      name: "hardware_commands_terminal_business_fkey",
    }),
  ],
);
