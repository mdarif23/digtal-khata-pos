import {
  boolean,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";

export const suppliers = pgTable(
  "suppliers",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    name: varchar({ length: 100 }).notNull(),
    phone: varchar({ length: 20 }),
    email: varchar({ length: 255 }),
    address: text(),
    status: varchar({ length: 50 }).default("active"),
    // Smart Procurement (supplier order-value management): the minimum
    // order value is the supplier's requirement, the target order value is
    // the business's own spending goal — the two are independent. Null =
    // not configured; the flag disables the feature without deleting the
    // values.
    minimumOrderValue: numeric("minimum_order_value", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    targetOrderValue: numeric("target_order_value", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    orderSettingsEnabled: boolean("order_settings_enabled")
      .notNull()
      .default(false),
    orderSettingsNotes: text("order_settings_notes"),
  },
  (table) => [
    index("suppliers_business_id_idx").on(table.businessId),
    unique("suppliers_id_business_uq").on(table.id, table.businessId),
  ],
);

