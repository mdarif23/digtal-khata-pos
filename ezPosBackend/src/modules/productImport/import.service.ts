import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { brands as brandsTable } from "../../db/schema/brands.js";
import { categories as categoriesTable } from "../../db/schema/categories.js";
import { locations as locationsTable } from "../../db/schema/locations.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products as productsTable } from "../../db/schema/products.js";
import { variantBarcodeAliases } from "../../db/schema/variantBarcodeAliases.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import { units as unitsTable } from "../../db/schema/units.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/handleError.js";
import { gtinCheckDigitIsValid } from "../barcodes/barcodes.validation.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { assertWithinProductLimit } from "../../services/entitlements.js";
import { generateSku } from "../addProduct/product.service.js";
import { detectBarcodeFormat } from "../barcodes/barcodes.validation.js";
import { recordAuditInTx } from "../../services/audit.js";
import type { Tx } from "../../services/audit.js";

/**
 * Product import pipeline (Phases E/G/H): mapping → normalization →
 * grouping → duplicate detection → validation → batched execution.
 *
 * Reuses the audited creation core (addProduct/product.service.ts) shapes:
 * variant insert + options tuples + opening batches + serials — plus the one
 * thing product creation never did: inventory_movements rows for opening
 * stock (movementType "adjustment", referenceType "product_import:<id>"),
 * so imported stock is visible in movement history. Categories/brands/units
 * are matched case-insensitively and only created when the session options
 * authorize it (never silently).
 */

export const CANONICAL_FIELDS = [
  "product_name",
  "product_type",
  "category",
  "brand",
  "unit",
  "package_unit",
  "package_factor",
  "package_sale_price",
  "package_barcode",
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
  "serial_numbers",
  "weight",
  "weight_unit",
  "image_url",
  "status",
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

const FIELD_ALIASES: Record<string, CanonicalField> = Object.fromEntries(
  [
    ["product name", "product_name"], ["name", "product_name"], ["product", "product_name"],
    ["item name", "product_name"], ["productname", "product_name"],
    ["product type", "product_type"], ["type", "product_type"],
    ["category name", "category"], ["product category", "category"],
    ["brand name", "brand"], ["product brand", "brand"],
    ["unit name", "unit"], ["uom", "unit"], ["measurement", "unit"],
    ["package unit", "package_unit"], ["packaging unit", "package_unit"], ["box unit", "package_unit"], ["carton unit", "package_unit"],
    ["package factor", "package_factor"], ["packaging factor", "package_factor"], ["units per package", "package_factor"], ["pack size", "package_factor"], ["units per box", "package_factor"],
    ["package sale price", "package_sale_price"], ["package price", "package_sale_price"], ["box price", "package_sale_price"], ["carton price", "package_sale_price"],
    ["package barcode", "package_barcode"], ["box barcode", "package_barcode"], ["carton barcode", "package_barcode"], ["packaging barcode", "package_barcode"],
    ["product description", "description"], ["desc", "description"],
    ["product sku", "sku"], ["variant sku", "sku"], ["item sku", "sku"], ["sku code", "sku"],
    ["has variants", "has_variants"], ["variants", "has_variants"],
    ["variant options", "variant_options"], ["attributes", "variant_options"], ["variant attributes", "variant_options"],
    ["variant name", "variant_options"],
    ["barcode", "barcode"], ["bar code", "barcode"], ["ean", "barcode"], ["upc", "barcode"],
    ["sale price", "selling_price"], ["sales price", "selling_price"], ["sell price", "selling_price"],
    ["selling price", "selling_price"], ["price", "selling_price"], ["mrp", "selling_price"], ["retail price", "selling_price"],
    ["purchase price", "purchase_price"], ["purchase cost", "purchase_price"], ["cost price", "purchase_price"], ["cost", "purchase_price"], ["buy price", "purchase_price"],
    ["alert quantity", "alert_quantity"], ["reorder alert", "alert_quantity"], ["min stock", "alert_quantity"],
    ["tracking type", "tracking_type"], ["stock tracking", "tracking_type"],
    ["opening stock", "opening_stock"], ["opening quantity", "opening_stock"], ["initial stock", "opening_stock"], ["stock", "opening_stock"], ["qty", "opening_stock"], ["quantity", "opening_stock"],
    ["location name", "location"], ["warehouse", "location"], ["branch", "location"],
    ["batch number", "batch_number"], ["batch", "batch_number"], ["lot", "batch_number"],
    ["expiry date", "expiry_date"], ["expire date", "expiry_date"], ["expires", "expiry_date"],
    ["serial numbers", "serial_numbers"], ["serials", "serial_numbers"], ["serial number", "serial_numbers"],
    ["image url", "image_url"], ["image", "image_url"], ["photo", "image_url"], ["image link", "image_url"],
    ["weight", "weight"], ["variant weight", "weight"], ["unit weight", "weight"],
    ["weight unit", "weight_unit"], ["uom weight", "weight_unit"],
    ["status", "status"], ["product status", "status"],
  ].map(([alias, field]) => [alias, field as CanonicalField]),
);

export interface NormalizedRow {
  rowNumber: number;
  productName: string;
  productType: "physical" | "service" | "digital";
  category: string | null;
  brand: string | null;
  unit: string | null;
  /** UOM import (Phase 6+): optional product-level packaging config. */
  packageUnit: string | null;
  packageFactor: number | null;
  packageSalePrice: number | null;
  packageBarcode: string | null;
  description: string | null;
  sku: string | null;
  hasVariants: boolean;
  optionValues: { name: string; value: string }[];
  optionsLabel: string | null;
  barcode: string | null;
  sellingPrice: number | null;
  purchasePrice: number | null;
  alertQuantity: number | null;
  trackingType: "none" | "batch" | "serial";
  openingStock: number | null;
  location: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  serialNumbers: string[];
  weight: number | null;
  weightUnit: "kg" | "g" | "lb" | "oz" | null;
  imageUrl: string | null;
  status: "draft" | "active" | "inactive";
  groupKey: string;
}

export interface RowIssue {
  code: string;
  message: string;
  field?: string;
}

const TRUE_VALUES = new Set(["true", "yes", "1", "y", "হ্যাঁ"]);
const FALSE_VALUES = new Set(["false", "no", "0", "n", "না"]);

function normalizeText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.replace(/\u00a0/g, " ").trim().replace(/\s+/g, " ");
  return trimmed === "" ? null : trimmed;
}

function normalizeNumber(
  value: string | null | undefined,
  field: string,
  issues: RowIssue[],
  rowNumber: number,
): number | null {
  const text = normalizeText(value);
  if (text === null) return null;
  // Accept "1,234.56", "1234,56" (decimal comma), Bengali digits.
  const bengaliNormalized = text.replace(/[০-৯]/g, (d) =>
    String("০১২৩৪৫৬৭৮৯".indexOf(d ?? "০")),
  );
  const lastComma = bengaliNormalized.lastIndexOf(",");
  const lastDot = bengaliNormalized.lastIndexOf(".");
  let candidate = bengaliNormalized;
  if (lastComma > -1) {
    if (lastComma > lastDot) {
      // Decimal comma ("1.234,56" / "1234,56") — strip dots, comma → dot.
      candidate = bengaliNormalized.replace(/\./g, "").replace(",", ".");
    } else {
      // Thousands separators ("1,234.56") — strip commas.
      candidate = bengaliNormalized.replace(/,/g, "");
    }
  }
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed)) {
    issues.push({
      code: "invalid_number",
      message: `"${text}" is not a valid number.`,
      field,
    });
    return null;
  }
  return parsed;
}

function normalizeBoolean(
  value: string | null | undefined,
): boolean | null {
  const text = normalizeText(value)?.toLowerCase();
  if (text == null) return null;
  if (TRUE_VALUES.has(text)) return true;
  if (FALSE_VALUES.has(text)) return false;
  return null;
}

function normalizeDate(value: string | null | undefined): string | null {
  const text = normalizeText(value);
  if (text === null) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (iso.test(text)) return text;
  const dmy = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${(m ?? "1").padStart(2, "0")}-${(d ?? "1").padStart(2, "0")}`;
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

/** Canonical option label: "Size: Small | Color: Red". */
function parseOptions(value: string | null | undefined): {
  name: string;
  value: string;
}[] {
  const text = normalizeText(value);
  if (text === null) return [];
  return text
    .split(/[|;]|\u0964/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf(":");
      if (separator === -1) {
        return { name: "Option", value: part };
      }
      return {
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1).trim(),
      };
    })
    .filter((option) => option.value !== "");
}

export function normalizeRow(
  rowNumber: number,
  record: Record<string, string | null>,
  mapping: Record<string, string>,
): { row: NormalizedRow; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const get = (field: CanonicalField): string | null => {
    const header = Object.entries(mapping).find(
      ([, mapped]) => mapped === field,
    )?.[0];
    if (!header) return null;
    return normalizeText(record[header]);
  };

  const productName = get("product_name");
  if (!productName) {
    issues.push({
      code: "missing_required",
      message: "Product name is required.",
      field: "product_name",
    });
  } else if (productName.length > 100) {
    issues.push({
      code: "too_long",
      message: "Product name exceeds 100 characters.",
      field: "product_name",
    });
  }

  const productTypeText = (get("product_type") ?? "physical").toLowerCase();
  const productType = (["physical", "service", "digital"] as const).includes(
    productTypeText as never,
  )
    ? (productTypeText as "physical" | "service" | "digital")
    : "physical";

  const unit = get("unit");
  if (!unit) {
    issues.push({
      code: "missing_required",
      message: "Unit is required (e.g. Piece, Kg).",
      field: "unit",
    });
  }

  const sellingPrice = normalizeNumber(
    get("selling_price"),
    "selling_price",
    issues,
    rowNumber,
  );
  if (sellingPrice === null) {
    issues.push({
      code: "missing_required",
      message: "Selling price is required.",
      field: "selling_price",
    });
  } else if (sellingPrice < 0) {
    issues.push({
      code: "invalid_price",
      message: "Selling price cannot be negative.",
      field: "selling_price",
    });
  }

  const purchasePrice = normalizeNumber(
    get("purchase_price"),
    "purchase_price",
    issues,
    rowNumber,
  );
  if (purchasePrice !== null && purchasePrice < 0) {
    issues.push({
      code: "invalid_price",
      message: "Purchase price cannot be negative.",
      field: "purchase_price",
    });
  }

  const alertQuantity = normalizeNumber(
    get("alert_quantity"),
    "alert_quantity",
    issues,
    rowNumber,
  );
  const openingStock = normalizeNumber(
    get("opening_stock"),
    "opening_stock",
    issues,
    rowNumber,
  );

  const trackingTypeText = (normalizeText(get("tracking_type")) ?? "none").toLowerCase();
  const trackingType = (
    ["none", "batch", "serial"] as const
  ).includes(trackingTypeText as never)
    ? (trackingTypeText as "none" | "batch" | "serial")
    : "none";

  const optionValues = parseOptions(get("variant_options"));
  const hasVariantsFlag = normalizeBoolean(get("has_variants"));
  const sku = normalizeText(get("sku"));

  const barcode = normalizeText(get("barcode"));
  if (barcode) {
    if (barcode.length > 100 || /[\x00-\x1f\x7f]/.test(barcode)) {
      issues.push({
        code: "invalid_barcode",
        message: `Barcode "${barcode}" is not a valid barcode value.`,
        field: "barcode",
      });
    } else if (
      /^\d{8}$|^\d{12}$|^\d{13}$/.test(barcode) &&
      !gtinCheckDigitIsValid(barcode)
    ) {
      // P7: same GTIN check-digit rule manual creation enforces.
      issues.push({
        code: "invalid_barcode",
        message: `Barcode "${barcode}" looks like an EAN-8/UPC-A/EAN-13 code but fails GS1 validation.`,
        field: "barcode",
      });
    }
  }

  const serialText = normalizeText(get("serial_numbers"));
  const serialNumbers = serialText
    ? serialText
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const opening = openingStock === null ? null : Math.trunc(openingStock);
  if (opening !== null && opening < 0) {
    issues.push({
      code: "invalid_quantity",
      message: "Opening stock cannot be negative.",
      field: "opening_stock",
    });
  }
  if (trackingType === "batch" && opening !== null && opening > 0) {
    const batchNumber = normalizeText(get("batch_number"));
    if (!batchNumber) {
      issues.push({
        code: "missing_batch_number",
        message: "Batch-tracked opening stock needs a batch number.",
        field: "batch_number",
      });
    }
  }
  if (trackingType === "serial") {
    if (opening !== null && serialNumbers.length !== opening) {
      issues.push({
        code: "serial_count_mismatch",
        message: `Serial tracking needs ${opening ?? 0} serial number(s); found ${serialNumbers.length}.`,
        field: "serial_numbers",
      });
    }
    if (serialNumbers.some((s) => s.length > 100)) {
      issues.push({
        code: "serial_too_long",
        message: "Serial numbers must be at most 100 characters.",
        field: "serial_numbers",
      });
    }
  }

  // UOM import (Phase 6+): optional product-level packaging. Both the unit
  // and a positive factor are required together; prices/barcodes are extra.
  const packageUnit = normalizeText(get("package_unit"));
  const packageFactor = normalizeNumber(
    get("package_factor"),
    "package_factor",
    issues,
    rowNumber,
  );
  if (packageUnit && (packageFactor === null || packageFactor <= 0)) {
    issues.push({
      code: "invalid_package_factor",
      message: `Packaging unit "${packageUnit}" needs a positive units-per-package factor.`,
      field: "package_factor",
    });
  } else if (!packageUnit && packageFactor !== null) {
    issues.push({
      code: "missing_package_unit",
      message: "A package factor needs a packaging unit (e.g. Box).",
      field: "package_unit",
    });
  } else if (packageUnit && packageFactor !== null && packageFactor > 0) {
    if (unit && packageUnit.toLowerCase() === unit.toLowerCase()) {
      issues.push({
        code: "package_unit_is_base",
        message: "The packaging unit cannot be the product's own base unit.",
        field: "package_unit",
      });
    }
  }
  const packageSalePrice = normalizeNumber(
    get("package_sale_price"),
    "package_sale_price",
    issues,
    rowNumber,
  );
  if (packageSalePrice !== null && packageSalePrice < 0) {
    issues.push({
      code: "invalid_price",
      message: "Package sale price cannot be negative.",
      field: "package_sale_price",
    });
  }
  const packageBarcode = normalizeText(get("package_barcode"));
  if (packageBarcode) {
    if (packageBarcode.length > 100 || /[\x00-\x1f\x7f]/.test(packageBarcode)) {
      issues.push({
        code: "invalid_barcode",
        message: `Package barcode "${packageBarcode}" is not a valid barcode value.`,
        field: "package_barcode",
      });
    } else if (
      /^\d{8}$|^\d{12}$|^\d{13}$/.test(packageBarcode) &&
      !gtinCheckDigitIsValid(packageBarcode)
    ) {
      issues.push({
        code: "invalid_barcode",
        message: `Package barcode "${packageBarcode}" looks like an EAN-8/UPC-A/EAN-13 code but fails GS1 validation.`,
        field: "package_barcode",
      });
    } else if (barcode && packageBarcode.toLowerCase() === barcode.toLowerCase()) {
      issues.push({
        code: "duplicate_in_file",
        message: "The package barcode must differ from the piece barcode.",
        field: "package_barcode",
      });
    }
  }

  const statusText = (normalizeText(get("status")) ?? "active").toLowerCase();
  const status = (["draft", "active", "inactive"] as const).includes(
    statusText as never,
  )
    ? (statusText as "draft" | "active" | "inactive")
    : "active";

  const weight = normalizeNumber(get("weight"), "weight", issues, rowNumber);
  if (weight !== null && weight < 0) {
    issues.push({
      code: "invalid_weight",
      message: "Weight cannot be negative.",
      field: "weight",
    });
  }
  const weightUnitText = (normalizeText(get("weight_unit")) ?? "kg").toLowerCase();
  const weightUnit = (["kg", "g", "lb", "oz"] as const).includes(
    weightUnitText as never,
  )
    ? (weightUnitText as "kg" | "g" | "lb" | "oz")
    : null;

  const imageUrl = normalizeText(get("image_url"));
  if (imageUrl && !/^https:\/\/.+/i.test(imageUrl)) {
    issues.push({
      code: "invalid_image_url",
      message: "Image URL must start with https://",
      field: "image_url",
    });
  }

  const category = normalizeText(get("category"));
  const brand = normalizeText(get("brand"));
  const expiryDate = normalizeDate(get("expiry_date"));

  const hasVariants =
    hasVariantsFlag ?? (optionValues.length > 0 || (sku !== null && false));

  const groupKey = [
    productName?.toLowerCase() ?? "?",
    category?.toLowerCase() ?? "",
    brand?.toLowerCase() ?? "",
  ].join("||");

  return {
    row: {
      rowNumber,
      productName: productName ?? "",
      productType,
      category,
      brand,
      unit,
      packageUnit,
      packageFactor: packageFactor !== null && packageFactor > 0 ? packageFactor : null,
      packageSalePrice:
        packageSalePrice === null ? null : roundMoney(packageSalePrice),
      packageBarcode,
      description: normalizeText(get("description")),
      sku,
      hasVariants,
      optionValues,
      optionsLabel:
        optionValues.length > 0
          ? optionValues.map((o) => `${o.name}: ${o.value}`).join(" | ")
          : null,
      barcode,
      sellingPrice,
      purchasePrice: purchasePrice === null ? null : roundMoney(purchasePrice),
      alertQuantity: alertQuantity === null ? null : Math.trunc(alertQuantity),
      trackingType,
      openingStock: opening,
      location: normalizeText(get("location")),
      batchNumber: normalizeText(get("batch_number")),
      expiryDate,
      serialNumbers,
      weight: weight === null ? null : weight,
      weightUnit,
      imageUrl: imageUrl && /^https:\/\//i.test(imageUrl) ? imageUrl : null,
      status,
      groupKey,
    },
    issues,
  };
}

/** Auto-map file headers to canonical fields (exact → alias → fuzzy). */
export function autoMapHeaders(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const used = new Set<CanonicalField>();
  for (const header of headers) {
    const key = header.trim().toLowerCase();
    const canonical = CANONICAL_FIELDS.find((f) => f === key);
    if (canonical && !used.has(canonical)) {
      mapping[header] = canonical;
      used.add(canonical);
      continue;
    }
    const alias = FIELD_ALIASES[key];
    if (alias && !used.has(alias)) {
      mapping[header] = alias;
      used.add(alias);
    }
  }
  return mapping;
}

// ----------------------------------------------------
// Grouping (one product, one row per variant)
// ----------------------------------------------------

export interface ProductGroup {
  groupKey: string;
  rows: NormalizedRow[];
  product: NormalizedRow;
  hasVariants: boolean;
}

export function groupRows(rows: NormalizedRow[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const row of rows) {
    let group = groups.get(row.groupKey);
    if (!group) {
      group = {
        groupKey: row.groupKey,
        rows: [],
        product: row,
        hasVariants: false,
      };
      groups.set(row.groupKey, group);
    }
    group.rows.push(row);
    if (row.optionValues.length > 0) group.hasVariants = true;
  }
  for (const group of groups.values()) {
    group.hasVariants = group.hasVariants || group.rows.length > 1;
    if (group.hasVariants && group.rows.length === 1) {
      // Single row marked has_variants=true with options → still a variant product.
      group.hasVariants = (group.rows[0]?.optionValues.length ?? 0) > 0;
    }
  }
  return [...groups.values()];
}

// ----------------------------------------------------
// DB context + duplicate detection + validation
// ----------------------------------------------------

export interface ImportDbContext {
  variantSkus: Map<string, { variantId: number; productId: number; productName: string }>;
  barcodes: Map<string, { variantId: number; productId: number; productName: string }>;
  productNames: Map<string, { productId: number; hasVariants: boolean }>;
  categories: Map<string, number>;
  brands: Map<string, number>;
  units: Map<string, number>;
  locations: Map<string, number>;
  serials: Set<string>;
}

export async function loadImportDbContext(
  businessId: number,
): Promise<ImportDbContext> {
  const [variantRows, categoryRows, brandRows, unitRows, locationRows, serialRows] =
    await Promise.all([
      db
        .select({
          sku: productVariants.sku,
          variantId: productVariants.id,
          productId: productVariants.productId,
          barcode: productVariants.barcode,
          productName: productsTable.name,
        })
        .from(productVariants)
        .innerJoin(
          productsTable,
          and(
            eq(productsTable.id, productVariants.productId),
            eq(productsTable.businessId, productVariants.businessId),
          ),
        )
        .where(eq(productVariants.businessId, businessId)),
      db
        .select({ id: categoriesTable.id, name: categoriesTable.name })
        .from(categoriesTable)
        .where(eq(categoriesTable.businessId, businessId)),
      db
        .select({ id: brandsTable.id, name: brandsTable.name })
        .from(brandsTable)
        .where(eq(brandsTable.businessId, businessId)),
      db
        .select({ id: unitsTable.id, name: unitsTable.name })
        .from(unitsTable)
        .where(eq(unitsTable.businessId, businessId)),
      db
        .select({ id: locationsTable.id, name: locationsTable.name })
        .from(locationsTable)
        .where(eq(locationsTable.businessId, businessId)),
      db
        .select({ serial: serialNumbers.serialNumber })
        .from(serialNumbers)
        .where(eq(serialNumbers.businessId, businessId)),
    ]);

  const context: ImportDbContext = {
    variantSkus: new Map(),
    barcodes: new Map(),
    productNames: new Map(),
    categories: new Map(),
    brands: new Map(),
    units: new Map(),
    locations: new Map(),
    serials: new Set(serialRows.map((r) => r.serial)),
  };
  // UOM import: package barcodes live on variant_barcode_aliases — they
  // must collide with NOTHING (primary or alias) for a lookup to stay
  // deterministic.
  const aliasRows = await db
    .select({
      barcode: variantBarcodeAliases.barcode,
      variantId: productVariants.id,
      productName: productsTable.name,
    })
    .from(variantBarcodeAliases)
    .innerJoin(
      productVariants,
      and(
        eq(productVariants.id, variantBarcodeAliases.variantId),
        eq(productVariants.businessId, variantBarcodeAliases.businessId),
      ),
    )
    .innerJoin(productsTable, eq(productsTable.id, productVariants.productId))
    .where(eq(variantBarcodeAliases.businessId, businessId));
  const nameCounts = new Map<string, number>();
  for (const row of variantRows) {
    context.variantSkus.set(row.sku.toLowerCase(), {
      variantId: row.variantId,
      productId: row.productId,
      productName: row.productName,
    });
    if (row.barcode) {
      context.barcodes.set(row.barcode.toLowerCase(), {
        variantId: row.variantId,
        productId: row.productId,
        productName: row.productName,
      });
    }
    nameCounts.set(
      row.productName.toLowerCase(),
      (nameCounts.get(row.productName.toLowerCase()) ?? 0) + 1,
    );
  }
  for (const row of aliasRows) {
    if (!context.barcodes.has(row.barcode.toLowerCase())) {
      context.barcodes.set(row.barcode.toLowerCase(), {
        variantId: row.variantId,
        productId: 0,
        productName: row.productName,
      });
    }
  }
  for (const [name, count] of nameCounts) {
    context.productNames.set(name, { productId: 0, hasVariants: count > 1 });
  }
  for (const row of categoryRows)
    context.categories.set(row.name.toLowerCase(), row.id);
  for (const row of brandRows) context.brands.set(row.name.toLowerCase(), row.id);
  for (const row of unitRows) context.units.set(row.name.toLowerCase(), row.id);
  for (const row of locationRows)
    context.locations.set(row.name.toLowerCase(), row.id);
  return context;
}

/** Validates normalized rows in-place: mutates issues + duplicate info. */
export function validateGroups(
  groups: ProductGroup[],
  context: ImportDbContext,
  options: { mode: "create" | "update" | "upsert" | "skip" },
): void {
  const inFileSkus = new Map<string, number[]>();
  const inFileBarcodes = new Map<string, number[]>();
  const inFilePackageBarcodes = new Map<string, number[]>();
  const inFileOptionSets = new Map<string, number[]>();
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.sku) {
        inFileSkus.set(row.sku.toLowerCase(), [
          ...(inFileSkus.get(row.sku.toLowerCase()) ?? []),
          row.rowNumber,
        ]);
      }
      if (row.barcode) {
        inFileBarcodes.set(row.barcode.toLowerCase(), [
          ...(inFileBarcodes.get(row.barcode.toLowerCase()) ?? []),
          row.rowNumber,
        ]);
      }
      if (row.packageBarcode) {
        inFilePackageBarcodes.set(row.packageBarcode.toLowerCase(), [
          ...(inFilePackageBarcodes.get(row.packageBarcode.toLowerCase()) ?? []),
          row.rowNumber,
        ]);
      }
      if (group.hasVariants) {
        const key = `${row.groupKey}::${row.optionsLabel?.toLowerCase() ?? ""}`;
        inFileOptionSets.set(key, [
          ...(inFileOptionSets.get(key) ?? []),
          row.rowNumber,
        ]);
      }
      if (row.trackingType === "serial") {
        for (const serial of row.serialNumbers) {
          if (context.serials.has(serial)) {
            row.serialNumbers = row.serialNumbers.filter((s) => s !== serial);
            row.serialNumbers.unshift(`__DUPLICATE_SERIAL__${serial}`);
          }
        }
      }
    }
  }

  for (const group of groups) {
    for (const row of group.rows) {
      const issues: RowIssue[] = [];
      // In-file duplicates.
      if (row.sku && (inFileSkus.get(row.sku.toLowerCase())?.length ?? 0) > 1) {
        issues.push({
          code: "duplicate_in_file",
          message: `SKU "${row.sku}" appears on multiple rows in this file.`,
          field: "sku",
        });
      }
      if (
        row.barcode &&
        (inFileBarcodes.get(row.barcode.toLowerCase())?.length ?? 0) > 1
      ) {
        issues.push({
          code: "duplicate_in_file",
          message: `Barcode "${row.barcode}" appears on multiple rows in this file.`,
          field: "barcode",
        });
      }
      if (
        row.packageBarcode &&
        (inFilePackageBarcodes.get(row.packageBarcode.toLowerCase())?.length ?? 0) > 1
      ) {
        issues.push({
          code: "duplicate_in_file",
          message: `Package barcode "${row.packageBarcode}" appears on multiple rows in this file.`,
          field: "package_barcode",
        });
      }
      if (row.packageBarcode) {
        const collision = context.barcodes.get(row.packageBarcode.toLowerCase());
        if (collision) {
          issues.push({
            code: "package_barcode_exists",
            message: `Package barcode "${row.packageBarcode}" is already registered in this business (product: ${collision.productName}).`,
            field: "package_barcode",
          });
        }
      }
      // Packaging is product-level: every row of a group must agree.
      if (row !== group.product && (row.packageUnit || group.product.packageUnit)) {
        const same =
          (row.packageUnit ?? "").toLowerCase() ===
            (group.product.packageUnit ?? "").toLowerCase() &&
          (row.packageFactor ?? 0) === (group.product.packageFactor ?? 0);
        if (!same) {
          issues.push({
            code: "package_conflict",
            message: "Packaging differs between rows of the same product — one configuration per product.",
            field: "package_unit",
          });
        }
      }
      if (group.hasVariants && row.optionsLabel) {
        const key = `${row.groupKey}::${row.optionsLabel.toLowerCase()}`;
        if ((inFileOptionSets.get(key)?.length ?? 0) > 1) {
          issues.push({
            code: "duplicate_variant_combination",
            message: "This variant option combination appears twice for the product.",
            field: "variant_options",
          });
        }
      }
      if (row.serialNumbers.some((s) => s.startsWith("__DUPLICATE_SERIAL__"))) {
        issues.push({
          code: "duplicate_serial",
          message: "One or more serial numbers already exist in this business.",
          field: "serial_numbers",
        });
      }

      // Existing-record matching (SKU first, barcode secondary).
      const skuMatch = row.sku
        ? context.variantSkus.get(row.sku.toLowerCase())
        : undefined;
      const barcodeMatch = row.barcode
        ? context.barcodes.get(row.barcode.toLowerCase())
        : undefined;
      const existing = skuMatch ?? barcodeMatch;

      if (existing) {
        if (options.mode === "create") {
          issues.push({
            code: "sku_exists",
            message: `SKU "${row.sku ?? row.barcode}" already exists (product: ${existing.productName}).`,
            field: "sku",
          });
        } else if (skuMatch && barcodeMatch && skuMatch.variantId !== barcodeMatch.variantId) {
          issues.push({
            code: "ambiguous_match",
            message: "SKU and barcode point to different existing products.",
            field: "sku",
          });
        } else {
          (row as NormalizedRow & { match?: { variantId: number; productId: number } }).match = {
            variantId: existing.variantId,
            productId: existing.productId,
          };
        }
      } else if (options.mode === "update") {
        issues.push({
          code: "no_match_in_update_mode",
          message:
            "Update mode: no existing product matched this row (by SKU/barcode).",
          field: "sku",
        });
      }

      // Name-similarity warning (never a duplicate decision).
      if (!existing) {
        const nameKey = row.productName.toLowerCase();
        if (
          context.productNames.has(nameKey) ||
          [...context.productNames.keys()].some(
            (name) =>
              name !== nameKey &&
              (name.includes(nameKey) || nameKey.includes(name)) &&
              Math.min(name.length, nameKey.length) > 4,
          )
        ) {
          issues.push({
            code: "similar_name_warning",
            message:
              "A similarly named product already exists — this row will CREATE a new product.",
            field: "product_name",
          });
        }
      }

      row.serialNumbers = row.serialNumbers.filter(
        (s) => !s.startsWith("__DUPLICATE_SERIAL__"),
      );
      row.serialNumbers = [...new Set(row.serialNumbers)];

      const payload = row as NormalizedRow & {
        issues?: RowIssue[];
        match?: { variantId: number; productId: number };
      };
      // MERGE with normalizeRow issues (invalid numbers, GTIN check digits,
      // serial mismatches...) — the old code overwrote them, silently
      // hiding real row errors.
      payload.issues = [...(payload.issues ?? []), ...issues];
    }
  }
}

export function hasBlockingErrors(row: NormalizedRow): RowIssue[] {
  const payload = row as NormalizedRow & { issues?: RowIssue[] };
  return (payload.issues ?? []).filter(
    (issue) =>
      issue.code !== "similar_name_warning" && issue.code !== "duplicate_serial",
  );
}
