import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  NotFoundError,
  BadRequestError,
  ConflictError,
} from "../../utils/handleError.js";
import { productUnitConversions } from "../../db/schema/productUnitConversions.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { units } from "../../db/schema/units.js";
import {
  purchaseItems,
} from "../../db/schema/purchaseItems.js";
import { saleItems } from "../../db/schema/saleItems.js";
import { purchaseReceivingRecords } from "../../db/schema/purchaseReceivingRecords.js";
import { purchaseReturnItems } from "../../db/schema/purchaseReturnItems.js";
import { variantBarcodeAliases } from "../../db/schema/variantBarcodeAliases.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { amountToMicros, microsToNumber, MICROS } from "./uom.money.js";

/**
 * UOM configuration CRUD (the "Units & Packaging" product-form backend).
 *
 * Editing safety (master prompt §5E): a conversion row's FACTOR is immutable
 * once any transaction or barcode alias references it — the safe operation
 * thereafter is deactivation. Historical transactions always keep their own
 * factor snapshots, so deactivation never rewrites history either; it only
 * hides the unit from new documents.
 */

export interface UomConfigRow {
  id: number;
  variantId: number | null;
  unitId: number;
  unitName: string;
  unitAbbreviation: string | null;
  conversionFactor: number;
  isPurchaseEnabled: boolean;
  isSaleEnabled: boolean;
  isDefaultPurchase: boolean;
  isDefaultSale: boolean;
  salePrice: number | null;
  purchasePrice: number | null;
  status: string;
  /** True when any transaction or package barcode references this row. */
  isLocked: boolean;
  derivedSalePrice: number | null;
}

export async function listProductUom(
  businessId: number,
  productId: number,
): Promise<{
  baseUnit: { id: number; name: string; abbreviation: string | null } | null;
  units: UomConfigRow[];
}> {
  const [product] = await db
    .select({
      id: products.id,
      unitId: products.unitId,
      unitName: units.name,
      unitAbbreviation: units.abbreviation,
    })
    .from(products)
    .leftJoin(units, eq(units.id, products.unitId))
    .where(and(eq(products.id, productId), eq(products.businessId, businessId)))
    .limit(1);
  if (!product) throw new NotFoundError("Product not found.");

  const rows = await db
    .select({
      conversion: productUnitConversions,
      unitName: units.name,
      unitAbbreviation: units.abbreviation,
    })
    .from(productUnitConversions)
    .innerJoin(units, eq(units.id, productUnitConversions.unitId))
    .where(
      and(
        eq(productUnitConversions.businessId, businessId),
        eq(productUnitConversions.productId, productId),
      ),
    )
    .orderBy(productUnitConversions.variantId, productUnitConversions.conversionFactor);

  const baseUnit = product.unitId
    ? {
        id: product.unitId,
        name: product.unitName ?? "units",
        abbreviation: product.unitAbbreviation,
      }
    : null;

  // Variant selling prices for the derived-price hint: variant override rows
  // derive from their own variant; product-level rows from the default
  // variant (falling back to the first variant).
  const variants = await db
    .select({
      id: productVariants.id,
      sellingPrice: productVariants.sellingPrice,
      isDefault: productVariants.isDefault,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.businessId, businessId),
        eq(productVariants.productId, productId),
      ),
    );
  const variantPrices = new Map<number, number>();
  for (const v of variants) variantPrices.set(v.id, v.sellingPrice);
  const defaultVariantPrice =
    variants.find((v) => v.isDefault)?.sellingPrice ?? variants[0]?.sellingPrice ?? null;

  const out: UomConfigRow[] = [];
  for (const { conversion, unitName, unitAbbreviation } of rows) {
    const isLocked = await conversionIsReferenced(businessId, conversion.id);
    const basePrice =
      conversion.variantId != null
        ? (variantPrices.get(conversion.variantId) ?? null)
        : defaultVariantPrice;
    out.push({
      id: conversion.id,
      variantId: conversion.variantId,
      unitId: conversion.unitId,
      unitName,
      unitAbbreviation,
      conversionFactor: conversion.conversionFactor,
      isPurchaseEnabled: conversion.isPurchaseEnabled,
      isSaleEnabled: conversion.isSaleEnabled,
      isDefaultPurchase: conversion.isDefaultPurchase,
      isDefaultSale: conversion.isDefaultSale,
      salePrice: conversion.salePrice,
      purchasePrice: conversion.purchasePrice,
      status: conversion.status,
      isLocked,
      derivedSalePrice:
        conversion.salePrice != null
          ? null
          : basePrice != null
            ? roundMoney(
                microsToNumber(
                  (amountToMicros(basePrice) * BigInt(Math.round(conversion.conversionFactor * 1e6))) /
                    MICROS,
                ),
              )
            : null,
    });
  }
  return { baseUnit, units: out };
}

/** Any transaction line or package barcode pointing at this conversion? */
async function conversionIsReferenced(
  businessId: number,
  conversionId: number,
): Promise<boolean> {
  const [pi] = await db
    .select({ one: sql<number>`1` })
    .from(purchaseItems)
    .where(
      and(
        eq(purchaseItems.businessId, businessId),
        eq(purchaseItems.uomConversionId, conversionId),
      ),
    )
    .limit(1);
  if (pi) return true;
  const [si] = await db
    .select({ one: sql<number>`1` })
    .from(saleItems)
    .where(
      and(
        eq(saleItems.businessId, businessId),
        eq(saleItems.uomConversionId, conversionId),
      ),
    )
    .limit(1);
  if (si) return true;
  const [pr] = await db
    .select({ one: sql<number>`1` })
    .from(purchaseReceivingRecords)
    .where(
      and(
        eq(purchaseReceivingRecords.businessId, businessId),
        eq(purchaseReceivingRecords.uomConversionId, conversionId),
      ),
    )
    .limit(1);
  if (pr) return true;
  const [pri] = await db
    .select({ one: sql<number>`1` })
    .from(purchaseReturnItems)
    .where(
      and(
        eq(purchaseReturnItems.businessId, businessId),
        eq(purchaseReturnItems.uomConversionId, conversionId),
      ),
    )
    .limit(1);
  if (pri) return true;
  const [alias] = await db
    .select({ one: sql<number>`1` })
    .from(variantBarcodeAliases)
    .where(
      and(
        eq(variantBarcodeAliases.businessId, businessId),
        eq(variantBarcodeAliases.uomConversionId, conversionId),
      ),
    )
    .limit(1);
  return Boolean(alias);
}

export interface CreateConversionInput {
  variantId?: number | null | undefined;
  unitId: number;
  conversionFactor: number;
  isPurchaseEnabled?: boolean | undefined;
  isSaleEnabled?: boolean | undefined;
  isDefaultPurchase?: boolean | undefined;
  isDefaultSale?: boolean | undefined;
  salePrice?: number | null | undefined;
  purchasePrice?: number | null | undefined;
}

export async function createConversion(
  businessId: number,
  productId: number,
  input: CreateConversionInput,
): Promise<UomConfigRow> {
  const [product] = await db
    .select({ id: products.id, unitId: products.unitId })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.businessId, businessId)))
    .limit(1);
  if (!product) throw new NotFoundError("Product not found.");

  const [unit] = await db
    .select({ id: units.id })
    .from(units)
    .where(and(eq(units.id, input.unitId), eq(units.businessId, businessId)))
    .limit(1);
  if (!unit) throw new BadRequestError("Unknown unit for this business.");

  if (product.unitId != null && input.unitId === product.unitId) {
    throw new BadRequestError(
      "The base unit is always available with a conversion of 1 — pick a different unit to add packaging.",
    );
  }
  if (input.conversionFactor <= 0) {
    throw new BadRequestError("Conversion factor must be greater than zero.");
  }

  if (input.variantId != null) {
    const [variant] = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.id, input.variantId),
          eq(productVariants.businessId, businessId),
          eq(productVariants.productId, productId),
        ),
      )
      .limit(1);
    if (!variant) {
      throw new BadRequestError(
        "The variant override does not belong to this product.",
      );
    }
  }

  // One row per (product, variant-scope, unit) — including inactive rows:
  // re-activating an existing configuration is the supported path.
  const [existing] = await db
    .select({ id: productUnitConversions.id, status: productUnitConversions.status })
    .from(productUnitConversions)
    .where(
      and(
        eq(productUnitConversions.businessId, businessId),
        eq(productUnitConversions.productId, productId),
        input.variantId != null
          ? eq(productUnitConversions.variantId, input.variantId)
          : isNull(productUnitConversions.variantId),
        eq(productUnitConversions.unitId, input.unitId),
      ),
    )
    .limit(1);
  if (existing) {
    throw new ConflictError(
      "This unit is already configured for the product" +
        (existing.status === "inactive"
          ? " (currently inactive — reactivate it instead)."
          : "."),
    );
  }

  const isDefaultSale = input.isDefaultSale ?? false;
  const isDefaultPurchase = input.isDefaultPurchase ?? false;

  const [created] = await db
    .insert(productUnitConversions)
    .values({
      businessId,
      productId,
      variantId: input.variantId ?? null,
      unitId: input.unitId,
      conversionFactor: input.conversionFactor,
      isPurchaseEnabled: input.isPurchaseEnabled ?? true,
      isSaleEnabled: input.isSaleEnabled ?? true,
      isDefaultSale,
      isDefaultPurchase,
      salePrice: input.salePrice ?? null,
      purchasePrice: input.purchasePrice ?? null,
      status: "active",
    })
    .returning();
  if (!created) throw new NotFoundError("Packaging unit not found after creation.");

  if (isDefaultSale) await clearOtherDefaults(businessId, productId, created, "sale");
  if (isDefaultPurchase) {
    await clearOtherDefaults(businessId, productId, created, "purchase");
  }

  const { units: list } = await listProductUom(businessId, productId);
  return list.find((u) => u.id === created.id)!;
}

export interface UpdateConversionInput {
  conversionFactor?: number | undefined;
  isPurchaseEnabled?: boolean | undefined;
  isSaleEnabled?: boolean | undefined;
  isDefaultPurchase?: boolean | undefined;
  isDefaultSale?: boolean | undefined;
  salePrice?: number | null | undefined;
  purchasePrice?: number | null | undefined;
  status?: "active" | "inactive" | undefined;
}

export async function updateConversion(
  businessId: number,
  conversionId: number,
  input: UpdateConversionInput,
): Promise<UomConfigRow> {
  const [row] = await db
    .select()
    .from(productUnitConversions)
    .where(
      and(
        eq(productUnitConversions.id, conversionId),
        eq(productUnitConversions.businessId, businessId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Packaging unit not found.");

  const patch: Partial<typeof productUnitConversions.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (input.conversionFactor !== undefined) {
    if (input.conversionFactor <= 0) {
      throw new BadRequestError("Conversion factor must be greater than zero.");
    }
    if (input.conversionFactor !== row.conversionFactor) {
      if (await conversionIsReferenced(businessId, conversionId)) {
        throw new ConflictError(
          "This packaging unit is already used by transactions or package barcodes — its conversion factor can no longer change. Deactivate it and add a new packaging unit instead.",
        );
      }
      patch.conversionFactor = input.conversionFactor;
    }
  }

  for (const key of [
    "isPurchaseEnabled",
    "isSaleEnabled",
    "isDefaultPurchase",
    "isDefaultSale",
  ] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.salePrice !== undefined) patch.salePrice = input.salePrice;
  if (input.purchasePrice !== undefined) patch.purchasePrice = input.purchasePrice;
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "inactive") {
      throw new BadRequestError("Invalid status.");
    }
    patch.status = input.status;
  }

  const [updated] = await db
    .update(productUnitConversions)
    .set(patch)
    .where(
      and(
        eq(productUnitConversions.id, conversionId),
        eq(productUnitConversions.businessId, businessId),
      ),
    )
    .returning();
  if (!updated) throw new NotFoundError("Packaging unit not found after update.");

  if (updated.isDefaultSale) await clearOtherDefaults(businessId, row.productId, updated, "sale");
  if (updated.isDefaultPurchase) {
    await clearOtherDefaults(businessId, row.productId, updated, "purchase");
  }

  const { units: list } = await listProductUom(businessId, row.productId);
  return list.find((u) => u.id === updated.id)!;
}

export async function deactivateConversion(
  businessId: number,
  conversionId: number,
): Promise<UomConfigRow> {
  const [row] = await db
    .select({ productId: productUnitConversions.productId })
    .from(productUnitConversions)
    .where(
      and(
        eq(productUnitConversions.id, conversionId),
        eq(productUnitConversions.businessId, businessId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Packaging unit not found.");

  await db
    .update(productUnitConversions)
    .set({
      status: "inactive",
      isDefaultSale: false,
      isDefaultPurchase: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(productUnitConversions.id, conversionId),
        eq(productUnitConversions.businessId, businessId),
      ),
    );

  const { units: list } = await listProductUom(businessId, row.productId);
  return list.find((u) => u.id === conversionId)!;
}

/** Enforce "at most one default per scope" after a default is set. */
async function clearOtherDefaults(
  businessId: number,
  productId: number,
  keep: { id: number; variantId: number | null },
  kind: "sale" | "purchase",
): Promise<void> {
  const flag =
    kind === "sale"
      ? { col: productUnitConversions.isDefaultSale, set: { isDefaultSale: false } }
      : {
          col: productUnitConversions.isDefaultPurchase,
          set: { isDefaultPurchase: false },
        };
  await db
    .update(productUnitConversions)
    .set({ ...flag.set, updatedAt: new Date() })
    .where(
      and(
        eq(productUnitConversions.businessId, businessId),
        eq(productUnitConversions.productId, productId),
        keep.variantId != null
          ? eq(productUnitConversions.variantId, keep.variantId)
          : isNull(productUnitConversions.variantId),
        eq(flag.col, true),
        sql`${productUnitConversions.id} <> ${keep.id}`,
      ),
    );
}

/**
 * Units cannot be deleted while any conversion row (or transaction) still
 * references them — wired into the existing unit-delete guard.
 */
export async function assertUnitNotUsedByConversions(
  businessId: number,
  unitId: number,
): Promise<void> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(productUnitConversions)
    .where(
      and(
        eq(productUnitConversions.businessId, businessId),
        eq(productUnitConversions.unitId, unitId),
      ),
    )
    .limit(1);
  if (row) {
    throw new ConflictError(
      "This unit is used by a product's packaging configuration. Remove that packaging unit first.",
    );
  }
}
