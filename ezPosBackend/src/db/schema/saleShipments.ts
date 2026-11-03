import {
  foreignKey,
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
import { sales } from "./sales.js";
import { businesses } from "./businesses.js";

/**
 * Courier shipment for an online order. One active shipment per order —
 * failed delivery / redelivery updates this row; the full history lives in
 * sale_order_events. Manual courier tracking works without any courier API.
 */
export const saleShipments = pgTable(
  "sale_shipments",
  {
    id: serial().primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    saleId: integer("sale_id").notNull(),
    courierName: varchar("courier_name", { length: 120 }),
    courierService: varchar("courier_service", { length: 120 }),
    trackingNumber: varchar("tracking_number", { length: 120 }),
    shipmentDate: timestamp("shipment_date", { withTimezone: true }),
    expectedDeliveryDate: timestamp("expected_delivery_date", {
      withTimezone: true,
    }),
    /** What the courier charges the business (profitability expense side). */
    shippingCost: numeric("shipping_cost", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).default(0),
    /** preparing | in_transit | delivered | failed */
    status: varchar("status", { length: 20 }).default("preparing").notNull(),
    notes: text(),
    referenceUrl: varchar("reference_url", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.saleId, table.businessId],
      foreignColumns: [sales.id, sales.businessId],
      name: "sale_shipments_sale_business_fkey",
    }),
    unique("sale_shipments_sale_unique").on(table.saleId, table.businessId),
    index("sale_shipments_business_date_idx").on(
      table.businessId,
      table.shipmentDate,
    ),
  ],
);
