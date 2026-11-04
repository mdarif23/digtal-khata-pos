import {
  bigint,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { expenses } from "./expenses.js";
import { users } from "./users.js";

/**
 * Metadata for expense attachments (receipts, invoices) stored in object
 * storage. Bytes are never proxied through the API — the browser PUTs
 * directly to a presigned URL, then the upload is registered here after a
 * HEAD existence check. Unlike storefront media these documents are PRIVATE:
 * reads only happen through short-lived presigned GET URLs issued after an
 * ownership check. Deletion is a soft delete so financial provenance stays
 * auditable; storage objects are retained (access is revoked by the row).
 *
 * objectKey layout: `businesses/{businessId}/expenses/{uuid}.{ext}`.
 */
export const expenseAttachments = pgTable(
  "expense_attachments",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    expenseId: integer("expense_id").notNull(),
    objectKey: varchar("object_key", { length: 300 }).notNull(),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    uploadedBy: integer("uploaded_by"),
    deletedAt: timestamp("deleted_at", { mode: "string" }),
    deletedBy: integer("deleted_by"),
    createdAt: timestamp("created_at", { mode: "string" }).default(
      sql`CURRENT_TIMESTAMP`,
    ),
  },
  (table) => [
    foreignKey({
      columns: [table.expenseId, table.businessId],
      foreignColumns: [expenses.id, expenses.businessId],
      name: "expense_attachments_expense_business_fkey",
    }),
    foreignKey({
      columns: [table.uploadedBy],
      foreignColumns: [users.id],
      name: "expense_attachments_uploaded_by_users_fk",
    }),
    foreignKey({
      columns: [table.deletedBy],
      foreignColumns: [users.id],
      name: "expense_attachments_deleted_by_users_fk",
    }),
    uniqueIndex("expense_attachments_object_key_unique").on(table.objectKey),
    index("expense_attachments_expense_idx").on(table.expenseId),
    index("expense_attachments_business_idx").on(table.businessId),
  ],
);
