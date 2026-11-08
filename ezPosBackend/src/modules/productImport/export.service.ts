import ExcelJS from "exceljs";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { brands as brandsTable } from "../../db/schema/brands.js";
import { categories as categoriesTable } from "../../db/schema/categories.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { locations as locationsTable } from "../../db/schema/locations.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products as productsTable } from "../../db/schema/products.js";
import { units as unitsTable } from "../../db/schema/units.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { variantOptionsLabelSubquery } from "./variantsLabel.js";

/**
 * Product export (Phase J): server-side CSV/XLSX with the SAME canonical
 * columns as the import template — export → edit → re-import is lossless
 * and duplicate-safe (SKUs match, so update/upsert mode finds everything).
 * Purchase cost is included ONLY with products.view_cost (internal field).
 * Stock quantities are emitted per location column. Formula-injection guard
 * on every cell (same rule as the frontend csvCell).
 */

const EXPORT_COLUMNS = [
  "product_name",
  "product_type",
  "category",
  "brand",
  "unit",
  "package_units",
  "description",
  "sku",
  "has_variants",
  "variant_options",
  "barcode",
  "selling_price",
  "purchase_price",
  "alert_quantity",
  "tracking_type",
  "opening_stock",
  "location",
  "batch_number",
  "expiry_date",
  "image_url",
  "status",
] as const;

function guardCell(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/^[\t\r ]*[=+\-@]/, "'$&");
}

export interface ExportFilters {
  categoryId?: number | null;
  brandId?: number | null;
  status?: string | null;
  productIds?: number[] | null;
  locationId?: number | null;
  includeCost: boolean;
  format: "csv" | "xlsx";
}

export async function buildProductExport(
  businessId: number,
  filters: ExportFilters,
): Promise<{ filename: string; contentType: string; bytes: Buffer }> {
  const variantRows = await db
    .select({
      productId: productsTable.id,
      productName: productsTable.name,
      productType: productsTable.productType,
      productStatus: productsTable.status,
      description: productsTable.description,
      trackingType: productsTable.trackingType,
      hasVariants: productsTable.hasVariants,
      categoryName: categoriesTable.name,
      brandName: brandsTable.name,
      unitName: unitsTable.name,
      packaging: sql`(
        SELECT string_agg(puc.unit_name || ':' || puc.conversion_factor, '; ' ORDER BY puc.conversion_factor)
        FROM (
          SELECT u2.name AS unit_name, puc2.conversion_factor
          FROM product_unit_conversions puc2
          JOIN units u2 ON u2.id = puc2.unit_id
          WHERE puc2.product_id = ${productsTable.id}
            AND puc2.business_id = ${productsTable.businessId}
            AND puc2.status = 'active'
        ) puc
      )`,
      imageUrl: sql`(
        SELECT pi.image_url FROM product_images pi
        WHERE pi.product_id = ${productsTable.id}
        ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1
      )`,
      variantId: productVariants.id,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      sellingPrice: productVariants.sellingPrice,
      alertQuantity: productVariants.alertQuantity,
      variantStatus: productVariants.status,
      isDefault: productVariants.isDefault,
      variantOptions: variantOptionsLabelSubquery("product_variants"),
    })
    .from(productVariants)
    .innerJoin(
      productsTable,
      and(
        eq(productsTable.id, productVariants.productId),
        eq(productsTable.businessId, productVariants.businessId),
      ),
    )
    .leftJoin(
      categoriesTable,
      and(eq(categoriesTable.id, productsTable.categoryId), eq(categoriesTable.businessId, businessId)),
    )
    .leftJoin(
      brandsTable,
      and(eq(brandsTable.id, productsTable.brandId), eq(brandsTable.businessId, businessId)),
    )
    .leftJoin(unitsTable, eq(unitsTable.id, productsTable.unitId))
    .where(
      and(
        eq(productsTable.businessId, businessId),
        filters.status ? eq(productsTable.status, filters.status) : undefined,
        filters.categoryId ? eq(productsTable.categoryId, filters.categoryId) : undefined,
        filters.brandId ? eq(productsTable.brandId, filters.brandId) : undefined,
        filters.productIds?.length
          ? inArray(productsTable.id, filters.productIds)
          : undefined,
      ),
    )
    .orderBy(asc(productsTable.name), asc(productVariants.id));

  const productIds = [...new Set(variantRows.map((r) => r.productId))];
  const stockRows =
    productIds.length > 0
      ? await db
          .select({
            variantId: inventoryStock.variantId,
            locationName: locationsTable.name,
            quantity: inventoryStock.quantity,
            batchNumber: inventoryBatches.batchNumber,
            expiryDate: inventoryBatches.expiryDate,
            batchPrice: inventoryBatches.purchasePrice,
            batchRemaining: inventoryBatches.quantityRemaining,
            batchId: inventoryBatches.id,
          })
          .from(inventoryStock)
          .innerJoin(
            locationsTable,
            and(
              eq(locationsTable.id, inventoryStock.locationId),
              eq(locationsTable.businessId, inventoryStock.businessId),
            ),
          )
          .leftJoin(
            inventoryBatches,
            and(
              eq(inventoryBatches.variantId, inventoryStock.variantId),
              eq(inventoryBatches.locationId, inventoryStock.locationId),
              eq(inventoryBatches.businessId, inventoryStock.businessId),
              eq(inventoryBatches.quantityRemaining, inventoryStock.quantity),
            ),
          )
          .where(
            and(
              eq(inventoryStock.businessId, businessId),
              filters.locationId
                ? eq(inventoryStock.locationId, filters.locationId)
                : undefined,
              inArray(inventoryStock.variantId, variantRows.map((r) => r.variantId)),
            ),
          )
      : [];
  const stockByVariant = new Map<number, { locationName: string; quantity: number; batchNumber: string | null; expiryDate: Date | null; batchPrice: string | null }>();
  for (const row of stockRows) {
    if (!stockByVariant.has(row.variantId)) {
      stockByVariant.set(row.variantId, {
        locationName: row.locationName,
        quantity: Number(row.quantity ?? 0),
        batchNumber: row.batchNumber ?? null,
        expiryDate: row.expiryDate ?? null,
        batchPrice: row.batchPrice === null || row.batchPrice === undefined ? null : String(row.batchPrice),
      });
    }
  }

  const rows = variantRows.map((row) => {
    const stock = stockByVariant.get(row.variantId);
    const purchasePrice = filters.includeCost ? (stock?.batchPrice ?? null) : null;
    const record: Record<string, string | number | null> = {
      product_name: row.productName,
      product_type: row.productType,
      category: row.categoryName ?? null,
      brand: row.brandName ?? null,
      unit: row.unitName ?? null,
      package_units: (row.packaging as string | null) ?? null,
      description: row.description ?? null,
      sku: row.sku,
      has_variants: row.hasVariants ? "true" : "false",
      variant_options: (row.variantOptions as string | null) ?? null,
      barcode: row.barcode ?? null,
      selling_price: roundMoney(Number(row.sellingPrice)),
      purchase_price: purchasePrice === null ? null : roundMoney(Number(purchasePrice)),
      alert_quantity: row.alertQuantity ?? 0,
      tracking_type: row.trackingType,
      opening_stock: stock ? stock.quantity : 0,
      location: stock?.locationName ?? null,
      batch_number: stock?.batchNumber ?? null,
      expiry_date: stock?.expiryDate
        ? new Date(stock.expiryDate).toISOString().slice(0, 10)
        : null,
      image_url: (row.imageUrl as string | null) ?? null,
      status: row.productStatus,
    };
    return record;
  });

  const headers = [...EXPORT_COLUMNS];
  const cellValue = (record: Record<string, string | number | null>, header: (typeof EXPORT_COLUMNS)[number]) =>
    record[header] === null ? "" : String(record[header]);

  if (filters.format === "csv") {
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const lines = [
      headers.map(escape).join(","),
      ...rows.map((record) => headers.map((h) => escape(guardCell(cellValue(record, h)))).join(",")),
    ];
    return {
      filename: "ezpos-products-export.csv",
      contentType: "text/csv; charset=utf-8",
      bytes: Buffer.from("\uFEFF" + lines.join("\r\n"), "utf8"),
    };
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ezPos";
  const sheet = workbook.addWorksheet("Products");
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };
  for (const record of rows) {
    sheet.addRow(headers.map((h) => guardCell(cellValue(record, h))));
  }
  sheet.columns.forEach((column) => {
    column.width = 18;
  });
  const bytes = Buffer.from(
    (await workbook.xlsx.writeBuffer()) as ArrayBuffer,
  );
  return {
    filename: `ezpos-products-export-${new Date().toISOString().slice(0, 10)}.xlsx`,
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes,
  };
}
