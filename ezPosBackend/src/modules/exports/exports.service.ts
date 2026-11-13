import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { customers } from "../../db/schema/customers.js";
import { suppliers } from "../../db/schema/suppliers.js";
import { sales } from "../../db/schema/sales.js";
import { saleItems } from "../../db/schema/saleItems.js";
import { purchases } from "../../db/schema/purchases.js";
import { expenses } from "../../db/schema/expenses.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { locations } from "../../db/schema/locations.js";
import { safeCsvCell } from "../../utils/csv.js";
import { BadRequestError } from "../../utils/handleError.js";

/**
 * First-class, permission-controlled CSV exports (Phase 1 — master prompt
 * F11-G). Every export is business-scoped (and location/date filtered where
 * meaningful), user-reachable values run through the formula-injection
 * guard, and row counts are capped so a casual request can never serialize
 * the whole table.
 */

export const EXPORT_ROW_CAP = 50_000;
const MAX_RANGE_DAYS = 366;

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export function requireDateRange(query: Record<string, unknown>): {
  from: string;
  to: string;
} {
  const from = typeof query.from === "string" ? query.from : "";
  const to = typeof query.to === "string" ? query.to : "";
  if (!isoDate.test(from) || !isoDate.test(to) || from > to) {
    throw new BadRequestError("Provide a valid from/to date range (YYYY-MM-DD).");
  }
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestError(
      `Date range exceeds ${MAX_RANGE_DAYS} days — split the export.`,
    );
  }
  return { from, to };
}

export interface CsvFile {
  filename: string;
  contentType: string;
  body: string;
}

function toCsv(filename: string, header: string[], rows: unknown[][]): CsvFile {
  const lines = [
    header.map(safeCsvCell).join(","),
    ...rows.map((row) => row.map(safeCsvCell).join(",")),
  ];
  return {
    filename: `${filename}-${new Date().toISOString().slice(0, 10)}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: `\uFEFF${lines.join("\r\n")}`,
  };
}

export async function exportCustomers(
  businessId: number,
  search: string | undefined,
): Promise<CsvFile> {
  const conditions: SQL[] = [eq(customers.businessId, businessId)];
  if (search) {
    conditions.push(sql`(${customers.name} ILIKE ${`%${search}%`} OR ${customers.phone} ILIKE ${`%${search}%`})`);
  }
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      email: customers.email,
      address: customers.address,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .where(and(...conditions))
    .orderBy(asc(customers.id))
    .limit(EXPORT_ROW_CAP);
  return toCsv(
    "customers",
    ["id", "name", "phone", "email", "address", "created_at"],
    rows.map((r) => [
      r.id,
      r.name,
      r.phone,
      r.email,
      r.address,
      r.createdAt?.toISOString() ?? "",
    ]),
  );
}

export async function exportSuppliers(
  businessId: number,
  search: string | undefined,
): Promise<CsvFile> {
  const conditions: SQL[] = [eq(suppliers.businessId, businessId)];
  if (search) {
    conditions.push(sql`(${suppliers.name} ILIKE ${`%${search}%`} OR ${suppliers.phone} ILIKE ${`%${search}%`})`);
  }
  const rows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      phone: suppliers.phone,
      email: suppliers.email,
      address: suppliers.address,
      status: suppliers.status,
    })
    .from(suppliers)
    .where(and(...conditions))
    .orderBy(asc(suppliers.id))
    .limit(EXPORT_ROW_CAP);
  return toCsv(
    "suppliers",
    ["id", "name", "phone", "email", "address", "status"],
    rows.map((r) => [
      r.id,
      r.name,
      r.phone,
      r.email,
      r.address,
      r.status,
    ]),
  );
}

export async function exportSales(
  businessId: number,
  range: { from: string; to: string },
  locationId: number | undefined,
): Promise<CsvFile> {
  const conditions: SQL[] = [
    eq(sales.businessId, businessId),
    gte(sales.saleDate, sql`${`${range.from} 00:00:00`}::timestamp`),
    lte(sales.saleDate, sql`${`${range.to} 23:59:59.999`}::timestamp`),
  ];
  if (locationId) {
    conditions.push(eq(sales.locationId, locationId));
  }
  const rows = await db
    .select({
      id: sales.id,
      invoiceNumber: sales.invoiceNumber,
      saleDate: sales.saleDate,
      locationName: locations.name,
      status: sales.status,
      finalTotal: sales.finalTotal,
      dueAmount: sales.dueAmount,
      paymentStatus: sales.paymentStatus,
    })
    .from(sales)
    .leftJoin(locations, eq(locations.id, sales.locationId))
    .where(and(...conditions))
    .orderBy(desc(sales.id))
    .limit(EXPORT_ROW_CAP);
  return toCsv(
    "sales",
    [
      "id",
      "invoice_number",
      "sale_date",
      "location",
      "status",
      "final_total",
      "due_amount",
      "payment_status",
    ],
    rows.map((r) => [
      r.id,
      r.invoiceNumber,
      r.saleDate?.toISOString() ?? "",
      r.locationName,
      r.status,
      r.finalTotal === null ? "" : Number(r.finalTotal),
      r.dueAmount === null ? "" : Number(r.dueAmount),
      r.paymentStatus,
    ]),
  );
}

export async function exportSalesLines(
  businessId: number,
  range: { from: string; to: string },
  locationId: number | undefined,
): Promise<CsvFile> {
  const conditions: SQL[] = [
    eq(saleItems.businessId, businessId),
    gte(sales.saleDate, sql`${`${range.from} 00:00:00`}::timestamp`),
    lte(sales.saleDate, sql`${`${range.to} 23:59:59.999`}::timestamp`),
  ];
  if (locationId) {
    conditions.push(eq(sales.locationId, locationId));
  }
  const rows = await db
    .select({
      saleId: sales.id,
      invoiceNumber: sales.invoiceNumber,
      saleDate: sales.saleDate,
      variantId: saleItems.variantId,
      quantity: saleItems.quantity,
      sellingPrice: saleItems.sellingPrice,
      lineTotal: saleItems.lineTotal,
      costAtSale: saleItems.costAtSale,
    })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .where(and(...conditions))
    .orderBy(desc(sales.id))
    .limit(EXPORT_ROW_CAP);
  return toCsv(
    "sales-lines",
    [
      "sale_id",
      "invoice_number",
      "sale_date",
      "variant_id",
      "quantity",
      "selling_price",
      "line_total",
      "cost_at_sale",
    ],
    rows.map((r) => [
      r.saleId,
      r.invoiceNumber,
      r.saleDate?.toISOString() ?? "",
      r.variantId,
      r.quantity === null ? "" : Number(r.quantity),
      r.sellingPrice === null ? "" : Number(r.sellingPrice),
      r.lineTotal === null ? "" : Number(r.lineTotal),
      r.costAtSale === null ? "" : Number(r.costAtSale),
    ]),
  );
}

export async function exportPurchases(
  businessId: number,
  range: { from: string; to: string },
): Promise<CsvFile> {
  const rows = await db
    .select({
      id: purchases.id,
      purchaseDate: purchases.purchaseDate,
      orderNumber: purchases.purchaseOrderNumber,
      supplierName: suppliers.name,
      status: purchases.status,
      totalAmount: purchases.totalAmount,
      paidAmount: purchases.paidAmount,
      dueAmount: purchases.dueAmount,
    })
    .from(purchases)
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(
      and(
        eq(purchases.businessId, businessId),
        gte(purchases.purchaseDate, sql`${`${range.from} 00:00:00`}::timestamp`),
        lte(purchases.purchaseDate, sql`${`${range.to} 23:59:59.999`}::timestamp`),
      ),
    )
    .orderBy(desc(purchases.id))
    .limit(EXPORT_ROW_CAP);
  return toCsv(
    "purchases",
    [
      "id",
      "purchase_date",
      "order_number",
      "supplier",
      "status",
      "total_amount",
      "paid_amount",
      "due_amount",
    ],
    rows.map((r) => [
      r.id,
      r.purchaseDate?.toISOString() ?? "",
      r.orderNumber,
      r.supplierName,
      r.status,
      r.totalAmount === null ? "" : Number(r.totalAmount),
      r.paidAmount === null ? "" : Number(r.paidAmount),
      r.dueAmount === null ? "" : Number(r.dueAmount),
    ]),
  );
}

export async function exportExpenses(
  businessId: number,
  range: { from: string; to: string },
): Promise<CsvFile> {
  const rows = await db
    .select({
      id: expenses.id,
      expenseDate: expenses.expenseDate,
      categoryName: sql<string | null>`(
        SELECT ec.name FROM expense_categories ec WHERE ec.id = ${expenses.categoryId}
      )`,
      note: expenses.note,
      amount: expenses.amount,
      paymentStatus: expenses.paymentStatus,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.businessId, businessId),
        gte(expenses.expenseDate, range.from),
        lte(expenses.expenseDate, range.to),
      ),
    )
    .orderBy(desc(expenses.id))
    .limit(EXPORT_ROW_CAP);
  return toCsv(
    "expenses",
    ["id", "expense_date", "category", "note", "amount", "payment_status"],
    rows.map((r) => [
      r.id,
      r.expenseDate,
      r.categoryName,
      r.note,
      r.amount === null ? "" : Number(r.amount),
      r.paymentStatus,
    ]),
  );
}

/** Inventory snapshot per variant at the caller's (server-verified) location. */
export async function exportInventory(
  businessId: number,
  locationId: number,
  /** Reserved: batch-level cost columns need a batches join (future). */
  includeCost: boolean,
): Promise<CsvFile> {
  void includeCost;
  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      variantId: productVariants.id,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      quantity: inventoryStock.quantity,
      sellingPrice: productVariants.sellingPrice,
      alertQuantity: productVariants.alertQuantity,
    })
    .from(inventoryStock)
    .innerJoin(
      productVariants,
      eq(productVariants.id, inventoryStock.variantId),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(inventoryStock.businessId, businessId),
        eq(inventoryStock.locationId, locationId),
      ),
    )
    .orderBy(asc(productVariants.id))
    .limit(EXPORT_ROW_CAP);
  return toCsv(
    "inventory",
    ["product", "variant_id", "sku", "barcode", "quantity", "selling_price", "alert_quantity"],
    rows.map((r) => [
      r.productName,
      r.variantId,
      r.sku,
      r.barcode,
      r.quantity === null ? "" : Number(r.quantity),
      r.sellingPrice === null ? "" : Number(r.sellingPrice),
      r.alertQuantity === null ? "" : Number(r.alertQuantity),
    ]),
  );
}
