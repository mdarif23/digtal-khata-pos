import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { productImportRows, productImportSessions } from "../../db/schema/productImport.js";
import { brands as brandsTable } from "../../db/schema/brands.js";
import { categories as categoriesTable } from "../../db/schema/categories.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { locations as locationsTable } from "../../db/schema/locations.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { productUnitConversions } from "../../db/schema/productUnitConversions.js";
import { purchaseItems } from "../../db/schema/purchaseItems.js";
import { variantBarcodeAliases } from "../../db/schema/variantBarcodeAliases.js";
import { products as productsTable } from "../../db/schema/products.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import { units as unitsTable } from "../../db/schema/units.js";
import { variantOptions as variantOptionsTable } from "../../db/schema/variantOptions.js";
import { variantTypes as variantTypesTable } from "../../db/schema/variantTypes.js";
import { variantValues as variantValuesTable } from "../../db/schema/variantValues.js";
import { productImages as productImagesTable } from "../../db/schema/productImages.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { assertWithinProductLimit } from "../../services/entitlements.js";
import { recordAudit, recordAuditInTx } from "../../services/audit.js";
import { generateSku } from "../addProduct/product.service.js";
import { detectBarcodeFormat } from "../barcodes/barcodes.validation.js";
import type { Tx } from "../../services/audit.js";
import {
  autoMapHeaders,
  groupRows,
  hasBlockingErrors,
  loadImportDbContext,
  normalizeRow,
  validateGroups,
  type CanonicalField,
  type NormalizedRow,
  type RowIssue,
} from "./import.service.js";
import type { ParsedSheet } from "./fileParser.service.js";
import { parseCsvUpload, parseXlsxUpload } from "./fileParser.service.js";

const MAX_ROWS = Number(process.env.PRODUCT_IMPORT_MAX_ROWS ?? 2000);
const BATCH_GROUPS = 25;

type SessionRow = typeof productImportSessions.$inferSelect;

// ----------------------------------------------------
// Session creation (upload)
// ----------------------------------------------------

export async function createImportSession(input: {
  businessId: number;
  userId: number;
  filename: string;
  mimeType?: string | null;
  bytes: Buffer;
  worksheet?: string | null;
  headerRow?: number | null;
  maxFileMb: number;
}): Promise<{ sessionId: number; duplicateOf: number | null; sheet: ParsedSheet }> {
  const headerRow = Math.max(1, input.headerRow ?? 1);
  const lower = input.filename.toLowerCase();
  const sheet = lower.endsWith(".csv")
    ? parseCsvUpload(input.bytes, headerRow)
    : await parseXlsxUpload(input.bytes, input.worksheet ?? null, headerRow);

  if (sheet.rows.length === 0) {
    throw new BadRequestError("The file contains no data rows.");
  }
  if (sheet.rows.length > MAX_ROWS) {
    throw new BadRequestError(
      `The file has ${sheet.rows.length} data rows; the import limit is ${MAX_ROWS}. Split the file.`,
    );
  }

  const fileHash = createHash("sha256").update(input.bytes).digest("hex");
  const [duplicate] = await db
    .select({ id: productImportSessions.id })
    .from(productImportSessions)
    .where(
      and(
        eq(productImportSessions.businessId, input.businessId),
        eq(productImportSessions.fileHash, fileHash),
      ),
    )
    .orderBy(desc(productImportSessions.id))
    .limit(1);

  const mapping = autoMapHeaders(sheet.headers);
  return db.transaction(async (tx) => {
    const [session] = await tx
      .insert(productImportSessions)
      .values({
        businessId: input.businessId,
        createdBy: input.userId,
        filename: input.filename,
        fileHash,
        fileSize: input.bytes.length,
        worksheet: sheet.worksheet,
        headerRow,
        status: "mapped",
        mapping,
        totals: {
          totalRows: sheet.rows.length,
          duplicateHeaders: sheet.duplicateHeaders,
          duplicateOf: duplicate?.id ?? null,
        },
      })
      .returning();
    if (!session) throw new Error("Failed to create import session.");
    await tx.insert(productImportRows).values(
      sheet.rows.map((record, index) => ({
        businessId: input.businessId,
        sessionId: session.id,
        rowNumber: sheet.rowNumbers[index] ?? 0,
        productRef: null,
        status: "pending" as const,
        payload: { record },
      })),
    );
    await recordAuditInTx(tx, {
      businessId: input.businessId,
      actorUserId: input.userId,
      action: "product_import.upload",
      entityType: "product_import_session",
      entityId: session.id,
      metadata: { filename: input.filename, rows: sheet.rows.length },
    });
    return {
      sessionId: session.id,
      duplicateOf: duplicate?.id ?? null,
      mapping,
      sheet,
    };
  });
}

function inSessionStatuses(statuses: string[]) {
  return sql`status::text IN (${sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  )})`;
}

async function loadSession(
  businessId: number,
  sessionId: number,
): Promise<SessionRow> {
  const [session] = await db
    .select()
    .from(productImportSessions)
    .where(
      and(
        eq(productImportSessions.id, sessionId),
        eq(productImportSessions.businessId, businessId),
      ),
    )
    .limit(1);
  if (!session) throw new NotFoundError("Import session not found.");
  return session;
}

async function loadRows(businessId: number, sessionId: number) {
  return db
    .select()
    .from(productImportRows)
    .where(
      and(
        eq(productImportRows.sessionId, sessionId),
        eq(productImportRows.businessId, businessId),
      ),
    )
    .orderBy(productImportRows.rowNumber);
}

// ----------------------------------------------------
// Mapping + validation
// ----------------------------------------------------

export async function updateImportMapping(input: {
  businessId: number;
  userId: number;
  sessionId: number;
  mapping: Record<string, string>;
  mode?: "create" | "update" | "upsert" | "skip";
  matchBy?: "variant_sku" | "product_sku" | "barcode";
  options?: {
    updateFields?: string[];
    createMissingMasterData?: boolean;
  } | null;
}) {
  const session = await loadSession(input.businessId, input.sessionId);
  if (["running", "completed"].includes(session.status)) {
    throw new ConflictError("This import has already been executed.");
  }
  const mappedFields = new Set(Object.values(input.mapping));
  for (const required of ["product_name", "selling_price", "unit"] as CanonicalField[]) {
    if (!mappedFields.has(required)) {
      throw new BadRequestError(
        `Column mapping is missing the required field "${required}".`,
      );
    }
  }
  await db
    .update(productImportSessions)
    .set({
      mapping: input.mapping,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.matchBy ? { matchBy: input.matchBy } : {}),
      ...(input.options ? { options: input.options } : {}),
      status: "mapped",
      updatedAt: new Date(),
    })
    .where(eq(productImportSessions.id, input.sessionId));
  await recordAudit({
    businessId: input.businessId,
    actorUserId: input.userId,
    action: "product_import.mapping",
    entityType: "product_import_session",
    entityId: input.sessionId,
    metadata: { mapping: input.mapping, mode: input.mode ?? session.mode },
  });
  return validateImportSession({
    businessId: input.businessId,
    userId: input.userId,
    sessionId: input.sessionId,
  });
}

export async function validateImportSession(input: {
  businessId: number;
  userId: number;
  sessionId: number;
}) {
  const session = await loadSession(input.businessId, input.sessionId);
  if (["running", "completed"].includes(session.status)) {
    throw new ConflictError("This import has already been executed.");
  }
  const rows = await loadRows(input.businessId, input.sessionId);
  const mapping = (session.mapping ?? {}) as Record<string, string>;
  const normalized: (NormalizedRow & { raw: Record<string, string | null> })[] = [];
  for (const row of rows) {
    const record = ((row.payload ?? {}) as { record?: Record<string, string | null> })
      .record ?? {};
    const { row: parsed, issues } = normalizeRow(row.rowNumber, record, mapping);
    normalized.push({ ...parsed, raw: record, ...(issues.length ? { issues } : {}) });
  }
  const context = await loadImportDbContext(input.businessId);
  const groups = groupRows(normalized);
  validateGroups(groups, context, { mode: session.mode });

  const flat = normalized.map((row) => {
    const blocking = hasBlockingErrors(row);
    const issues = ((row as NormalizedRow & { issues?: RowIssue[] }).issues ??
      []) as RowIssue[];
    const match = (row as NormalizedRow & { match?: { variantId: number; productId: number } }).match;
    return {
      rowId: row.rowNumber,
      rowNumber: row.rowNumber,
      productRef: row.optionValues.length
        ? `${row.productName} (${row.optionsLabel})`
        : row.productName,
      status: blocking.length > 0 ? "error" : "valid",
      payload: { record: row.raw, normalized: { ...row, raw: undefined, issues: undefined, match: undefined }, issues, match: match ?? null },
      errors: blocking.length > 0 ? blocking : null,
    };
  });

  const totals = {
    totalRows: flat.length,
    validRows: flat.filter((r) => r.status === "valid").length,
    errorRows: flat.filter((r) => r.status === "error").length,
    products: new Set(normalized.map((r) => r.groupKey)).size,
    warnings: flat.filter(
      (r) => ((r.payload as any).issues ?? []).some(
        (i: RowIssue) => i.code === "similar_name_warning" || i.code === "duplicate_serial",
      ),
    ).length,
  };

  await db.transaction(async (tx) => {
    for (const row of flat) {
      await tx
        .update(productImportRows)
        .set({
          rowNumber: row.rowNumber,
          productRef: row.productRef,
          status: row.status as "valid" | "error",
          payload: row.payload,
          errors: row.errors,
        })
        .where(
          and(
            eq(productImportRows.sessionId, input.sessionId),
            eq(productImportRows.rowNumber, row.rowNumber),
            eq(productImportRows.businessId, input.businessId),
          ),
        );
    }
    await tx
      .update(productImportSessions)
      .set({
        status: "validated",
        totals: { ...((session.totals ?? {}) as object), ...totals },
        updatedAt: new Date(),
      })
      .where(eq(productImportSessions.id, input.sessionId));
    await recordAuditInTx(tx, {
      businessId: input.businessId,
      actorUserId: input.userId,
      action: "product_import.validate",
      entityType: "product_import_session",
      entityId: input.sessionId,
      metadata: totals,
    });
  });
  return { totals };
}

// ----------------------------------------------------
// Execution (Phases E/G/H)
// ----------------------------------------------------

interface MasterDataCache {
  categories: Map<string, number>;
  brands: Map<string, number>;
  units: Map<string, number>;
  locations: Map<string, number>;
}

async function resolveMasterDataId(
  tx: Tx,
  businessId: number,
  cache: MasterDataCache,
  kind: "category" | "brand" | "unit",
  name: string | null,
  createMissing: boolean,
  fallbackId?: number | null,
): Promise<number | null> {
  if (name === null) return fallbackId ?? null;
  const map = cache[kind === "category" ? "categories" : kind === "brand" ? "brands" : "units"];
  const existing = map.get(name.toLowerCase());
  if (existing) return existing;
  if (!createMissing) return fallbackId ?? null;
  if (kind === "category") {
    const [row] = await tx
      .insert(categoriesTable)
      .values({ businessId, name: name.slice(0, 100), status: "active" })
      .returning({ id: categoriesTable.id });
    map.set(name.toLowerCase(), row!.id);
    return row!.id;
  }
  if (kind === "brand") {
    const [row] = await tx
      .insert(brandsTable)
      .values({ businessId, name: name.slice(0, 100), status: "active" })
      .returning({ id: brandsTable.id });
    map.set(name.toLowerCase(), row!.id);
    return row!.id;
  }
  const [row] = await tx
    .insert(unitsTable)
    .values({ businessId, name: name.slice(0, 100), abbreviation: name.slice(0, 20) })
    .returning({ id: unitsTable.id });
  map.set(name.toLowerCase(), row!.id);
  return row!.id;
}

async function resolveLocationId(
  tx: Tx,
  businessId: number,
  cache: MasterDataCache,
  name: string | null,
  defaultLocationId: number,
): Promise<number> {
  if (name) {
    const existing = cache.locations.get(name.toLowerCase());
    if (existing) return existing;
  }
  return defaultLocationId;
}

async function findOrCreateOptionIds(
  tx: Tx,
  businessId: number,
  option: { name: string; value: string },
): Promise<{ typeId: number; typeName: string; optionId: number }> {
  let [type] = await tx
    .select()
    .from(variantTypesTable)
    .where(
      and(
        eq(variantTypesTable.businessId, businessId),
        sql`lower(${variantTypesTable.name}) = ${option.name.toLowerCase()}`,
      ),
    )
    .limit(1);
  if (!type) {
    [type] = await tx
      .insert(variantTypesTable)
      .values({ businessId, name: option.name.slice(0, 100) })
      .returning();
  }
  let [optionRow] = await tx
    .select()
    .from(variantOptionsTable)
    .where(
      and(
        eq(variantOptionsTable.variantTypeId, type!.id),
        sql`lower(${variantOptionsTable.value}) = ${option.value.toLowerCase()}`,
      ),
    )
    .limit(1);
  if (!optionRow) {
    [optionRow] = await tx
      .insert(variantOptionsTable)
      .values({ businessId, variantTypeId: type!.id, value: option.value.slice(0, 100) })
      .returning();
  }
  return { typeId: type!.id, typeName: type!.name, optionId: optionRow!.id };
}

/**
 * UOM import (Phase 6+): materialize the row's optional packaging config.
 * Creates (or updates, in the update path) ONE product-level conversion
 * row — direct-to-base factor, sale enabled, optional per-unit price — and
 * the optional package barcode as a variant alias carrying the conversion
 * qualifier. Everything re-validated here: the unit must exist (created
 * only when the session authorizes it), the factor must be positive, the
 * unit must not be the product's base unit, and the barcode must not
 * collide with any primary/alias code in the business (the validation
 * phase already flags these; this is the commit-time backstop).
 */
async function upsertImportPackaging(input: {
  tx: Tx;
  businessId: number;
  sessionId: number;
  product: {
    packageUnit: string | null;
    packageFactor: number | null;
    packageSalePrice: number | null;
    packageBarcode: string | null;
    unit: string | null;
  };
  productId: number;
  defaultVariantId: number;
  createMissingUnits: boolean;
  mode: "create" | "update";
  cache: MasterDataCache;
}): Promise<void> {
  const { tx, businessId, product } = input;
  if (!product.packageUnit || product.packageFactor == null || product.packageFactor <= 0) {
    return;
  }

  const [existingProduct] = await tx
    .select({ unitId: productsTable.unitId })
    .from(productsTable)
    .where(
      and(
        eq(productsTable.id, input.productId),
        eq(productsTable.businessId, businessId),
      ),
    )
    .limit(1);
  const unitId = await resolveMasterDataId(
    tx, businessId, input.cache, "unit", product.packageUnit,
    input.createMissingUnits, null,
  );
  if (unitId === null) {
    throw new BadRequestError(
      `Packaging unit "${product.packageUnit}" does not exist and creating units is disabled.`,
    );
  }
  if (existingProduct?.unitId != null && unitId === existingProduct.unitId) {
    throw new BadRequestError(
      "The packaging unit cannot be the product's base unit.",
    );
  }

  // One row per (product, product-scope, unit): update the existing config
  // when the unit matches, otherwise add a second packaging unit.
  const [existing] = await tx
    .select()
    .from(productUnitConversions)
    .where(
      and(
        eq(productUnitConversions.businessId, businessId),
        eq(productUnitConversions.productId, input.productId),
        sql`${productUnitConversions.variantId} IS NULL`,
        eq(productUnitConversions.unitId, unitId),
      ),
    )
    .limit(1);

  if (existing) {
    // Factor immutability (migration 0061 rule): only when nothing
    // references the row; prices stay updatable either way.
    const [ref] = await tx
      .select({ one: sql<number>`1` })
      .from(purchaseItems)
      .where(
        and(
          eq(purchaseItems.businessId, businessId),
          eq(purchaseItems.uomConversionId, existing.id),
        ),
      )
      .limit(1);
    const referenced = Boolean(ref);
    await tx
      .update(productUnitConversions)
      .set({
        ...(referenced
          ? {}
          : { conversionFactor: product.packageFactor }),
        salePrice: product.packageSalePrice ?? existing.salePrice,
        status: "active",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(productUnitConversions.id, existing.id),
          eq(productUnitConversions.businessId, businessId),
        ),
      );
  } else {
    await tx.insert(productUnitConversions).values({
      businessId,
      productId: input.productId,
      variantId: null,
      unitId,
      conversionFactor: product.packageFactor,
      isPurchaseEnabled: true,
      isSaleEnabled: true,
      salePrice: product.packageSalePrice ?? null,
      status: "active",
    });
  }

  // Package barcode → alias of the default variant, qualified by the
  // conversion row so a scan means ONE package.
  if (product.packageBarcode) {
    const [conversion] = await tx
      .select({ id: productUnitConversions.id })
      .from(productUnitConversions)
      .where(
        and(
          eq(productUnitConversions.businessId, businessId),
          eq(productUnitConversions.productId, input.productId),
          sql`${productUnitConversions.variantId} IS NULL`,
          eq(productUnitConversions.unitId, unitId),
          eq(productUnitConversions.status, "active"),
        ),
      )
      .limit(1);
    if (!conversion) throw new Error("Packaging conversion missing after upsert.");

    const code = product.packageBarcode.slice(0, 100);
    const [primaryOwner] = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.businessId, businessId),
          eq(productVariants.barcode, code),
        ),
      )
      .limit(1);
    if (primaryOwner) {
      throw new ConflictError(
        `Package barcode ${code} is already a primary barcode in this business.`,
      );
    }
    const [aliasOwner] = await tx
      .select({ id: variantBarcodeAliases.id, variantId: variantBarcodeAliases.variantId, uomConversionId: variantBarcodeAliases.uomConversionId })
      .from(variantBarcodeAliases)
      .where(
        and(
          eq(variantBarcodeAliases.businessId, businessId),
          eq(variantBarcodeAliases.barcode, code),
        ),
      )
      .limit(1);
    if (aliasOwner) {
      if (
        aliasOwner.variantId === input.defaultVariantId &&
        aliasOwner.uomConversionId === conversion.id
      ) {
        return; // idempotent re-import
      }
      throw new ConflictError(
        `Package barcode ${code} is already registered as another code in this business.`,
      );
    }
    await tx.insert(variantBarcodeAliases).values({
      businessId,
      variantId: input.defaultVariantId,
      barcode: code,
      barcodeFormat: detectBarcodeFormat(code),
      source: "external",
      uomConversionId: conversion.id,
    });
  }
}

async function executeGroupCreate(input: {
  tx: Tx;
  businessId: number;
  userId: number;
  sessionId: number;
  group: ReturnType<typeof groupRows>[number];
  cache: MasterDataCache;
  defaultLocationId: number;
  createMissingMasterData: boolean;
}): Promise<{ productId: number; variantIds: number[]; action: "created" }> {
  const { tx, businessId, group, cache } = input;
  await assertWithinProductLimit(businessId, tx);
  const product = group.product;
  const categoryId = await resolveMasterDataId(
    tx, businessId, cache, "category", product.category, input.createMissingMasterData, null,
  );
  const brandId = await resolveMasterDataId(
    tx, businessId, cache, "brand", product.brand, input.createMissingMasterData, null,
  );
  const unitId = await resolveMasterDataId(
    tx, businessId, cache, "unit", product.unit, input.createMissingMasterData, null,
  );
  if (unitId === null) {
    throw new BadRequestError(`Unit "${product.unit}" does not exist and creating units is disabled.`);
  }

  const [createdProduct] = await tx
    .insert(productsTable)
    .values({
      businessId,
      name: product.productName.slice(0, 100),
      categoryId,
      brandId,
      unitId,
      description: product.description?.slice(0, 200) ?? null,
      productType: product.productType,
      hasVariants: group.hasVariants,
      trackingType: product.trackingType,
      status: product.status,
    })
    .returning({ id: productsTable.id });

  const variantIds: number[] = [];
  for (const [index, row] of group.rows.entries()) {
    const locationId = await resolveLocationId(
      tx, businessId, cache, row.location, input.defaultLocationId,
    );
    const sku = row.sku ?? (await generateSku(tx, businessId));
    const barcodeFormat = row.barcode ? detectBarcodeFormat(row.barcode) : null;
    const [variant] = await tx
      .insert(productVariants)
      .values({
        businessId,
        productId: createdProduct!.id,
        sku: sku.slice(0, 100),
        barcode: row.barcode?.slice(0, 100) ?? null,
        barcodeFormat,
        sellingPrice: row.sellingPrice ?? 0,
        alertQuantity: row.alertQuantity ?? 0,
        isDefault: index === 0,
        status: row.status === "draft" ? "active" : row.status,
        weight: row.weight,
        weightUnit: row.weightUnit,
      })
      .returning({ id: productVariants.id });
    variantIds.push(variant!.id);

    if (group.hasVariants) {
      for (const option of row.optionValues) {
        const ids = await findOrCreateOptionIds(tx, businessId, option);
        await tx.insert(variantValuesTable).values({
          businessId,
          variantId: variant!.id,
          optionId: ids.optionId,
        });
      }
    }

    const opening = row.openingStock ?? 0;
    if (opening > 0 && product.trackingType !== "none") {
      const batchNumber =
        row.batchNumber?.slice(0, 100) ?? `AUTO-${variant!.id}-${Date.now()}`;
      await tx.insert(inventoryBatches).values({
        businessId,
        variantId: variant!.id,
        locationId,
        purchaseItemId: null,
        batchNumber,
        purchasePrice: row.purchasePrice ?? 0,
        quantityReceived: opening,
        quantityRemaining: opening,
        expiryDate: row.expiryDate ? new Date(row.expiryDate) : null,
      });
      await tx
        .insert(inventoryStock)
        .values({
          businessId,
          variantId: variant!.id,
          locationId,
          quantity: opening,
        })
        .onConflictDoUpdate({
          target: [
            inventoryStock.businessId,
            inventoryStock.variantId,
            inventoryStock.locationId,
          ],
          set: { quantity: sql`${inventoryStock.quantity} + ${opening}` },
        });
      await tx.insert(inventoryMovements).values({
        businessId,
        variantId: variant!.id,
        locationId,
        movementType: "adjustment",
        quantity: opening,
        referenceType: `product_import:${input.sessionId}`,
        referenceId: createdProduct!.id,
      });
      for (const serial of row.serialNumbers) {
        await tx.insert(serialNumbers).values({
          businessId,
          variantId: variant!.id,
          batchId: null,
          serialNumber: serial,
          locationId,
        });
      }
    } else if (opening > 0 && product.trackingType === "none") {
      // Non-tracked products keep no stock records (audit rule) — nothing to do.
    }

    if (row.imageUrl) {
      await tx.insert(productImagesTable).values({
        businessId,
        productId: createdProduct!.id,
        imageUrl: row.imageUrl.slice(0, 255),
        is_primary: index === 0,
        sortOrder: index,
      });
    }
  }

  // UOM import: optional packaging config + package barcode alias.
  await upsertImportPackaging({
    tx,
    businessId,
    sessionId: input.sessionId,
    product,
    productId: createdProduct!.id,
    defaultVariantId: variantIds[0]!,
    createMissingUnits: input.createMissingMasterData,
    mode: "create",
    cache,
  });

  await recordAuditInTx(tx, {
    businessId,
    actorUserId: input.userId,
    action: "product_import.create",
    entityType: "product",
    entityId: createdProduct!.id,
    metadata: { sessionId: input.sessionId, variants: variantIds.length },
  });
  return { productId: createdProduct!.id, variantIds, action: "created" as const };
}

async function executeGroupUpdate(input: {
  tx: Tx;
  businessId: number;
  userId: number;
  sessionId: number;
  group: ReturnType<typeof groupRows>[number];
  cache: MasterDataCache;
  updateFields: string[] | null;
  createMissingMasterData: boolean;
}): Promise<{ productId: number; variantIds: number[]; action: "updated" }> {
  const { tx, businessId, group, cache } = input;
  const product = group.product;
  const matched = (
    product as NormalizedRow & { match?: { variantId: number; productId: number } }
  ).match;
  if (!matched) throw new BadRequestError("Row has no matched product.");
  const fields = input.updateFields;

  const wantsProductFields =
    fields === null ||
    fields.some((f) =>
      ["product_name", "product_type", "category", "brand", "unit", "description", "status"].includes(f),
    );
  if (wantsProductFields) {
    const updates: Record<string, unknown> = {};
    if (fields === null || fields.includes("product_name"))
      updates.name = product.productName.slice(0, 100);
    if (fields === null || fields.includes("product_type"))
      updates.productType = product.productType;
    if (fields === null || fields.includes("description"))
      updates.description = product.description?.slice(0, 200) ?? null;
    if (fields === null || fields.includes("status")) updates.status = product.status;
    if (fields === null || fields.includes("category")) {
      const categoryId = await resolveMasterDataId(
        tx, businessId, cache, "category", product.category, false, null,
      );
      if (categoryId) updates.categoryId = categoryId;
    }
    if (fields === null || fields.includes("brand")) {
      const brandId = await resolveMasterDataId(
        tx, businessId, cache, "brand", product.brand, false, null,
      );
      if (brandId) updates.brandId = brandId;
    }
    if (fields === null || fields.includes("unit")) {
      const unitId = await resolveMasterDataId(
        tx, businessId, cache, "unit", product.unit, false, null,
      );
      if (unitId) updates.unitId = unitId;
    }
    if (Object.keys(updates).length > 0) {
      await tx
        .update(productsTable)
        .set(updates)
        .where(
          and(
            eq(productsTable.id, matched.productId),
            eq(productsTable.businessId, businessId),
          ),
        );
    }
  }

  // UOM import (update path): apply packaging changes only when the
  // session's update-fields list includes them (null = all fields).
  const wantsPackaging =
    fields === null ||
    fields.some((f) =>
      ["package_unit", "package_factor", "package_sale_price", "package_barcode"].includes(f),
    );
  if (wantsPackaging) {
    const productMatch = (
      product as NormalizedRow & { match?: { variantId: number; productId: number } }
    ).match;
    if (productMatch) {
      await upsertImportPackaging({
        tx,
        businessId,
        sessionId: input.sessionId,
        product,
        productId: productMatch.productId,
        defaultVariantId: productMatch.variantId,
        createMissingUnits: input.createMissingMasterData,
        mode: "update",
        cache,
      });
    }
  }

  const variantIds: number[] = [];
  for (const row of group.rows) {
    const match = (
      row as NormalizedRow & { match?: { variantId: number; productId: number } }
    ).match;
    if (!match) continue;
    const updates: Record<string, unknown> = {};
    if (fields === null || fields.includes("sku"))
      if (row.sku) updates.sku = row.sku.slice(0, 100);
    if (fields === null || fields.includes("barcode")) {
      updates.barcode = row.barcode?.slice(0, 100) ?? null;
      updates.barcodeFormat = row.barcode ? detectBarcodeFormat(row.barcode) : null;
    }
    if (fields === null || fields.includes("selling_price"))
      if (row.sellingPrice !== null) updates.sellingPrice = row.sellingPrice;
    if (fields === null || fields.includes("alert_quantity"))
      if (row.alertQuantity !== null) updates.alertQuantity = row.alertQuantity;
    if (Object.keys(updates).length > 0) {
      await tx
        .update(productVariants)
        .set(updates)
        .where(
          and(
            eq(productVariants.id, match.variantId),
            eq(productVariants.businessId, businessId),
          ),
        );
    }
    variantIds.push(match.variantId);

    // Opening stock for existing variants: additive batch + movement.
    const opening = row.openingStock ?? 0;
    if (opening > 0) {
      const locationId = await resolveLocationId(
        tx, businessId, cache, row.location,
        (await tx
          .select({ id: locationsTable.id })
          .from(locationsTable)
          .where(and(eq(locationsTable.businessId, businessId), sql`${locationsTable.isDefault} = true`))
          .limit(1))[0]?.id ?? 0,
      );
      if (product.trackingType !== "none") {
        await tx.insert(inventoryBatches).values({
          businessId,
          variantId: match.variantId,
          locationId,
          purchaseItemId: null,
          batchNumber: row.batchNumber?.slice(0, 100) ?? `AUTO-${match.variantId}-${Date.now()}`,
          purchasePrice: row.purchasePrice ?? 0,
          quantityReceived: opening,
          quantityRemaining: opening,
          expiryDate: row.expiryDate ? new Date(row.expiryDate) : null,
        });
      }
      await tx
        .insert(inventoryStock)
        .values({ businessId, variantId: match.variantId, locationId, quantity: opening })
        .onConflictDoUpdate({
          target: [
            inventoryStock.businessId,
            inventoryStock.variantId,
            inventoryStock.locationId,
          ],
          set: { quantity: sql`${inventoryStock.quantity} + ${opening}` },
        });
      await tx.insert(inventoryMovements).values({
        businessId,
        variantId: match.variantId,
        locationId,
        movementType: "adjustment",
        quantity: opening,
        referenceType: `product_import:${input.sessionId}`,
        referenceId: match.productId,
      });
    }
  }

  await recordAuditInTx(tx, {
    businessId,
    actorUserId: input.userId,
    action: "product_import.update",
    entityType: "product",
    entityId: matched.productId,
    metadata: { sessionId: input.sessionId, variants: variantIds.length },
  });
  return { productId: matched.productId, variantIds, action: "updated" as const };
}

export async function executeImportSession(input: {
  businessId: number;
  userId: number;
  sessionId: number;
  defaultLocationId: number;
}) {
  const session = await loadSession(input.businessId, input.sessionId);
  if (session.status === "running") {
    throw new ConflictError("This import is already running.");
  }
  if (["completed", "failed"].includes(session.status)) {
    throw new ConflictError("This import has already been executed.");
  }
  const rows = await loadRows(input.businessId, input.sessionId);
  const validRows = rows.filter((row) => row.status === "valid");
  if (validRows.length === 0) {
    throw new BadRequestError("No valid rows to import — validate first.");
  }

  const startedAt = new Date();
  const claimed = await db
    .update(productImportSessions)
    .set({ status: "running", startedAt, updatedAt: new Date() })
    .where(
      and(
        eq(productImportSessions.id, input.sessionId),
        eq(productImportSessions.businessId, input.businessId),
        inSessionStatuses(["draft", "mapped", "validated"]),
      ),
    )
    .returning({ id: productImportSessions.id });
  if (claimed.length === 0) {
    throw new ConflictError("This import is already running or finished.");
  }

  const options = (session.options ?? {}) as {
    updateFields?: string[] | null;
    createMissingMasterData?: boolean;
  };
  const cache: MasterDataCache = {
    categories: new Map(),
    brands: new Map(),
    units: new Map(),
    locations: new Map(),
  };
  const locationRows = await db
    .select({ id: locationsTable.id, name: locationsTable.name })
    .from(locationsTable)
    .where(eq(locationsTable.businessId, input.businessId));
  for (const row of locationRows)
    cache.locations.set(row.name.toLowerCase(), row.id);

  type NormalizedRowWithDb = NormalizedRow & { rowDbId: number };
  const normalized: NormalizedRowWithDb[] = [];
  for (const row of validRows) {
    const payload = (row.payload ?? {}) as {
      normalized?: NormalizedRow;
      record?: Record<string, string | null>;
    };
    const normalizedRow =
      payload.normalized ??
      normalizeRow(row.rowNumber, payload.record ?? {}, (session.mapping ?? {}) as Record<string, string>).row;
    // The match is computed at validation and persisted separately — it must
    // survive into execution (upsert/update modes rely on it).
    const persistedMatch = (payload as { match?: { variantId: number; productId: number } | null }).match;
    const withMatch =
      persistedMatch && !persistedMatch.variantId
        ? normalizedRow
        : { ...normalizedRow, match: persistedMatch ?? (normalizedRow as NormalizedRow & { match?: unknown }).match };
    normalized.push({ ...(withMatch as NormalizedRow), rowDbId: row.id });
  }
  const groups = groupRows(
    normalized.map(({ rowDbId: _rowDbId, ...row }) => row),
  ).map((group) => ({
    ...group,
    rows: group.rows.map(
      (row) =>
        ({
          ...row,
          rowDbId: normalized.find(
            (n) => n.groupKey === group.groupKey && n.rowNumber === row.rowNumber,
          )?.rowDbId,
        }) as NormalizedRowWithDb,
    ),
  }));

  let created = 0;
  let updated = 0;
  let failed = 0;
  let skipped = 0;
  const started = Date.now();

  for (let i = 0; i < groups.length; i += BATCH_GROUPS) {
    const chunk = groups.slice(i, i + BATCH_GROUPS);
    await Promise.all(
      chunk.map(async (group) => {
        try {
          const isUpdate =
            session.mode === "update" ||
            (session.mode === "upsert" &&
              !!(group.product as NormalizedRow & { match?: unknown }).match);
          const isSkip =
            session.mode === "skip" &&
            !!(group.product as NormalizedRow & { match?: unknown }).match;
          if (isSkip) {
            skipped += 1;
            for (const row of group.rows) {
              await db
                .update(productImportRows)
                .set({ status: "skipped", result: { action: "skipped" } })
                .where(eq(productImportRows.id, row.rowDbId));
            }
            return;
          }
          const result = await db.transaction(async (tx) =>
            isUpdate
              ? executeGroupUpdate({
                  tx,
                  businessId: input.businessId,
                  userId: input.userId,
                  sessionId: input.sessionId,
                  group,
                  cache,
                  updateFields: options.updateFields ?? null,
                  createMissingMasterData: options.createMissingMasterData ?? true,
                })
              : executeGroupCreate({
                  tx,
                  businessId: input.businessId,
                  userId: input.userId,
                  sessionId: input.sessionId,
                  group,
                  cache,
                  defaultLocationId: input.defaultLocationId,
                  createMissingMasterData: options.createMissingMasterData ?? true,
                }),
          );
          if (result.action === "created") created += 1;
          else updated += 1;
          for (const row of group.rows) {
            await db
              .update(productImportRows)
              .set({
                status: result.action === "created" ? "created" : "updated",
                result: {
                  action: result.action,
                  productId: result.productId,
                  variantId: result.variantIds[0] ?? null,
                },
              })
              .where(eq(productImportRows.id, row.rowDbId));
          }
        } catch (err) {
          failed += 1;
          const message =
            err instanceof Error ? err.message : "Import execution failed.";
          for (const row of group.rows) {
            await db
              .update(productImportRows)
              .set({
                status: "failed",
                errors: [{ code: "execution_failed", message }],
              })
              .where(eq(productImportRows.id, row.rowDbId));
          }
        }
      }),
    );
  }

  const totals = {
    totalRows: normalized.length,
    created,
    updated,
    skipped,
    failed,
    processingMs: Date.now() - started,
  };
  await db
    .update(productImportSessions)
    .set({
      status: "completed",
      totals: { ...((session.totals ?? {}) as object), ...totals },
      finishedAt: new Date(),
      processingMs: totals.processingMs,
      updatedAt: new Date(),
    })
    .where(eq(productImportSessions.id, input.sessionId));
  return totals;
}

// ----------------------------------------------------
// History + results
// ----------------------------------------------------

export async function listImportHistory(businessId: number) {
  return db
    .select({
      id: productImportSessions.id,
      filename: productImportSessions.filename,
      status: productImportSessions.status,
      mode: productImportSessions.mode,
      totals: productImportSessions.totals,
      createdAt: productImportSessions.createdAt,
      finishedAt: productImportSessions.finishedAt,
      processingMs: productImportSessions.processingMs,
    })
    .from(productImportSessions)
    .where(eq(productImportSessions.businessId, businessId))
    .orderBy(desc(productImportSessions.id))
    .limit(100);
}

export async function getSessionDetail(businessId: number, sessionId: number) {
  const session = await loadSession(businessId, sessionId);
  const rows = await loadRows(businessId, sessionId);
  return { session, rows };
}

/** Downloadable per-row error report (CSV). */
export async function buildErrorReport(
  businessId: number,
  sessionId: number,
): Promise<{ filename: string; csv: string } | null> {
  const session = await loadSession(businessId, sessionId);
  const rows = (await loadRows(businessId, sessionId)).filter(
    (row) => row.status === "error" || row.status === "failed",
  );
  if (rows.length === 0) return null;
  const escape = (value: unknown) =>
    `"${String(value ?? "").replace(/^[\t\r ]*[=+\-@]/, "'$&").replace(/"/g, '""')}"`;
  const lines = [
    ["row_number", "product", "status", "errors"].map(escape).join(","),
    ...rows.map((row) => {
      const errors = ((row.errors ?? []) as { message: string }[])
        .map((e) => e.message)
        .join("; ");
      return [
        row.rowNumber,
        row.productRef,
        row.status,
        errors,
      ]
        .map(escape)
        .join(",");
    }),
  ];
  return {
    filename: `import-${sessionId}-errors.csv`,
    csv: "\uFEFF" + lines.join("\r\n"),
  };
}
