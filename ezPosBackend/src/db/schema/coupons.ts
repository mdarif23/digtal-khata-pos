import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";

/**
 * Coupons (Module 6): business-scoped codes with validity windows, order
 * minimums, discount caps, total + per-customer usage limits. Redemptions
 * are recorded per sale (one per sale) so usage limits hold and discount
 * history stays inspectable. Auto-applied promotions (BOGO, category
 * rules) are a future engine on top of this foundation.
 */
export const coupons = pgTable(
  "coupons",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    code: varchar({ length: 60 }).notNull(),
    description: text(),
    discountType: varchar("discount_type", { length: 20 }).notNull(),
    value: numeric("value", { precision: 12, scale: 2, mode: "number" })
      .notNull(),
    minOrderAmount: numeric(
      "min_order_amount",
      { precision: 12, scale: 2, mode: "number" },
    )
      .notNull()
      .default(0),
    maxDiscountAmount: numeric(
      "max_discount_amount",
      { precision: 12, scale: 2, mode: "number" },
    ),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    usageLimit: integer("usage_limit"),
    perCustomerLimit: integer("per_customer_limit"),
    usedCount: integer("used_count").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("coupons_business_code_unique").on(t.businessId, t.code),
    index("coupons_business_idx").on(t.businessId),
    check(
      "coupons_type_valid",
      sql`${t.discountType} in ('percentage','fixed')`,
    ),
    check("coupons_value_positive", sql`${t.value} >= 0`),
  ],
);

export const couponRedemptions = pgTable(
  "coupon_redemptions",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    couponId: integer("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    saleId: integer("sale_id").notNull(),
    customerId: integer("customer_id"),
    discountAmount: numeric(
      "discount_amount",
      { precision: 12, scale: 2, mode: "number" },
    ).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("coupon_redemptions_sale_unique").on(t.saleId),
    index("coupon_redemptions_coupon_idx").on(t.couponId),
    check(
      "coupon_redemptions_discount_positive",
      sql`${t.discountAmount} > 0`,
    ),
  ],
);
