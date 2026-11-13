import { publishRealtime } from "../realtime/realtime.service.js";
import { assertUnitNotUsedByConversions } from "../uom/uom.admin.service.js";
import {
  and,
  eq,
  inArray,
  sql,
  type ExtractTablesWithRelations,
  gt,
  asc,
} from "drizzle-orm";
import { brands } from "../../db/schema/brands.js";
import { categories } from "../../db/schema/categories.js";
import { db } from "../../db/schema/index.js";
import { suppliers } from "../../db/schema/suppliers.js";
import { units } from "../../db/schema/units.js";
import { variantOptions } from "../../db/schema/variantOptions.js";
import { variantTypes } from "../../db/schema/variantTypes.js";
import type { ProductType, VariantType } from "./schemas/product.schema.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { variantValues } from "../../db/schema/variantValues.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { assertWithinProductLimit } from "../../services/entitlements.js";
import { recordAuditInTx } from "../../services/audit.js";
import { detectBarcodeFormat } from "../barcodes/barcodes.validation.js";
import type { AddCategorySchemaType } from "./schemas/category.schema.js";
import type { BrandSchemaType } from "./schemas/brand.schema.js";
import type { UnitSchemaType } from "./schemas/unit.schema.js";
import type {
  VariantOptionSchemaType,
  VariantTypeSchemaType,
} from "./schemas/variant.schema.js";
import {
  formatProductSku,
  nextDocumentNumber,
} from "../../utils/documentSequence.js";

type Tx = PgTransaction<
  NodePgQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

// Every function takes the caller's server-verified businessId (from
// requireBusinessContext) and scopes all reads and writes to it.

async function getBrands(businessId: number) {
  return db
    .select({
      value: brands.id,
      label: brands.name,
      status: sql<string>`COALESCE(${brands.status}, 'active')`,
      productCount: sql<number>`(SELECT COUNT(*)::int FROM products WHERE brand_id = ${brands.id} AND business_id = ${businessId})`,
    })
    .from(brands)
    .where(eq(brands.businessId, businessId));
}
async function getUnits(businessId: number) {
  return db
    .select({
      value: units.id,
      label: units.name,
      abbreviation: units.abbreviation,
      productCount: sql<number>`(SELECT COUNT(*)::int FROM products WHERE unit_id = ${units.id} AND business_id = ${businessId})`,
    })
    .from(units)
    .where(eq(units.businessId, businessId));
}
async function getCategories(businessId: number) {
  return db
    .select({
      value: categories.id,
      label: categories.name,
      parentCategoryId: categories.parentId,
      description: categories.description,
      status: sql<string>`COALESCE(${categories.status}, 'active')`,
      productCount: sql<number>`(SELECT COUNT(*)::int FROM products WHERE category_id = ${categories.id} AND business_id = ${businessId})`,
    })
    .from(categories)
    .where(eq(categories.businessId, businessId));
}
async function getSuppliers(businessId: number) {
  return db
    .select({
      value: suppliers.id,
      label: suppliers.name,
    })
    .from(suppliers)
    .where(eq(suppliers.businessId, businessId));
}
export async function getProductSelectOptions(businessId: number) {
  const [allBrands, allUnits, allCategories, allSuppliers] = await Promise.all([
    getBrands(businessId),
    getUnits(businessId),
    getCategories(businessId),
    getSuppliers(businessId),
  ]);
  return {
    brands: allBrands,
    units: allUnits,
    categories: allCategories,
    suppliers: allSuppliers,
  };
}
export async function getProductVariantOptions(businessId: number) {
  return await db
    .select({
      typeId: variantTypes.id,
      typeName: variantTypes.name,
      options: sql<{ optionId: number; value: string }[]>`
        COALESCE(
          ARRAY_AGG(
              JSON_BUILD_OBJECT('optionId',${variantOptions.id},'value',${variantOptions.value})
              ORDER BY ${variantOptions.value}
            ) FILTER (WHERE ${variantOptions.id} IS NOT NULL),
            ARRAY[]::json[]
        )
      `,
    })
    .from(variantTypes)
    .leftJoin(
      variantOptions,
      and(
        eq(variantOptions.variantTypeId, variantTypes.id),
        eq(variantOptions.businessId, businessId),
      ),
    )
    .where(eq(variantTypes.businessId, businessId))
    .groupBy(variantTypes.id, variantTypes.name);
}
async function validateProductReferences(
  tx: Tx,
  businessId: number,
  data: ProductType,
) {
  //1. category
  if (data.categoryId !== null) {
    const category = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.id, data.categoryId),
          eq(categories.businessId, businessId),
        ),
      );
    if (category.length === 0) {
      throw new NotFoundError("Category does not exist");
    }
  }
  //2. brand
  if (data.brandId !== null) {
    const brand = await tx
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.id, data.brandId), eq(brands.businessId, businessId)));
    if (brand.length === 0) {
      throw new NotFoundError("Brand does not exist");
    }
  }
  //3. unit
  const unit = await tx
    .select({ id: units.id })
    .from(units)
    .where(and(eq(units.id, data.unitId), eq(units.businessId, businessId)));
  if (unit.length === 0) {
    throw new NotFoundError("Unit does not exist");
  }
  //4. validate suppliers
  if (data.supplierId !== null) {
    const supplier = await tx
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.id, data.supplierId),
          eq(suppliers.businessId, businessId),
        ),
      );
    if (supplier.length === 0) {
      throw new NotFoundError("Supplier does not exist");
    }
  }
}
function validateProductRules(data: ProductType) {
  // If product has variants, at least one variant is required
  if (data.hasVariants && data.variants.length === 0) {
    throw new NotFoundError(
      "Product with variants must have at least one variant",
    );
  }
  // validate default variants
  const defaultVariants = data.variants.filter((variant) => variant.isDefault);
  if (defaultVariants.length > 1) {
    throw new NotFoundError("Only one variant can be the default variant");
  }
  // validate one default
  if (
    data.hasVariants &&
    data.variants.length > 0 &&
    defaultVariants.length === 0
  ) {
    throw new NotFoundError("One variant must be selected as default");
  }
}
async function validateVariantRulesAndRef(
  tx: Tx,
  businessId: number,
  data: ProductType,
) {
  for (const variant of data.variants) {
    // Options
    if (data.hasVariants) {
      if (!variant.options || variant.options.length === 0) {
        throw new NotFoundError("Variant options are required");
      }

      // Validate option IDs
      const optionTypeIds = new Set<number>();
      for (const option of variant.options) {
        if (optionTypeIds.has(option.typeId)) {
          throw new BadRequestError(
            "A variant can only include one value for each option type.",
          );
        }
        optionTypeIds.add(option.typeId);
        const variantOption = await tx
          .select({ id: variantOptions.id })
          .from(variantOptions)
          .where(
            and(
              eq(variantOptions.id, option.optionId),
              eq(variantOptions.variantTypeId, option.typeId),
              eq(variantOptions.businessId, businessId),
            ),
          );

        if (variantOption.length === 0) {
          throw new NotFoundError(
            `Variant option ${option.optionId} does not exist`,
          );
        }
      }
    }

    // ==========================================================
    // OPENING STOCK VALIDATION
    // ==========================================================

    if (data.source === "opening") {
      if (variant.quantity < 0) {
        throw new NotFoundError("Opening quantity cannot be negative");
      }

      // NONE
      if (data.trackingType === "none") {
        if (variant.serialNumbers?.length) {
          throw new NotFoundError(
            "Serial numbers are not allowed for non-serial products",
          );
        }
      }

      // BATCH
      if (data.trackingType === "batch") {
        if (!variant.batchNumber) {
          throw new NotFoundError(
            "Batch number is required for batch-tracked products",
          );
        }

        if (variant.serialNumbers?.length) {
          throw new NotFoundError(
            "Serial numbers are not allowed for batch-tracked products",
          );
        }
      }

      // SERIAL
      if (data.trackingType === "serial") {
        if (!variant.serialNumbers) {
          throw new NotFoundError("Serial numbers are required");
        }

        if (variant.serialNumbers.length !== variant.quantity) {
          throw new NotFoundError(
            "Number of serial numbers must equal opening quantity",
          );
        }

        // Check duplicate serial numbers inside request
        const serials = variant.serialNumbers.map((item) => item.serial);

        const uniqueSerials = new Set(serials);

        if (uniqueSerials.size !== serials.length) {
          throw new NotFoundError("Duplicate serial numbers are not allowed");
        }
      }
    }
  }
}
async function insertProduct(tx: Tx, businessId: number, data: ProductType) {
  const [productResult] = await tx
    .insert(products)
    .values({
      businessId,
      name: data.name,
      categoryId: data.categoryId,
      brandId: data.brandId,
      unitId: data.unitId,
      description: data.description,
      productType: data.productType,
      hasVariants: data.hasVariants,
      trackingType: data.trackingType,
      status: data.status,
      // Shipping & packaging defaults (copied into sale packages at pack
      // time — editing these never rewrites processed orders).
      shippingWeightKg: data.shippingWeightKg ?? null,
      shippingLengthCm: data.shippingLengthCm ?? null,
      shippingWidthCm: data.shippingWidthCm ?? null,
      shippingHeightCm: data.shippingHeightCm ?? null,
      packagingInstructions: data.packagingInstructions ?? null,
      handlingInstructions: data.handlingInstructions ?? null,
      isFragile: data.isFragile ?? false,
    })
    .returning({ id: products.id });
  if (!productResult) {
    throw new NotFoundError("Product could not be created");
  }
  return productResult;
}
async function insertVariant(
  tx: Tx,
  businessId: number,
  productId: number,
  variant: VariantType,
  sku: string,
) {
  const barcode = variant.barcode?.trim() || null;
  const [variantResult] = await tx
    .insert(productVariants)
    .values({
      businessId,
      productId,
      sku,
      barcode,
      // Symbology recorded for label printing / validation (0044); NULL for
      // legacy free-form codes the detector cannot classify.
      barcodeFormat: barcode ? detectBarcodeFormat(barcode) : null,
      sellingPrice: variant.sellingPrice,
      // Phase 4 (Feature 10): weight-selling flag (schema passthrough).
      soldByWeight: (variant as { soldByWeight?: boolean }).soldByWeight ?? false,
      alertQuantity: variant.alertQuantity,
      isDefault: variant.isDefault,
      status: variant.status,
      weight: variant.weight ?? null,
      weightUnit: variant.weightUnit ?? null,
    })
    .returning({ id: productVariants.id });
  if (!variantResult) {
    throw new NotFoundError("variant could not be created");
  }
  if (barcode) {
    await recordAuditInTx(tx, {
      businessId,
      actorUserId: null,
      action: "barcode.assigned",
      entityType: "variant",
      entityId: variantResult.id,
      metadata: {
        barcode,
        format: detectBarcodeFormat(barcode),
        target: "primary",
        via: "product_create",
      },
    });
  }
  return variantResult;
}
async function insertVariantOptions(
  tx: Tx,
  businessId: number,
  data: ProductType,
  variant: VariantType,
  variantId: number,
) {
  if (data.hasVariants) {
    if (!variant.options) {
      throw new NotFoundError("Variant options are required");
    }
    for (const option of variant.options) {
      await tx.insert(variantValues).values({
        businessId,
        variantId,
        optionId: option.optionId,
      });
    }
  }
}
async function insertBatch(
  tx: Tx,
  businessId: number,
  locationId: number,
  variant: VariantType,
  variantId: number,
) {
  const [batchResult] = await tx
    .insert(inventoryBatches)
    .values({
      businessId,
      variantId,
      locationId,
      purchaseItemId: null,
      batchNumber: variant.batchNumber ?? null,
      purchasePrice: variant.purchasePrice,
      quantityReceived: variant.quantity,
      quantityRemaining: variant.quantity,
      expiryDate: variant.expiryDate,
    })
    .returning({ id: inventoryBatches.id });
  if (!batchResult) {
    throw new NotFoundError("Batch could not be created");
  }
  return batchResult;
}
async function insertSerialNumber(
  tx: Tx,
  businessId: number,
  locationId: number,
  variant: VariantType,
  variantId: number,
  batchId: number,
) {
  if (!variant.serialNumbers) {
    throw new NotFoundError("Serial numbers are required");
  }
  for (const serialNumber of variant.serialNumbers) {
    await tx.insert(serialNumbers).values({
      businessId,
      locationId,
      variantId,
      serialNumber: serialNumber.serial,
      batchId,
    });
  }
}
async function insertInventoryStock(
  tx: Tx,
  businessId: number,
  locationId: number,
  variantId: number,
  quantity: number,
) {
  await tx.insert(inventoryStock).values({
    businessId,
    locationId,
    variantId,
    quantity,
  });
}
export async function generateSku(tx: Tx, businessId: number) {
  // Per-business SKU counter (document_sequences) replaces the global
  // product_sku_seq sequence. Rollback-safe: shares the caller's transaction.
  const number = await nextDocumentNumber(tx, businessId, "product_sku");
  return formatProductSku(number);
}
export async function createProduct(
  businessId: number,
  locationId: number,
  data: ProductType,
) {
  try {
    // Propagate the transaction result so the API response can carry the new
    // product's id (the controller exposes it as data.productId).
    return await db.transaction(async (tx) => {
      // Plan limit: active products vs the subscription plan's maxProducts,
      // checked inside the insert transaction (advisory-locked).
      await assertWithinProductLimit(businessId, tx);
      await validateProductReferences(tx, businessId, data);

      validateProductRules(data);

      await validateVariantRulesAndRef(tx, businessId, data);

      const product = await insertProduct(tx, businessId, data);

      for (const variant of data.variants) {
        const sku = variant.sku?.trim() || (await generateSku(tx, businessId));
        const createdVariant = await insertVariant(
          tx,
          businessId,
          product.id,
          variant,
          sku,
        );

        await insertVariantOptions(
          tx,
          businessId,
          data,
          variant,
          createdVariant.id,
        );
        await insertInventoryStock(
          tx,
          businessId,
          locationId,
          createdVariant.id,
          variant.quantity,
        );
        if (data.source === "opening") {
          const batch = await insertBatch(tx, businessId, locationId, variant, createdVariant.id);
          if (data.trackingType === "serial") {
            await insertSerialNumber(
              tx,
              businessId,
              locationId,
              variant,
              createdVariant.id,
              batch.id,
            );
          }
        }
      }
      return { productId: product.id };
    });
  } catch (err) {
    console.error(err);
    throw mapVariantUniqueViolation(err);
  }
}

/** PG 23505 on the per-business SKU/barcode indexes → a human 409. */
export function mapVariantUniqueViolation(err: unknown): unknown {
  const code = (err as { code?: string }).code;
  const constraint = (err as { constraint?: string }).constraint ?? "";
  if (code === "23505") {
    if (constraint.includes("barcode")) {
      return new ConflictError(
        "This barcode is already used by another product in your business.",
      );
    }
    if (constraint.includes("sku")) {
      return new ConflictError(
        "This SKU is already used by another product in your business.",
      );
    }
  }
  return err;
}
export async function getProductForEdit(businessId: number, id: number) {
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, id), eq(products.businessId, businessId)));
  if (!product) {
    throw new NotFoundError("Product not found");
  }

  const variants = await db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      sellingPrice: productVariants.sellingPrice,
      alertQuantity: productVariants.alertQuantity,
      isDefault: productVariants.isDefault,
      status: productVariants.status,
      weight: productVariants.weight,
      weightUnit: productVariants.weightUnit,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, id),
        eq(productVariants.businessId, businessId),
      ),
    );

  const optionRows =
    variants.length === 0
      ? []
      : await db
          .select({
            variantId: variantValues.variantId,
            typeId: variantTypes.id,
            typeName: variantTypes.name,
            optionId: variantOptions.id,
            value: variantOptions.value,
          })
          .from(variantValues)
          .innerJoin(
            variantOptions,
            eq(variantOptions.id, variantValues.optionId),
          )
          .innerJoin(
            variantTypes,
            eq(variantTypes.id, variantOptions.variantTypeId),
          )
          .where(
            and(
              eq(variantValues.businessId, businessId),
              inArray(
                variantValues.variantId,
                variants.map((variant) => variant.id),
              ),
            ),
          );
  const optionsByVariant = new Map<number, typeof optionRows>();
  for (const option of optionRows) {
    const options = optionsByVariant.get(option.variantId) ?? [];
    options.push(option);
    optionsByVariant.set(option.variantId, options);
  }

  // Phase 7 (edit UX): read-only inventory summary — batches/expiry/serials
  // are immutable from the form but must at least be VISIBLE. Stock itself
  // stays out of the form (stock adjustment / counts own it).
  const inventoryByVariant = new Map<
    number,
    {
      totalStock: number;
      batches: { batchNumber: string; expiryDate: string | null; quantityRemaining: number }[];
      serialCount: number;
    }
  >();
  if (variants.length > 0) {
    const variantIds = variants.map((variant) => variant.id);
    const [batchRows, serialRows] = await Promise.all([
      db
        .select({
          variantId: inventoryBatches.variantId,
          batchNumber: inventoryBatches.batchNumber,
          expiryDate: inventoryBatches.expiryDate,
          quantityRemaining: inventoryBatches.quantityRemaining,
        })
        .from(inventoryBatches)
        .where(
          and(
            eq(inventoryBatches.businessId, businessId),
            inArray(inventoryBatches.variantId, variantIds),
            gt(inventoryBatches.quantityRemaining, 0),
          ),
        )
        .orderBy(asc(inventoryBatches.id)),
      db
        .select({
          variantId: serialNumbers.variantId,
          count: sql<number>`count(*)::int`,
        })
        .from(serialNumbers)
        .where(
          and(
            eq(serialNumbers.businessId, businessId),
            eq(serialNumbers.status, "in_stock"),
            inArray(serialNumbers.variantId, variantIds),
          ),
        )
        .groupBy(serialNumbers.variantId),
    ]);
    const serialCountByVariant = new Map(
      serialRows.map((row) => [row.variantId, Number(row.count)]),
    );
    for (const variant of variants) {
      const batches = batchRows.filter((row) => row.variantId === variant.id);
      inventoryByVariant.set(variant.id, {
        totalStock: batches.reduce((sum, b) => sum + Number(b.quantityRemaining), 0),
        batches: batches.map((b) => ({
          batchNumber: b.batchNumber,
          expiryDate: b.expiryDate ? b.expiryDate.toISOString().slice(0, 10) : null,
          quantityRemaining: Number(b.quantityRemaining),
        })),
        serialCount: serialCountByVariant.get(variant.id) ?? 0,
      });
    }
  }

  return {
    name: product.name,
    categoryId: product.categoryId,
    brandId: product.brandId,
    unitId: product.unitId,
    description: product.description ?? "",
    productType: product.productType ?? "physical",
    hasVariants: product.hasVariants ?? false,
    trackingType: product.trackingType ?? "none",
    supplierId: null,
    status: product.status ?? "active",
    imageUrl: null,
    imageFile: null,
    source: "purchase",
    variants: variants.map((variant) => ({
      ...variant,
      options: (optionsByVariant.get(variant.id) ?? []).map(
        ({ typeId, typeName, optionId, value }) => ({
          typeId,
          typeName,
          optionId,
          value,
        }),
      ),
      barcode: variant.barcode ?? "",
      weight: variant.weight === null || variant.weight === undefined ? null : Number(variant.weight),
      weightUnit: variant.weightUnit ?? null,
      alertQuantity: variant.alertQuantity ?? 0,
      status: variant.status ?? "active",
      imageUrl: null,
      imageFile: null,
      batchNumber: "",
      purchasePrice: 0,
      quantity: 0,
      expiryDate: null,
      serialNumbers: [],
      inventory: inventoryByVariant.get(variant.id) ?? {
        totalStock: 0,
        batches: [],
        serialCount: 0,
      },
    })),
  };
}
export async function updateProduct(
  businessId: number,
  locationId: number,
  id: number,
  data: ProductType,
) {
  return db.transaction(async (tx) => {
    const [existingProduct] = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, id), eq(products.businessId, businessId)));
    if (!existingProduct) {
      throw new NotFoundError("Product not found");
    }

    await validateProductReferences(tx, businessId, data);
    validateProductRules(data);
    await validateVariantRulesAndRef(tx, businessId, data);

    const existingVariants = await tx
      .select({
        id: productVariants.id,
        barcode: productVariants.barcode,
        barcodeFormat: productVariants.barcodeFormat,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.productId, id),
          eq(productVariants.businessId, businessId),
        ),
      );
    const existingVariantIds = new Set(
      existingVariants.map((variant) => variant.id),
    );
    const submittedExistingIds = data.variants.flatMap((variant) =>
      variant.id === undefined ? [] : [variant.id],
    );
    if (
      new Set(submittedExistingIds).size !== submittedExistingIds.length ||
      submittedExistingIds.length !== existingVariants.length ||
      submittedExistingIds.some((variantId) => !existingVariantIds.has(variantId))
    ) {
      throw new BadRequestError(
        "Existing variants cannot be removed while editing. Stock and variant history are preserved.",
      );
    }

    const newVariants = data.variants.filter(
      (variant) => variant.id === undefined,
    );
    if (!data.hasVariants && newVariants.length > 0) {
      throw new BadRequestError(
        "New variants can only be added to products that already have variants.",
      );
    }
    if (newVariants.length > 0 && data.source !== "purchase") {
      throw new BadRequestError(
        "New variants must be created with zero stock and received through a purchase or stock adjustment.",
      );
    }
    if (
      newVariants.some(
        (variant) =>
          variant.quantity !== 0 || (variant.serialNumbers?.length ?? 0) > 0,
      )
    ) {
      throw new BadRequestError(
        "New variants must start with zero stock. Receive stock through a purchase or stock adjustment.",
      );
    }

    const submittedCombinationKeys = new Set<string>();
    for (const variant of data.variants) {
      const optionIds = variant.options?.map((option) => option.optionId) ?? [];
      const combinationKey = [...optionIds].sort((a, b) => a - b).join(",");
      if (data.hasVariants && submittedCombinationKeys.has(combinationKey)) {
        throw new BadRequestError(
          "Each variant must have a unique combination of options.",
        );
      }
      submittedCombinationKeys.add(combinationKey);
    }

    const existingOptionRows =
      existingVariantIds.size === 0
        ? []
        : await tx
            .select({
              variantId: variantValues.variantId,
              optionId: variantValues.optionId,
            })
            .from(variantValues)
            .where(
              and(
                eq(variantValues.businessId, businessId),
                inArray(variantValues.variantId, [...existingVariantIds]),
              ),
            );
    const existingOptionsByVariant = new Map<number, number[]>();
    for (const row of existingOptionRows) {
      const optionIds = existingOptionsByVariant.get(row.variantId) ?? [];
      optionIds.push(row.optionId);
      existingOptionsByVariant.set(row.variantId, optionIds);
    }
    for (const variant of data.variants) {
      if (variant.id === undefined) continue;
      const existingOptions = [
        ...(existingOptionsByVariant.get(variant.id) ?? []),
      ].sort((a, b) => a - b);
      const submittedOptions = (variant.options ?? [])
        .map((option) => option.optionId)
        .sort((a, b) => a - b);
      if (
        existingOptions.length !== submittedOptions.length ||
        existingOptions.some(
          (optionId, index) => optionId !== submittedOptions[index],
        )
      ) {
        throw new BadRequestError(
          "Existing variant options cannot be changed. Add a new variant instead.",
        );
      }
    }

    await tx
      .update(products)
      .set({
        name: data.name,
        categoryId: data.categoryId,
        brandId: data.brandId,
        unitId: data.unitId,
        description: data.description,
        productType: data.productType,
        hasVariants: data.hasVariants,
        trackingType: data.trackingType,
        status: data.status,
        shippingWeightKg: data.shippingWeightKg ?? null,
        shippingLengthCm: data.shippingLengthCm ?? null,
        shippingWidthCm: data.shippingWidthCm ?? null,
        shippingHeightCm: data.shippingHeightCm ?? null,
        packagingInstructions: data.packagingInstructions ?? null,
        handlingInstructions: data.handlingInstructions ?? null,
        isFragile: data.isFragile ?? false,
      })
      .where(and(eq(products.id, id), eq(products.businessId, businessId)));

    const addedVariants: { id: number; sku: string }[] = [];
    for (const variant of data.variants) {
      const variantId = variant.id;
      if (variantId === undefined) {
        const sku = variant.sku.trim() || (await generateSku(tx, businessId));
        const createdVariant = await insertVariant(
          tx,
          businessId,
          id,
          variant,
          sku,
        );
        await insertVariantOptions(tx, businessId, data, variant, createdVariant.id);
        await insertInventoryStock(tx, businessId, locationId, createdVariant.id, 0);
        addedVariants.push({ id: createdVariant.id, sku });
        continue;
      }

      const nextBarcode = variant.barcode?.trim() || null;
      const previous = existingVariants.find((row) => row.id === variantId);
      await tx
        .update(productVariants)
        .set({
          sku: variant.sku.trim() || (await generateSku(tx, businessId)),
          barcode: nextBarcode,
          barcodeFormat: nextBarcode ? detectBarcodeFormat(nextBarcode) : null,
          sellingPrice: variant.sellingPrice,
          alertQuantity: variant.alertQuantity,
          isDefault: variant.isDefault,
          status: variant.status,
          // Explicit update semantics (Phase 4): an omitted weight must NOT
          // erase the stored value — only a provided value updates it.
          ...(variant.weight !== undefined
            ? { weight: variant.weight }
            : {}),
          ...(variant.weightUnit !== undefined
            ? { weightUnit: variant.weightUnit }
            : {}),
        })
        .where(
          and(
            eq(productVariants.id, variantId),
            eq(productVariants.productId, id),
            eq(productVariants.businessId, businessId),
          ),
        );
      // Barcode history: the old code is archived before it disappears —
      // the master prompt requires traceable barcode changes.
      if (
        previous &&
        (previous.barcode ?? null) !== nextBarcode &&
        (previous.barcode !== null || nextBarcode !== null)
      ) {
        await recordAuditInTx(tx, {
          businessId,
          actorUserId: null,
          action: nextBarcode === null ? "barcode.removed" : "barcode.changed",
          entityType: "variant",
          entityId: variantId,
          metadata: {
            oldBarcode: previous.barcode,
            oldFormat: previous.barcodeFormat,
            newBarcode: nextBarcode,
            newFormat: nextBarcode ? detectBarcodeFormat(nextBarcode) : null,
            via: "product_edit",
          },
        });
      }

      await tx
        .delete(variantValues)
        .where(
          and(
            eq(variantValues.variantId, variantId),
            eq(variantValues.businessId, businessId),
          ),
        );
      if (data.hasVariants && variant.options?.length) {
        await tx.insert(variantValues).values(
          variant.options.map((option) => ({
            businessId,
            variantId,
            optionId: option.optionId,
          })),
        );
      }
    }

    return { productId: id, addedVariants };
  }).catch((err: unknown) => {
    throw mapVariantUniqueViolation(err);
  });
}
export async function createCategory(
  businessId: number,
  data: AddCategorySchemaType,
) {
  // categories.parentId is a plain self-FK, so the parent's ownership must be
  // verified here — otherwise a category could be nested under another
  // business's category. Same rule updateCategory enforces for ancestors.
  if (data.parentCategoryId !== null && data.parentCategoryId !== undefined) {
    const [parent] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.id, data.parentCategoryId),
          eq(categories.businessId, businessId),
        ),
      )
      .limit(1);
    if (!parent) {
      throw new NotFoundError("Parent category does not exist");
    }
  }
  const [category] = await db
    .insert(categories)
    .values({
      businessId,
      name: data.categoryName,
      description: data.description,
      status: data.status,
      parentId: data.parentCategoryId,
    })
    .returning({
      value: categories.id,
      label: categories.name,
      parentCategoryId: categories.parentId,
      description: categories.description,
      status: sql<string>`COALESCE(${categories.status}, 'active')`,
      productCount: sql<number>`0`,
    });
  return category;
}
export async function createBrand(businessId: number, data: BrandSchemaType) {
  const [brand] = await db
    .insert(brands)
    .values({
      businessId,
      name: data.brandName,
      status: data.status,
    })
    .returning({
      value: brands.id,
      label: brands.name,
      status: sql<string>`COALESCE(${brands.status}, 'active')`,
      productCount: sql<number>`0`,
    });
  return brand;
}
export async function createUnit(businessId: number, data: UnitSchemaType) {
  const [unit] = await db
    .insert(units)
    .values({
      businessId,
      name: data.unitName,
      abbreviation: data.abbreviation,
    })
    .returning({
      value: units.id,
      label: units.name,
      abbreviation: units.abbreviation,
      productCount: sql<number>`0`,
    });
  return unit;
}
export async function createVariantType(
  businessId: number,
  data: VariantTypeSchemaType,
) {
  const [variantType] = await db
    .insert(variantTypes)
    .values({
      businessId,
      name: data.variantTypeName,
    })
    .returning();
  return variantType;
}
export async function createVariantOption(
  businessId: number,
  data: VariantOptionSchemaType,
) {
  if (data.variantOptionName.length === 0) {
    throw new NotFoundError("Please add at least one variant option");
  }
  // The parent type is validated to belong to the same business.
  const [variantType] = await db
    .select({ id: variantTypes.id })
    .from(variantTypes)
    .where(
      and(
        eq(variantTypes.id, data.variantTypeId),
        eq(variantTypes.businessId, businessId),
      ),
    );
  if (!variantType) {
    throw new NotFoundError("Variant type does not exist");
  }
  const optionsToInsert = data.variantOptionName.map((optionName) => ({
    businessId,
    variantTypeId: data.variantTypeId,
    value: optionName,
  }));
  const insertedOptions = await db
    .insert(variantOptions)
    .values(optionsToInsert)
    .returning();
  return insertedOptions;
}

export async function updateCategory(
  businessId: number,
  id: number,
  data: AddCategorySchemaType,
) {
  if (data.parentCategoryId === id) {
    throw new BadRequestError("A category cannot be its own parent");
  }
  let parentId = data.parentCategoryId;
  while (parentId !== null) {
    if (parentId === id) {
      throw new BadRequestError("A category cannot be moved under its child");
    }
    const [parent] = await db
      .select({ parentId: categories.parentId })
      .from(categories)
      .where(
        and(
          eq(categories.id, parentId),
          eq(categories.businessId, businessId),
        ),
      )
      .limit(1);
    if (!parent) {
      throw new NotFoundError("Parent category does not exist");
    }
    parentId = parent.parentId;
  }
  const [category] = await db
    .update(categories)
    .set({
      name: data.categoryName,
      description: data.description,
      status: data.status,
      parentId: data.parentCategoryId,
    })
    .where(and(eq(categories.id, id), eq(categories.businessId, businessId)))
    .returning({
      value: categories.id,
      label: categories.name,
      parentCategoryId: categories.parentId,
      description: categories.description,
      status: sql<string>`COALESCE(${categories.status}, 'active')`,
      productCount: sql<number>`(SELECT COUNT(*)::int FROM products WHERE category_id = ${categories.id} AND business_id = ${businessId})`,
    });
  if (!category) {
    throw new NotFoundError("Category does not exist");
  }
  return category;
}

export async function deleteCategory(businessId: number, id: number) {
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(eq(products.categoryId, id), eq(products.businessId, businessId)),
    )
    .limit(1);
  if (product) {
    throw new ConflictError("Move or remove products in this category first");
  }
  const [child] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(eq(categories.parentId, id), eq(categories.businessId, businessId)),
    )
    .limit(1);
  if (child) {
    throw new ConflictError("Move or remove subcategories first");
  }
  const [category] = await db
    .delete(categories)
    .where(and(eq(categories.id, id), eq(categories.businessId, businessId)))
    .returning({ id: categories.id });
  if (!category) {
    throw new NotFoundError("Category does not exist");
  }
}

export async function updateBrand(
  businessId: number,
  id: number,
  data: BrandSchemaType,
) {
  const [brand] = await db
    .update(brands)
    .set({ name: data.brandName, status: data.status })
    .where(and(eq(brands.id, id), eq(brands.businessId, businessId)))
    .returning({
      value: brands.id,
      label: brands.name,
      status: sql<string>`COALESCE(${brands.status}, 'active')`,
      productCount: sql<number>`(SELECT COUNT(*)::int FROM products WHERE brand_id = ${brands.id} AND business_id = ${businessId})`,
    });
  if (!brand) {
    throw new NotFoundError("Brand does not exist");
  }
  return brand;
}

export async function deleteBrand(businessId: number, id: number) {
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.brandId, id), eq(products.businessId, businessId)))
    .limit(1);
  if (product) {
    throw new ConflictError("Remove this brand from its products first");
  }
  const [brand] = await db
    .delete(brands)
    .where(and(eq(brands.id, id), eq(brands.businessId, businessId)))
    .returning({ id: brands.id });
  if (!brand) {
    throw new NotFoundError("Brand does not exist");
  }
}

export async function updateUnit(
  businessId: number,
  id: number,
  data: UnitSchemaType,
) {
  const [unit] = await db
    .update(units)
    .set({ name: data.unitName, abbreviation: data.abbreviation })
    .where(and(eq(units.id, id), eq(units.businessId, businessId)))
    .returning({
      value: units.id,
      label: units.name,
      abbreviation: units.abbreviation,
      productCount: sql<number>`(SELECT COUNT(*)::int FROM products WHERE unit_id = ${units.id} AND business_id = ${businessId})`,
    });
  if (!unit) {
    throw new NotFoundError("Unit does not exist");
  }
  return unit;
}

export async function deleteUnit(businessId: number, id: number) {
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.unitId, id), eq(products.businessId, businessId)))
    .limit(1);
  if (product) {
    throw new ConflictError("Move or update products using this unit first");
  }
  // UOM (migration 0061): a unit cannot be deleted while any packaging
  // configuration still references it.
  await assertUnitNotUsedByConversions(businessId, id);
  const [unit] = await db
    .delete(units)
    .where(and(eq(units.id, id), eq(units.businessId, businessId)))
    .returning({ id: units.id });
  if (!unit) {
    throw new NotFoundError("Unit does not exist");
  }
}

export async function updateVariantType(
  businessId: number,
  id: number,
  data: VariantTypeSchemaType,
) {
  const [variantType] = await db
    .update(variantTypes)
    .set({ name: data.variantTypeName })
    .where(and(eq(variantTypes.id, id), eq(variantTypes.businessId, businessId)))
    .returning();
  if (!variantType) {
    throw new NotFoundError("Variant type does not exist");
  }
  return variantType;
}

export async function deleteVariantType(businessId: number, id: number) {
  await db.transaction(async (tx) => {
    const [variantType] = await tx
      .select({ id: variantTypes.id })
      .from(variantTypes)
      .where(
        and(eq(variantTypes.id, id), eq(variantTypes.businessId, businessId)),
      )
      .limit(1);
    if (!variantType) {
      throw new NotFoundError("Variant type does not exist");
    }

    const options = await tx
      .select({ id: variantOptions.id })
      .from(variantOptions)
      .where(
        and(
          eq(variantOptions.variantTypeId, id),
          eq(variantOptions.businessId, businessId),
        ),
      );
    const optionIds = options.map((option) => option.id);

    if (optionIds.length > 0) {
      const [usage] = await tx
        .select({ variantId: variantValues.variantId })
        .from(variantValues)
        .where(
          and(
            eq(variantValues.businessId, businessId),
            inArray(variantValues.optionId, optionIds),
          ),
        )
        .limit(1);
      if (usage) {
        throw new ConflictError(
          "Remove this variant type's options from product variants before deleting the type",
        );
      }

      await tx
        .delete(variantOptions)
        .where(
          and(
            eq(variantOptions.variantTypeId, id),
            eq(variantOptions.businessId, businessId),
          ),
        );
    }

    await tx
      .delete(variantTypes)
      .where(
        and(eq(variantTypes.id, id), eq(variantTypes.businessId, businessId)),
      );
  });
}

export async function updateVariantOption(
  businessId: number,
  id: number,
  data: { value: string },
) {
  const [option] = await db
    .update(variantOptions)
    .set({ value: data.value })
    .where(and(eq(variantOptions.id, id), eq(variantOptions.businessId, businessId)))
    .returning();
  if (!option) {
    throw new NotFoundError("Variant option does not exist");
  }
  return option;
}

export async function deleteVariantOption(businessId: number, id: number) {
  const [usage] = await db
    .select({ variantId: variantValues.variantId })
    .from(variantValues)
    .where(
      and(
        eq(variantValues.optionId, id),
        eq(variantValues.businessId, businessId),
      ),
    )
    .limit(1);
  if (usage) {
    throw new ConflictError(
      "This option is used by product variants and cannot be deleted",
    );
  }
  const [option] = await db
    .delete(variantOptions)
    .where(and(eq(variantOptions.id, id), eq(variantOptions.businessId, businessId)))
    .returning({ id: variantOptions.id });
  if (!option) {
    throw new NotFoundError("Variant option does not exist");
  }
}
