import {
  index,
  integer,
  pgTable,
  serial,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";

export const categories = pgTable(
  "categories",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    name: varchar({ length: 100 }).notNull(),
    description: varchar({ length: 200 }),
    parentId: integer("parent_id").references((): AnyPgColumn => categories.id),
    status: varchar({ length: 30 }),
  },
  (table) => [
    index("categories_business_id_idx").on(table.businessId),
    // Candidate key for composite tenant FKs from the pricing tables
    // (pricing_rules / customer_group_pricing / pricing_promotions,
    // migration 0063) — same pattern as products_id_business_uq.
    uniqueIndex("categories_id_business_uq").on(table.id, table.businessId),
  ],
);
