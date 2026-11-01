import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { users } from "./users.js";

/**
 * General-purpose audit trail for business-scoped financial operations
 * (sale created, refunds issued, payment verification outcomes, register
 * movements). Platform-owner actions live in saas_admin_audit; subscription
 * lifecycle changes land in subscription_events.
 *
 * Written transactionally with the operation it describes (see
 * services/audit.ts) so an audit entry can never be lost while the change
 * it describes commits — or recorded for a change that rolled back.
 *
 * metadata is deliberately shallow and non-sensitive: amounts, statuses and
 * identifiers only. NEVER store payment references, gateway tokens, or
 * credentials here.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id").references(() => businesses.id, {
      onDelete: "set null",
    }),
    /** null = performed by the system (jobs, gateway IPN callbacks). */
    actorUserId: integer("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: varchar({ length: 80 }).notNull(), // e.g. "sale.create", "sale.refund"
    entityType: varchar("entity_type", { length: 40 }).notNull(),
    entityId: integer("entity_id"),
    metadata: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_log_business_created_idx").on(
      table.businessId,
      table.createdAt,
    ),
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
  ],
);
