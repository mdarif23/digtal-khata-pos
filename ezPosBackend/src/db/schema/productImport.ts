import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { users } from "./users.js";

/**
 * Product import/export (bulk catalog management).
 *
 * Sessions persist the whole pipeline state (upload → mapping → validation →
 * execution → results) so the wizard can navigate away and poll, so row-level
 * errors survive for downloadable reports, and so a repeated upload of the
 * same file (same sha256) can be detected for idempotency. Original file
 * bytes are NOT retained — parsing happens in memory (capped) and only the
 * normalized rows persist.
 *
 * Concurrency: the partial unique index allows exactly ONE running session
 * per business at a time.
 */

export const productImportStatusEnum = pgEnum("product_import_status", [
  "draft",
  "mapped",
  "validated",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const productImportRowStatusEnum = pgEnum("product_import_row_status", [
  "pending",
  "valid",
  "error",
  "created",
  "updated",
  "skipped",
  "failed",
]);

export const productImportModeEnum = pgEnum("product_import_mode", [
  "create",
  "update",
  "upsert",
  "skip",
]);

export const productImportMatchByEnum = pgEnum("product_import_match_by", [
  "variant_sku",
  "product_sku",
  "barcode",
]);

export const productImportSessions = pgTable(
  "product_import_sessions",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    /**
     * Phase 1: which entity this session imports — 'products' (default) or
     * the contact imports ('customers' | 'suppliers'). The one-running-per-
     * business index became per business+entity (migration 0066).
     */
    entityType: varchar("entity_type", { length: 20 })
      .notNull()
      .default("products"),
    filename: varchar("filename", { length: 255 }).notNull(),
    fileHash: varchar("file_hash", { length: 64 }).notNull(),
    fileSize: integer("file_size").notNull(),
    worksheet: varchar("worksheet", { length: 200 }),
    headerRow: integer("header_row").notNull().default(1),
    status: productImportStatusEnum("status").notNull().default("draft"),
    mode: productImportModeEnum("mode").notNull().default("create"),
    matchBy: productImportMatchByEnum("match_by").notNull().default("variant_sku"),
    /** Column mapping + reusable profile: { columns: {[file]: field}, profileName? } */
    mapping: jsonb("mapping"),
    /** Execution options: { updateFields: string[], createMissingMasterData: bool } */
    options: jsonb("options"),
    /** Counters: { totalRows, validRows, errorRows, created, updated, skipped, failed, warnings } */
    totals: jsonb("totals").default(sql`'{}'::jsonb`),
    processingMs: integer("processing_ms"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("product_import_sessions_business_idx").on(
      table.businessId,
      table.createdAt,
    ),
    uniqueIndex("product_import_sessions_one_running_uq")
      .on(table.businessId)
      .where(sql`status = 'running'`),
    index("product_import_sessions_hash_idx").on(table.businessId, table.fileHash),
  ],
);

export const productImportRows = pgTable(
  "product_import_rows",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    sessionId: integer("session_id").notNull(),
    /** Original spreadsheet row number (1-based, header-aware). */
    rowNumber: integer("row_number").notNull(),
    /** Display reference built at parse time: "Football (Small)" / plain name. */
    productRef: varchar("product_ref", { length: 255 }),
    status: productImportRowStatusEnum("status").notNull().default("pending"),
    /** Normalized row payload + grouping key. */
    payload: jsonb("payload"),
    /** Row-level issues: [{ code, message, field? }] */
    errors: jsonb("errors"),
    /** Execution result: { productId, variantId, variantIds, sku, action } */
    result: jsonb("result"),
  },
  (table) => [
    index("product_import_rows_session_idx").on(table.sessionId, table.rowNumber),
    uniqueIndex("product_import_rows_id_business_uq").on(
      table.id,
      table.businessId,
    ),
  ],
);
