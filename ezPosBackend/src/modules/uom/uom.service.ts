import { and, eq, inArray, or, isNull, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { NotFoundError, BadRequestError } from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import {
  productUnitConversions,
} from "../../db/schema/productUnitConversions.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { units } from "../../db/schema/units.js";
import {
  factorToMicros,
  enteredToBaseMicros,
  assertWholeBaseQuantity,
  UomWholeQuantityError,
  perBasePriceMicros,
  amountToMicros,
  microsToNumber,
  floorDivAvailable,
  MICROS,
} from "./uom.money.js";

/**
 * Multiple Units of Measure (UOM) — shared resolver.
 *
 * The SINGLE choke point every flow (purchases, sales, returns, barcodes,
 * held carts, offline sync) must use to turn "5 Box @ ৳1,200" into stored
 * base-unit figures. The backend ALWAYS resolves the authoritative factor
 * and prices from the database — frontend-submitted factors/prices are
 * advisory and never trusted.
 *
 * Identity contract: `uomConversionId == null` (or a product with no
 * conversion rows) means the product's base unit with factor 1 — single-unit
 * products need no configuration and behave exactly as before UOM existed.
 */

/** Anything that can execute queries: the pool db or a transaction. */
export type DbExecutor = Pick<
  typeof db,
  "select" | "insert" | "update" | "delete"
>;

export type UnitConversionRow = typeof productUnitConversions.$inferSelect;

export interface UomUnitInfo {
  id: number;
  name: string;
  abbreviation: string | null;
}

export interface UomContext {
  /** Null = the product's base unit (identity conversion, factor 1). */
  conversion: UnitConversionRow | null;
  /** How many base units one entered unit contains. */
  factor: number;
  factorMicros: bigint;
  /** The unit the operator is entering quantities in. */
  unit: UomUnitInfo;
  /** The product's base unit (what stock is stored in). */
  baseUnit: UomUnitInfo | null;
}

const IDENTITY_FACTOR_MICROS = MICROS;

/**
 * Resolve a conversion id (or null = base unit) against a product/variant,
 * enforcing tenant, product and variant scope. `requireActive` (default
 * true) rejects inactive rows for NEW documents; history reads pass false.
 */
export async function resolveUomContext(
  dbe: DbExecutor,
  businessId: number,
  productId: number,
  variantId: number | null,
  uomConversionId: number | null | undefined,
  options: { requireActive?: boolean } = {},
): Promise<UomContext> {
  const requireActive = options.requireActive ?? true;

  const baseUnitRow = await loadBaseUnit(dbe, businessId, productId);

  if (uomConversionId == null) {
    return {
      conversion: null,
      factor: 1,
      factorMicros: IDENTITY_FACTOR_MICROS,
      unit: baseUnitRow ?? { id: 0, name: "units", abbreviation: null },
      baseUnit: baseUnitRow,
    };
  }

  const [row] = await dbe
    .select({
      conversion: productUnitConversions,
      unitName: units.name,
      unitAbbreviation: units.abbreviation,
    })
    .from(productUnitConversions)
    .innerJoin(units, eq(units.id, productUnitConversions.unitId))
    .where(
      and(
        eq(productUnitConversions.id, uomConversionId),
        eq(productUnitConversions.businessId, businessId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new NotFoundError("Packaging unit not found for this business.");
  }
  if (row.conversion.productId !== productId) {
    throw new BadRequestError(
      "The selected packaging unit does not belong to this product.",
    );
  }
  if (row.conversion.variantId !== null && row.conversion.variantId !== variantId) {
    throw new BadRequestError(
      "The selected packaging unit is configured for a different variant.",
    );
  }
  if (requireActive && row.conversion.status !== "active") {
    throw new BadRequestError("The selected packaging unit is inactive.");
  }

  const factorMicros = factorToMicros(row.conversion.conversionFactor);
  return {
    conversion: row.conversion,
    factor: row.conversion.conversionFactor,
    factorMicros,
    unit: {
      id: row.conversion.unitId,
      name: row.unitName,
      abbreviation: row.unitAbbreviation,
    },
    baseUnit: baseUnitRow,
  };
}

/** The product's base unit (products.unit_id) — what stock is stored in. */
export async function loadBaseUnit(
  dbe: DbExecutor,
  businessId: number,
  productId: number,
): Promise<UomUnitInfo | null> {
  const [row] = await dbe
    .select({ id: units.id, name: units.name, abbreviation: units.abbreviation })
    .from(products)
    .innerJoin(units, eq(units.id, products.unitId))
    .where(and(eq(products.id, productId), eq(products.businessId, businessId)))
    .limit(1);
  return row ?? null;
}

export interface ConvertedLine {
  /** Base quantity on the 6-dp grid. */
  baseQuantity: number;
  baseMicros: bigint;
  /** Stored per-base price at 6-dp (entered price ÷ factor). */
  baseUnitPrice: number;
}

/**
 * Convert an entered quantity (+ optional entered-unit price) to stored
 * base-unit figures. `wholeBase` enforces the INTEGER-stock invariant for
 * flows that touch stock/batches (receiving, sales, returns, transfers);
 * purchase-order lines pass false (ordered qty may sit at 3-dp until a
 * whole-unit receipt arrives).
 */
export function convertEnteredLine(
  ctx: UomContext,
  enteredQuantity: number,
  enteredUnitPrice: number | null | undefined,
  options: { wholeBase?: boolean } = {},
): ConvertedLine {
  const baseMicros = enteredToBaseMicros(enteredQuantity, ctx.factorMicros);
  if (options.wholeBase) {
    try {
      assertWholeBaseQuantity(baseMicros, ctx.baseUnit?.name ?? "base units");
    } catch (err) {
      if (err instanceof UomWholeQuantityError) {
        throw new BadRequestError(err.message);
      }
      throw err;
    }
  }
  const baseUnitPrice =
    enteredUnitPrice != null
      ? microsToNumber(perBasePriceMicros(enteredUnitPrice, ctx.factorMicros))
      : 0;
  return {
    baseQuantity: microsToNumber(baseMicros),
    baseMicros,
    baseUnitPrice,
  };
}

/**
 * Default sale price per entered unit for the POS: the configured
 * conversion.sale_price when set, else factor × variant.sellingPrice
 * (rounded to currency at the 2-dp grid).
 */
export function resolveSaleUnitPrice(
  ctx: UomContext,
  variantSellingPrice: number,
): number {
  if (ctx.conversion?.salePrice != null) return ctx.conversion.salePrice;
  if (ctx.factorMicros === MICROS) return variantSellingPrice;
  const derived = microsToNumber(
    (amountToMicros(variantSellingPrice) * ctx.factorMicros) / MICROS,
  );
  return roundMoney(derived);
}

/**
 * POS sell-units for a variant: the base unit always first, then every
 * active sale-enabled conversion (product-level defaults plus the
 * variant's own overrides), each with its resolved price and how many
 * whole packages the available stock covers.
 */
export interface SellUnitOption {
  uomConversionId: number | null;
  unitId: number;
  unitName: string;
  unitAbbreviation: string | null;
  conversionFactor: number;
  salePrice: number;
  availablePackages: number | null;
  isDefaultSale: boolean;
}

export async function listSaleUnitsForVariant(
  dbe: DbExecutor,
  businessId: number,
  variantId: number,
  availableBaseQuantity: number | null,
): Promise<{ baseUnit: UomUnitInfo | null; units: SellUnitOption[] }> {
  const [variant] = await dbe
    .select({
      sellingPrice: productVariants.sellingPrice,
      productId: productVariants.productId,
      productName: products.name,
      baseUnitId: units.id,
      baseUnitName: units.name,
      baseUnitAbbreviation: units.abbreviation,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(units, eq(units.id, products.unitId))
    .where(
      and(eq(productVariants.id, variantId), eq(productVariants.businessId, businessId)),
    )
    .limit(1);
  if (!variant) throw new NotFoundError("Variant not found.");

  const rows = await dbe
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
        eq(productUnitConversions.productId, variant.productId),
        eq(productUnitConversions.status, "active"),
        eq(productUnitConversions.isSaleEnabled, true),
        or(
          isNull(productUnitConversions.variantId),
          eq(productUnitConversions.variantId, variantId),
        ),
      ),
    )
    .orderBy(productUnitConversions.conversionFactor);

  const baseUnit: UomUnitInfo | null = variant.baseUnitId
    ? {
        id: variant.baseUnitId,
        name: variant.baseUnitName ?? "units",
        abbreviation: variant.baseUnitAbbreviation,
      }
    : null;

  const unitsOut: SellUnitOption[] = [
    {
      uomConversionId: null,
      unitId: variant.baseUnitId ?? 0,
      unitName: variant.baseUnitName ?? baseUnit?.name ?? "Base",
      unitAbbreviation: variant.baseUnitAbbreviation,
      conversionFactor: 1,
      salePrice: variant.sellingPrice,
      availablePackages:
        availableBaseQuantity == null ? null : Math.floor(availableBaseQuantity),
      isDefaultSale: !rows.some((r) => r.conversion.isDefaultSale),
    },
  ];

  for (const { conversion, unitName, unitAbbreviation } of rows) {
    const ctx: UomContext = {
      conversion,
      factor: conversion.conversionFactor,
      factorMicros: factorToMicros(conversion.conversionFactor),
      unit: { id: conversion.unitId, name: unitName, abbreviation: unitAbbreviation },
      baseUnit,
    };
    unitsOut.push({
      uomConversionId: conversion.id,
      unitId: conversion.unitId,
      unitName,
      unitAbbreviation,
      conversionFactor: conversion.conversionFactor,
      salePrice: resolveSaleUnitPrice(ctx, variant.sellingPrice),
      availablePackages:
        availableBaseQuantity == null
          ? null
          : floorDivAvailable(availableBaseQuantity, ctx.factorMicros),
      isDefaultSale: conversion.isDefaultSale,
    });
  }

  return { baseUnit, units: unitsOut };
}

/** Purchase-units for a variant (order/receiving/return unit pickers). */
export interface PurchaseUnitOption {
  uomConversionId: number | null;
  unitId: number;
  unitName: string;
  unitAbbreviation: string | null;
  conversionFactor: number;
  defaultPurchasePrice: number | null;
  isDefaultPurchase: boolean;
}

export async function listPurchaseUnitsForVariant(
  dbe: DbExecutor,
  businessId: number,
  variantId: number,
): Promise<{ baseUnit: UomUnitInfo | null; units: PurchaseUnitOption[] }> {
  const [variant] = await dbe
    .select({
      productId: productVariants.productId,
      baseUnitId: units.id,
      baseUnitName: units.name,
      baseUnitAbbreviation: units.abbreviation,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(units, eq(units.id, products.unitId))
    .where(
      and(eq(productVariants.id, variantId), eq(productVariants.businessId, businessId)),
    )
    .limit(1);
  if (!variant) throw new NotFoundError("Variant not found.");

  const rows = await dbe
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
        eq(productUnitConversions.productId, variant.productId),
        eq(productUnitConversions.status, "active"),
        eq(productUnitConversions.isPurchaseEnabled, true),
        or(
          isNull(productUnitConversions.variantId),
          eq(productUnitConversions.variantId, variantId),
        ),
      ),
    )
    .orderBy(productUnitConversions.conversionFactor);

  const baseUnit: UomUnitInfo | null = variant.baseUnitId
    ? {
        id: variant.baseUnitId,
        name: variant.baseUnitName ?? "units",
        abbreviation: variant.baseUnitAbbreviation,
      }
    : null;

  return {
    baseUnit,
    units: [
      {
        uomConversionId: null,
        unitId: variant.baseUnitId ?? 0,
        unitName: variant.baseUnitName ?? baseUnit?.name ?? "Base",
        unitAbbreviation: variant.baseUnitAbbreviation,
        conversionFactor: 1,
        defaultPurchasePrice: null,
        isDefaultPurchase: !rows.some((r) => r.conversion.isDefaultPurchase),
      },
      ...rows.map(({ conversion, unitName, unitAbbreviation }) => ({
        uomConversionId: conversion.id,
        unitId: conversion.unitId,
        unitName,
        unitAbbreviation,
        conversionFactor: conversion.conversionFactor,
        defaultPurchasePrice: conversion.purchasePrice,
        isDefaultPurchase: conversion.isDefaultPurchase,
      })),
    ],
  };
}

/**
 * Bulk factor map for read paths that already hold conversion rows
 * (report rendering, receipt display): id → factor. Only returns ACTIVE
 * rows unless `includeInactive`.
 */
export async function loadConversionFactorMap(
  dbe: DbExecutor,
  businessId: number,
  conversionIds: number[],
  includeInactive = false,
): Promise<Map<number, UnitConversionRow>> {
  if (conversionIds.length === 0) return new Map();
  const rows = await dbe
    .select()
    .from(productUnitConversions)
    .where(
      and(
        eq(productUnitConversions.businessId, businessId),
        inArray(productUnitConversions.id, conversionIds),
        ...(includeInactive
          ? []
          : [sql`${productUnitConversions.status} = 'active'`]),
      ),
    );
  return new Map(rows.map((r) => [r.id, r]));
}
