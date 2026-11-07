import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  sql,
} from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { products } from "../../db/schema/products.js";
import type { ProductsTypes } from "../../types/product-types.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { variantTypes } from "../../db/schema/variantTypes.js";
import { variantOptions } from "../../db/schema/variantOptions.js";
import { variantValues } from "../../db/schema/variantValues.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import { categories } from "../../db/schema/categories.js";
import { brands } from "../../db/schema/brands.js";
import { units } from "../../db/schema/units.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { buildVariantNameFromLabel } from "../../utils/variantDisplay.js";

// Every function takes the caller's server-verified businessId (from
// requireBusinessContext) and scopes all reads and writes to it.

type StockAdjustment = {
  newQuantity: number;
  reason: "count_correction" | "damaged" | "expired" | "lost" | "found";
  batchNumber?: string | undefined;
  unitCost?: number | undefined;
  serialNumbers?: string[] | undefined;
};

export async function adjustVariantStock(
  businessId: number,
  locationId: number,
  variantId: number,
  adjustment: StockAdjustment,
) {
  return db.transaction(async (tx) => {
    const [variant] = await tx
      .select({
        id: productVariants.id,
        productName: products.name,
        trackingType: products.trackingType,
        variantOptions: sql<string | null>`(
          SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
          FROM variant_values vv
          JOIN variant_options vo ON vo.id = vv.option_id
          WHERE vv.variant_id = ${productVariants.id}
        )`,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(productVariants.id, variantId),
          eq(products.businessId, businessId),
        ),
      )
      .for("update");

    if (!variant) {
      throw new NotFoundError("Product variant not found.");
    }

    // Adjustments are location-scoped: the caller's verified location.
    const [stock] = await tx
      .select()
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.variantId, variantId),
          eq(inventoryStock.businessId, businessId),
          eq(inventoryStock.locationId, locationId),
        ),
      )
      .for("update");

    if (!stock) {
      throw new NotFoundError("Inventory record not found for this variant.");
    }

    const previousQuantity = stock.quantity ?? 0;
    const change = adjustment.newQuantity - previousQuantity;
    if (change === 0) {
      return {
        variantId,
        productName: buildVariantNameFromLabel(variant.productName, variant.variantOptions),
        previousQuantity,
        quantity: previousQuantity,
        change,
      };
    }
    if (
      change > 0 &&
      ["damaged", "expired", "lost"].includes(adjustment.reason)
    ) {
      throw new BadRequestError(
        "Use Found stock or Stock count correction when increasing stock.",
      );
    }
    if (change < 0 && adjustment.reason === "found") {
      throw new BadRequestError(
        "Found stock can only be used when increasing stock.",
      );
    }

    const trackingType = variant.trackingType ?? "none";
    const serialList = adjustment.serialNumbers ?? [];
    if (trackingType !== "serial" && serialList.length > 0) {
      throw new BadRequestError(
        "Serial numbers can only be adjusted for serial-tracked products.",
      );
    }
    if (
      trackingType === "serial" &&
      serialList.length !== Math.abs(change)
    ) {
      throw new BadRequestError(
        `Provide exactly ${Math.abs(change)} serial number(s) for this adjustment.`,
      );
    }
    if (new Set(serialList).size !== serialList.length) {
      throw new BadRequestError("Serial numbers must be unique.");
    }
    if (
      change > 0 &&
      trackingType === "batch" &&
      !adjustment.batchNumber?.trim()
    ) {
      throw new BadRequestError(
        "A batch number is required when adding stock to a batch-tracked product.",
      );
    }

    // Explicit columns: keeps FIFO stable regardless of new batch columns
    // (landed cost) added to the schema.
    const batches = await tx
      .select({
      id: inventoryBatches.id,
      businessId: inventoryBatches.businessId,
      variantId: inventoryBatches.variantId,
      locationId: inventoryBatches.locationId,
      purchaseItemId: inventoryBatches.purchaseItemId,
      batchNumber: inventoryBatches.batchNumber,
      purchasePrice: inventoryBatches.purchasePrice,
      quantityReceived: inventoryBatches.quantityReceived,
      quantityRemaining: inventoryBatches.quantityRemaining,
      manufacturedDate: inventoryBatches.manufacturedDate,
      expiryDate: inventoryBatches.expiryDate,
    })
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.variantId, variantId),
          eq(inventoryBatches.businessId, businessId),
          gt(inventoryBatches.quantityRemaining, 0),
        ),
      )
      .orderBy(asc(inventoryBatches.id))
      .for("update");

    if (change < 0 && trackingType === "serial") {
      const selectedSerials = await tx
        .select({
          id: serialNumbers.id,
          serialNumber: serialNumbers.serialNumber,
          batchId: serialNumbers.batchId,
        })
        .from(serialNumbers)
        .where(
          and(
            eq(serialNumbers.variantId, variantId),
            eq(serialNumbers.businessId, businessId),
            eq(serialNumbers.status, "in_stock"),
            inArray(serialNumbers.serialNumber, serialList),
          ),
        )
        .for("update");

      if (selectedSerials.length !== serialList.length) {
        throw new BadRequestError(
          "Every serial number to remove must belong to this variant and be in stock.",
        );
      }

      const nextSerialStatus =
        adjustment.reason === "damaged" || adjustment.reason === "expired"
          ? "damaged"
          : "lost";
      await tx
        .update(serialNumbers)
        .set({ status: nextSerialStatus })
        .where(
          inArray(
            serialNumbers.id,
            selectedSerials.map((serial) => serial.id),
          ),
        );

      const quantitiesByBatch = new Map<number, number>();
      for (const serial of selectedSerials) {
        if (serial.batchId !== null) {
          quantitiesByBatch.set(
            serial.batchId,
            (quantitiesByBatch.get(serial.batchId) ?? 0) + 1,
          );
        }
      }
      for (const [batchId, quantity] of quantitiesByBatch) {
        const batch = batches.find((item) => item.id === batchId);
        if (!batch || batch.quantityRemaining < quantity) {
          throw new BadRequestError(
            "Serial inventory does not match its batch stock. Reconcile the batch before adjusting.",
          );
        }
        await tx
          .update(inventoryBatches)
          .set({ quantityRemaining: batch.quantityRemaining - quantity })
          .where(
            and(
              eq(inventoryBatches.id, batchId),
              eq(inventoryBatches.businessId, businessId),
            ),
          );
      }
    } else if (change < 0) {
      let remaining = Math.abs(change);
      for (const batch of batches) {
        if (remaining === 0) break;
        const take = Math.min(batch.quantityRemaining, remaining);
        await tx
          .update(inventoryBatches)
          .set({ quantityRemaining: batch.quantityRemaining - take })
          .where(
            and(
              eq(inventoryBatches.id, batch.id),
              eq(inventoryBatches.businessId, businessId),
            ),
          );
        remaining -= take;
      }
      if (remaining > 0) {
        throw new BadRequestError(
          "Not enough batch stock is available to fulfill this adjustment.",
        );
      }
    } else {
      let batchNumber =
        adjustment.batchNumber?.trim() ||
        `ADJ-${Date.now()}-${variantId}`;
      if (batchNumber.length > 100) {
        throw new BadRequestError("Batch number must be 100 characters or fewer.");
      }

      const currentCostValue = batches.reduce(
        (total, batch) =>
          total + batch.purchasePrice * batch.quantityRemaining,
        0,
      );
      const currentBatchQuantity = batches.reduce(
        (total, batch) => total + batch.quantityRemaining,
        0,
      );
      const currentAverageCost =
        currentBatchQuantity > 0
          ? currentCostValue / currentBatchQuantity
          : 0;
      const [createdBatch] = await tx
        .insert(inventoryBatches)
        .values({
          businessId,
          variantId,
          locationId: stock.locationId,
          batchNumber,
          purchasePrice: adjustment.unitCost ?? currentAverageCost,
          quantityReceived: change,
          quantityRemaining: change,
        })
        .returning({ id: inventoryBatches.id });

      if (!createdBatch) {
        throw new Error("Could not create an inventory batch for the adjustment.");
      }

      if (trackingType === "serial") {
        const existingSerials = await tx
          .select({
            id: serialNumbers.id,
            variantId: serialNumbers.variantId,
            status: serialNumbers.status,
            serialNumber: serialNumbers.serialNumber,
          })
          .from(serialNumbers)
          .where(
            and(
              eq(serialNumbers.businessId, businessId),
              inArray(serialNumbers.serialNumber, serialList),
            ),
          )
          .for("update");

        if (existingSerials.length > 0) {
          if (adjustment.reason !== "found") {
            throw new ConflictError(
              "These serial numbers already exist. Use the Found stock reason to restore lost or damaged serials.",
            );
          }
          const restorableSerials = existingSerials.filter(
            (serial) =>
              serial.variantId === variantId &&
              (serial.status === "lost" || serial.status === "damaged"),
          );
          if (restorableSerials.length !== existingSerials.length) {
            throw new ConflictError(
              "Existing serial numbers must belong to this variant and be marked lost or damaged before they can be restored.",
            );
          }
          await tx
            .update(serialNumbers)
            .set({ status: "in_stock", batchId: createdBatch.id })
            .where(
              inArray(
                serialNumbers.id,
                restorableSerials.map((serial) => serial.id),
              ),
            );
        }

        const existingValues = new Set(
          existingSerials.map((serial) => serial.serialNumber),
        );
        const newSerials = serialList.filter(
          (serial) => !existingValues.has(serial),
        );
        if (newSerials.length > 0) {
          await tx.insert(serialNumbers).values(
            newSerials.map((serialNumber) => ({
              businessId,
              variantId,
              batchId: createdBatch.id,
              serialNumber,
            })),
          );
        }
      }
    }

    const [updatedStock] = await tx
      .update(inventoryStock)
      .set({ quantity: adjustment.newQuantity })
      .where(
        and(
          eq(inventoryStock.variantId, variantId),
          eq(inventoryStock.businessId, businessId),
          eq(inventoryStock.locationId, locationId),
        ),
      )
      .returning({ quantity: inventoryStock.quantity });
    if (updatedStock?.quantity === null || updatedStock?.quantity === undefined) {
      throw new Error("Failed to update variant inventory.");
    }

    await tx.insert(inventoryMovements).values({
      businessId,
      variantId,
      locationId: stock.locationId,
      movementType: "adjustment",
      quantity: change,
      referenceType: `stock_adjustment:${adjustment.reason}`,
    });

    return {
      variantId,
      productName: buildVariantNameFromLabel(variant.productName, variant.variantOptions),
      previousQuantity,
      quantity: updatedStock.quantity,
      change,
    };
  });
}

export async function getAllProducts(businessId: number, locationId: number) {
  return db
    .select({
      ...getTableColumns(products),
      imageUrl: sql<
        string | null
      >`(SELECT pi.image_url FROM product_images pi WHERE pi.product_id = ${products.id} ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1)`,
      variants: sql`
        COALESCE(json_agg(
          jsonb_build_object(
            'id', ${productVariants.id},
            'productId', ${productVariants.productId},
            'sku', ${productVariants.sku},
            'barcode', ${productVariants.barcode},
            'weight', ${productVariants.weight},
            'weightUnit', ${productVariants.weightUnit},
            'sellingPrice', ${productVariants.sellingPrice},
            'alertQuantity', ${productVariants.alertQuantity},
            'isDefault', ${productVariants.isDefault},
            'status', ${productVariants.status},
            'quantity', ${inventoryStock.quantity},
            'purchaseCost', (
                            SELECT
                              SUM(
                                ${inventoryBatches.landedCostPerUnit} *
                                ${inventoryBatches.quantityRemaining}
                              ) / NULLIF(
                                SUM(${inventoryBatches.quantityRemaining}),
                                0
                              )
                            FROM ${inventoryBatches}
                            WHERE ${inventoryBatches.variantId} = ${productVariants.id}
                              AND ${inventoryBatches.businessId} = ${businessId}
                              AND ${inventoryBatches.quantityRemaining} > 0
                          ),
            'options', (
              SELECT json_agg(
                json_build_object(
                  'typeName', ${variantTypes.name},
                  'value', ${variantOptions.value}
                )
              )
              FROM ${variantValues}
              JOIN ${variantOptions} ON ${variantOptions.id} = ${variantValues.optionId}
              JOIN ${variantTypes} ON ${variantTypes.id} = ${variantOptions.variantTypeId}
              -- Removed inventoryStock from here!
              WHERE ${variantValues.variantId} = ${productVariants.id}
                AND ${variantValues.businessId} = ${businessId}
            )
          )
        ), '[]'::json) -- Returns [] instead of null if no variants exist
      `.as("variants"),
    })
    .from(products)
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    // Stock shown is the ACTIVE LOCATION's stock — the catalog is shared,
    // quantities are not. Transfer-created rows for other locations are
    // excluded here.
    .leftJoin(
      inventoryStock,
      and(
        eq(inventoryStock.variantId, productVariants.id),
        eq(inventoryStock.businessId, businessId),
        eq(inventoryStock.locationId, locationId),
      ),
    )
    .where(eq(products.businessId, businessId))
    .groupBy(products.id);
}
export async function createProduct(businessId: number, product: ProductsTypes) {
  const [created] = await db
    .insert(products)
    .values({ ...product, businessId })
    .returning();
  return created;
}
async function setQuantity(_id: number, _quantity: number) {
  return;
}
export async function decrementQuantity(id: number, currentQuantity: number) {
  return setQuantity(id, currentQuantity - 1);
}
export async function incrementQuantity(id: number, currentQuantity: number) {
  return setQuantity(id, currentQuantity + 1);
}
export async function restoreQuantity(
  id: number,
  currentQuantity: number,
  soldQuantity: number,
) {
  return setQuantity(id, currentQuantity + soldQuantity);
}
export async function restoreAllQuantity(
  id: number,
  productsQuantity: number,
  soldQuantity: number,
) {
  return setQuantity(id, productsQuantity + soldQuantity);
}
export async function adjustCustomQuantity(
  id: number,
  newQuantity: number,
  prevQuantity: number,
  productsQuantity: number,
) {
  return setQuantity(id, productsQuantity - (newQuantity - prevQuantity));
}
export async function updateStock(
  businessId: number,
  id: number,
  newStock: number,
  status: string,
) {
  return db
    .update(products)
    .set({ status: status })
    .where(and(eq(products.id, id), eq(products.businessId, businessId)));
}
async function getProductById(businessId: number, id: number) {
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, id), eq(products.businessId, businessId)));
  return product;
}
export async function duplicateProduct(businessId: number, id: number) {
  const product = await getProductById(businessId, id);
  if (!product) return null;
  const { id: _, ...productData } = product;
  const duplicateProduct = {
    ...productData,
    businessId,
    name: `${productData.name} (copy)`,
  };
  const [created] = await db
    .insert(products)
    .values(duplicateProduct)
    .returning();
  return created;
}
// Columns a PATCH payload may set. Everything else (id, businessId,
// timestamps, and any non-column keys the client sends) is dropped.
const PATCHABLE_PRODUCT_FIELDS = [
  "name",
  "categoryId",
  "brandId",
  "unitId",
  "description",
  "productType",
  "hasVariants",
  "trackingType",
  "status",
] as const;

export async function patchProduct(
  businessId: number,
  id: number,
  updates: Partial<ProductsTypes>,
) {
  const safeUpdates: Record<string, unknown> = {};
  for (const field of PATCHABLE_PRODUCT_FIELDS) {
    if (field in updates) {
      safeUpdates[field] = updates[field];
    }
  }
  if (Object.keys(safeUpdates).length === 0) {
    throw new BadRequestError("No updatable fields were provided.");
  }
  // Reference columns are plain FKs (no composite tenant constraint), so each
  // supplied reference must be verified against the caller's business here —
  // otherwise a patch could point this product at another business's rows.
  if (safeUpdates.categoryId != null) {
    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.id, safeUpdates.categoryId as number),
          eq(categories.businessId, businessId),
        ),
      )
      .limit(1);
    if (!category) throw new NotFoundError("Category does not exist");
  }
  if (safeUpdates.brandId != null) {
    const [brand] = await db
      .select({ id: brands.id })
      .from(brands)
      .where(
        and(
          eq(brands.id, safeUpdates.brandId as number),
          eq(brands.businessId, businessId),
        ),
      )
      .limit(1);
    if (!brand) throw new NotFoundError("Brand does not exist");
  }
  if (safeUpdates.unitId != null) {
    const [unit] = await db
      .select({ id: units.id })
      .from(units)
      .where(
        and(
          eq(units.id, safeUpdates.unitId as number),
          eq(units.businessId, businessId),
        ),
      )
      .limit(1);
    if (!unit) throw new NotFoundError("Unit does not exist");
  }
  return db
    .update(products)
    .set(safeUpdates as Partial<ProductsTypes>)
    .where(and(eq(products.id, id), eq(products.businessId, businessId)));
}
// router.delete("/api/products/remove_product/:id", async (req, res) => {
//   try {
//     const { id } = req.params;
//     const deleteProduct = await pool.query(
//       "DELETE FROM products WHERE id = $1",
//       [id],
//     );
//   } catch (err) {
//     console.error(err);
//   }
// });
