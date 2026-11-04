import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses.js";
import { inventoryBatches } from "./inventoryBatches.js";
import { locations } from "./locations.js";
import { productVariants } from "./productVariants.js";
import { purchaseItems } from "./purchaseItems.js";
import { purchases } from "./purchases.js";
import { suppliers } from "./suppliers.js";
import { users } from "./users.js";

/**
 * Landed Cost Management (one combined additional-cost document per
 * purchase).
 *
 * Money invariants:
 * - `purchases.shipping_cost` and `purchase_items.unit_cost` are NEVER
 *   modified by this module — the original purchase cost is preserved and
 *   landed cost rides on `inventory_batches.additional_cost_per_unit`.
 * - Allocation rows are insert-only (immutable). Changes go through
 *   `landed_cost_adjustments` delta records, never updates.
 * - Per-unit allocations carry 6 decimals internally
 *   (numeric(14,6)); currency rounding happens at posting boundaries.
 * - The `unique (business_id, purchase_id)` constraint makes duplicate
 *   posting of a second document for one purchase impossible.
 */

export const landedCostAllocationMethodEnum = pgEnum(
  "landed_cost_allocation_method",
  ["quantity", "value", "weight", "manual"],
);

export const landedCostStatusEnum = pgEnum("landed_cost_status", [
  "draft",
  "posted",
  "adjusted",
  "reversed",
]);

export const landedCostExpenseTypeEnum = pgEnum("landed_cost_expense_type", [
  "shipping",
  "loading",
  "customs",
  "transportation",
  "insurance",
  "handling",
  "other",
]);

export const landedCostTaxTreatmentEnum = pgEnum("landed_cost_tax_treatment", [
  "none",
  "recoverable",
  "non_recoverable",
]);

export const landedCostAdjustmentTypeEnum = pgEnum(
  "landed_cost_adjustment_type",
  ["receive_delta", "manual", "reversal"],
);

export const landedCostPostingTypeEnum = pgEnum("landed_cost_posting_type", [
  "capitalization",
  "expense",
  "cogs_adjustment",
  "reversal",
]);

export const landedCostPaymentSourceEnum = pgEnum(
  "landed_cost_payment_source",
  ["expense_payment", "supplier_payable", "cash", "unpaid"],
);

export const landedCostSettlementTypeEnum = pgEnum(
  "landed_cost_settlement_type",
  ["expense_payment", "supplier_payable", "cash", "unpaid"],
);

export const landedCosts = pgTable(
  "landed_costs",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    purchaseId: integer("purchase_id").notNull(),
    // The purchase's (locked) receiving location — known once the first
    // receive has stamped it, which is a precondition for creating the
    // document.
    locationId: integer("location_id").notNull(),
    allocationMethod: landedCostAllocationMethodEnum("allocation_method")
      .notNull(),
    status: landedCostStatusEnum("status").notNull().default("draft"),
    currency: varchar("currency", { length: 3 }).notNull().default("BDT"),

    totalExpenseAmount: numeric("total_expense_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    totalCapitalizableAmount: numeric("total_capitalizable_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    totalAllocatedAmount: numeric("total_allocated_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    pendingAllocationAmount: numeric("pending_allocation_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),

    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    postedBy: integer("posted_by").references(() => users.id),
    postedAt: timestamp("posted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // One combined document per purchase — duplicate posting is impossible.
    unique("landed_costs_purchase_business_unique").on(
      table.businessId,
      table.purchaseId,
    ),
    unique("landed_costs_id_business_uq").on(table.id, table.businessId),
    index("landed_costs_business_status_idx").on(table.businessId, table.status),
    foreignKey({
      columns: [table.purchaseId, table.businessId],
      foreignColumns: [purchases.id, purchases.businessId],
      name: "landed_costs_purchase_business_fkey",
    }),
    foreignKey({
      columns: [table.locationId, table.businessId],
      foreignColumns: [locations.id, locations.businessId],
      name: "landed_costs_location_business_fkey",
    }),
  ],
);

export const landedCostExpenses = pgTable(
  "landed_cost_expenses",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    landedCostId: integer("landed_cost_id").notNull(),

    expenseType: landedCostExpenseTypeEnum("expense_type").notNull(),
    description: varchar("description", { length: 255 }),
    amount: numeric("amount", { precision: 14, scale: 2, mode: "number" })
      .notNull(),
    taxAmount: numeric("tax_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    taxTreatment: landedCostTaxTreatmentEnum("tax_treatment")
      .notNull()
      .default("none"),
    isCapitalizable: boolean("is_capitalizable").notNull().default(true),

    vendorId: integer("vendor_id"),
    referenceNumber: varchar("reference_number", { length: 100 }),
    expenseDate: date("expense_date", { mode: "date" }),

    // Settlement linkage (Part G / audit Q1-a): how this expense is paid.
    // expense_payment → settlement_reference_id = expenses.id (server-
    // verified); supplier_payable → rides the purchase payable (supplierId
    // required); cash → paid at the counter; unpaid → accrued on posting.
    settlementType: landedCostSettlementTypeEnum("settlement_type")
      .notNull()
      .default("unpaid"),
    settlementReferenceId: integer("settlement_reference_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("landed_cost_expenses_document_idx").on(table.landedCostId),
    unique("landed_cost_expenses_id_business_uq").on(table.id, table.businessId),
    check(
      "landed_cost_expenses_amount_check",
      sql`${table.amount} > 0`,
    ),
    foreignKey({
      columns: [table.landedCostId, table.businessId],
      foreignColumns: [landedCosts.id, landedCosts.businessId],
      name: "landed_cost_expenses_document_business_fkey",
    }),
    foreignKey({
      columns: [table.vendorId, table.businessId],
      foreignColumns: [suppliers.id, suppliers.businessId],
      name: "landed_cost_expenses_vendor_business_fkey",
    }),
  ],
);

export const landedCostAllocations = pgTable(
  "landed_cost_allocations",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    landedCostId: integer("landed_cost_id").notNull(),
    // NULL for a document-level (expense-agnostic) allocation row.
    expenseId: integer("expense_id"),

    purchaseItemId: integer("purchase_item_id").notNull(),
    inventoryBatchId: integer("inventory_batch_id").notNull(),
    variantId: integer("variant_id").notNull(),

    allocationMethod: landedCostAllocationMethodEnum("allocation_method")
      .notNull(),
    basisValue: numeric("basis_value", {
      precision: 14,
      scale: 4,
      mode: "number",
    }).notNull(),
    allocatedAmount: numeric("allocated_amount", {
      precision: 14,
      scale: 4,
      mode: "number",
    }).notNull(),
    allocatedPerUnit: numeric("allocated_per_unit", {
      precision: 14,
      scale: 6,
      mode: "number",
    }).notNull(),

    quantitySnapshot: numeric("quantity_snapshot", {
      precision: 12,
      scale: 3,
      mode: "number",
    }).notNull(),
    weightSnapshot: numeric("weight_snapshot", {
      precision: 14,
      scale: 4,
      mode: "number",
    }),

    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("landed_cost_allocations_document_idx").on(table.landedCostId),
    index("landed_cost_allocations_batch_idx").on(table.inventoryBatchId),
    unique("landed_cost_allocations_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    foreignKey({
      columns: [table.landedCostId, table.businessId],
      foreignColumns: [landedCosts.id, landedCosts.businessId],
      name: "landed_cost_allocations_document_business_fkey",
    }),
    foreignKey({
      columns: [table.expenseId, table.businessId],
      foreignColumns: [landedCostExpenses.id, landedCostExpenses.businessId],
      name: "landed_cost_allocations_expense_business_fkey",
    }),
    foreignKey({
      columns: [table.purchaseItemId, table.businessId],
      foreignColumns: [purchaseItems.id, purchaseItems.businessId],
      name: "landed_cost_allocations_purchase_item_business_fkey",
    }),
    foreignKey({
      columns: [table.inventoryBatchId, table.businessId],
      foreignColumns: [inventoryBatches.id, inventoryBatches.businessId],
      name: "landed_cost_allocations_batch_business_fkey",
    }),
    foreignKey({
      columns: [table.variantId, table.businessId],
      foreignColumns: [productVariants.id, productVariants.businessId],
      name: "landed_cost_allocations_variant_business_fkey",
    }),
  ],
);

export const landedCostAdjustments = pgTable(
  "landed_cost_adjustments",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    landedCostId: integer("landed_cost_id").notNull(),

    adjustmentType: landedCostAdjustmentTypeEnum("adjustment_type").notNull(),
    previousAllocatedAmount: numeric("previous_allocated_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    }).notNull(),
    newAllocatedAmount: numeric("new_allocated_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    }).notNull(),
    adjustmentAmount: numeric("adjustment_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    }).notNull(),
    // Split of adjustmentAmount between remaining inventory and COGS of
    // already-sold units (Part F) — always sums to adjustmentAmount.
    inventoryAmount: numeric("inventory_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    cogsAmount: numeric("cogs_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),

    reason: varchar("reason", { length: 300 }),
    referenceType: varchar("reference_type", { length: 50 }),
    referenceId: integer("reference_id"),

    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("landed_cost_adjustments_document_idx").on(table.landedCostId),
    unique("landed_cost_adjustments_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    check(
      "landed_cost_adjustments_split_check",
      sql`(${table.inventoryAmount} + ${table.cogsAmount}) = ${table.adjustmentAmount}`,
    ),
    foreignKey({
      columns: [table.landedCostId, table.businessId],
      foreignColumns: [landedCosts.id, landedCosts.businessId],
      name: "landed_cost_adjustments_document_business_fkey",
    }),
  ],
);

export const landedCostAuditLogs = pgTable(
  "landed_cost_audit_logs",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    landedCostId: integer("landed_cost_id").notNull(),

    // create | expense_add | expense_update | expense_remove |
    // method_change | calculate | post | receive_adjustment |
    // manual_adjustment | reverse
    action: varchar("action", { length: 50 }).notNull(),
    details: jsonb("details").default(sql`'{}'::jsonb`),
    actorUserId: integer("actor_user_id").references(() => users.id),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("landed_cost_audit_logs_document_idx").on(
      table.landedCostId,
      table.createdAt,
    ),
    unique("landed_cost_audit_logs_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    foreignKey({
      columns: [table.landedCostId, table.businessId],
      foreignColumns: [landedCosts.id, landedCosts.businessId],
      name: "landed_cost_audit_logs_document_business_fkey",
    }),
  ],
);

/**
 * Module-scoped accounting trail (audit decision Q1-a): every financial
 * impact of a landed-cost document — inventory capitalization, period
 * expense, COGS adjustment, reversal — is recorded here with a reference to
 * its payment source, so money is never double-recorded and every posting is
 * traceable to both the document and the settled payment row. The existing
 * expense/payment tables remain the authoritative settlement records; this
 * table is the landed-cost view of their capitalization.
 */
export const landedCostPostings = pgTable(
  "landed_cost_postings",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    landedCostId: integer("landed_cost_id").notNull(),
    adjustmentId: integer("adjustment_id"),

    postingType: landedCostPostingTypeEnum("posting_type").notNull(),
    // Signed: positive capitalization / COGS increase, negative reversal.
    amount: numeric("amount", { precision: 14, scale: 2, mode: "number" })
      .notNull(),
    paymentSource: landedCostPaymentSourceEnum("payment_source").notNull(),
    paymentReferenceType: varchar("payment_reference_type", { length: 50 }),
    paymentReferenceId: integer("payment_reference_id"),
    description: varchar("description", { length: 255 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("landed_cost_postings_document_idx").on(table.landedCostId),
    unique("landed_cost_postings_id_business_uq").on(
      table.id,
      table.businessId,
    ),
    foreignKey({
      columns: [table.landedCostId, table.businessId],
      foreignColumns: [landedCosts.id, landedCosts.businessId],
      name: "landed_cost_postings_document_business_fkey",
    }),
    foreignKey({
      columns: [table.adjustmentId, table.businessId],
      foreignColumns: [landedCostAdjustments.id, landedCostAdjustments.businessId],
      name: "landed_cost_postings_adjustment_business_fkey",
    }),
  ],
);
