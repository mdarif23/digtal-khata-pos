import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { ticketAuthorEnum, ticketStatusEnum } from "./saasEnums.js";
import { businesses } from "./businesses.js";
import { users } from "./users.js";

/**
 * Support / contact tickets. The public contact form creates tickets with
 * no business or user attached (anonymous visitors); tickets opened from the
 * customer portal later will carry both.
 */
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id").references(() => businesses.id, {
      onDelete: "set null",
    }),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: varchar({ length: 120 }).notNull(),
    email: varchar({ length: 255 }).notNull(),
    phone: varchar({ length: 30 }),
    subject: varchar({ length: 200 }).notNull(),
    message: text().notNull(),
    category: varchar({ length: 40 }).default("general").notNull(),
    priority: varchar({ length: 10 }).default("normal").notNull(),
    status: ticketStatusEnum("status").default("open").notNull(),
    source: varchar({ length: 40 }).default("contact").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("support_tickets_status_idx").on(table.status),
    index("support_tickets_email_idx").on(table.email),
  ],
);

export const supportTicketMessages = pgTable(
  "support_ticket_messages",
  {
    id: serial().primaryKey().notNull(),
    ticketId: integer("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    authorType: ticketAuthorEnum("author_type").notNull(),
    authorUserId: integer("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    body: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("support_ticket_messages_ticket_idx").on(table.ticketId)],
);
