import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { storefronts } from "./storefronts.js";
import { storefrontPaymentMethodEnum } from "./storefrontEnums.js";

/**
 * Checkout payment methods a storefront offers, with per-storefront config.
 * Gateway credentials stay in platform env/config — never in this table, and
 * never exposed to storefront browsers. Online capture (verification, IPN)
 * lands in the payments stage; this table only governs what checkout offers.
 */
export const storefrontPaymentMethods = pgTable(
  "storefront_payment_methods",
  {
    id: serial().primaryKey().notNull(),
    storefrontId: integer("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    method: storefrontPaymentMethodEnum("method").notNull(),
    enabled: boolean().default(false).notNull(),
    /** Display label / instructions only — no secrets here. */
    config: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
    label: varchar({ length: 100 }),
  },
  (table) => [
    uniqueIndex("storefront_payment_methods_unique").on(
      table.storefrontId,
      table.method,
    ),
    index("storefront_payment_methods_storefront_idx").on(table.storefrontId),
  ],
);
