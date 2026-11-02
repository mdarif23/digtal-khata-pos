import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";

export const customers = pgTable(
  "customers",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    name: varchar({ length: 255 }).notNull(),
    phone: varchar({ length: 20 }),
    email: varchar({ length: 255 }),
    address: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("customers_business_id_idx").on(table.businessId)],
);
