import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { purchaseItems } from "../../db/schema/purchaseItems.js";
import { purchases } from "../../db/schema/purchases.js";
import { suppliers } from "../../db/schema/suppliers.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import { createPurchase } from "../purchases/purchases.service.js";
import { recordAuditInTx } from "../../services/audit.js";

/**
 * Automated replenishment (Module 2C).
 *
 * Suggestions are DERIVED at read time (never stored): a variant is a
 * candidate when current stock + outstanding (unreceived) purchase
 * quantity has reached its reorder point, so in-flight orders are not
 * double-ordered. The default order size is the configured reorder
 * quantity, else the shortfall to the point. The last purchase's supplier
 * and unit cost prefill the purchase-order conversion.
 */

export interface ReorderSuggestion {
  variantId: number;
  productId: number;
  productName: string;
  sku: string | null;
  currentStock: number;
  outstandingOnOrder: number;
  reorderPoint: number;
  reorderQuantity: number | null;
  suggestedQuantity: number;
  lastSupplierId: number | null;
  lastSupplierName: string | null;
  lastUnitCost: number | null;
}

export async function listReorderSuggestions(
  businessId: number,
  locationId: number,
): Promise<ReorderSuggestion[]> {
  const rows = await db
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      sku: productVariants.sku,
      currentStock: inventoryStock.quantity,
      reorderPoint: productVariants.reorderPoint,
      reorderQuantity: productVariants.reorderQuantity,
      // Outstanding = not-yet-received quantity across open purchases.
      outstandingOnOrder: sql<number>`(
        SELECT COALESCE(SUM(${purchaseItems.quantity} - ${purchaseItems.receivedQuantity} - ${purchaseItems.cancelledQuantity}), 0)
        FROM ${purchaseItems}
        JOIN ${purchases} ON ${purchases.id} = ${purchaseItems.purchaseId}
        WHERE ${purchaseItems.variantId} = ${productVariants.id}
          AND ${purchases.businessId} = ${businessId}
          AND ${purchases.status} NOT IN ('received')
      )`,
      lastSupplierId: sql<number | null>`(
        SELECT ${purchases.supplierId} FROM ${purchaseItems}
        JOIN ${purchases} ON ${purchases.id} = ${purchaseItems.purchaseId}
        WHERE ${purchaseItems.variantId} = ${productVariants.id}
          AND ${purchases.businessId} = ${businessId}
          AND ${purchases.supplierId} IS NOT NULL
        ORDER BY ${purchases.id} DESC LIMIT 1
      )`,
      lastUnitCost: sql<number | null>`(
        SELECT ${purchaseItems.unitCost} FROM ${purchaseItems}
        JOIN ${purchases} ON ${purchases.id} = ${purchaseItems.purchaseId}
        WHERE ${purchaseItems.variantId} = ${productVariants.id}
          AND ${purchases.businessId} = ${businessId}
        ORDER BY ${purchases.id} DESC LIMIT 1
      )`,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(
      inventoryStock,
      and(
        eq(inventoryStock.variantId, productVariants.id),
        eq(inventoryStock.businessId, businessId),
        eq(inventoryStock.locationId, locationId),
      ),
    )
    .where(
      and(
        eq(productVariants.businessId, businessId),
        isNotNull(productVariants.reorderPoint),
      ),
    );

  const supplierNames = new Map<number, string>();
  const supplierIds = [
    ...new Set(
      rows.map((r) => r.lastSupplierId).filter((id): id is number => id !== null),
    ),
  ];
  if (supplierIds.length > 0) {
    const supplierRows = await db
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(eq(suppliers.businessId, businessId));
    for (const row of supplierRows) supplierNames.set(row.id, row.name);
  }

  const suggestions: ReorderSuggestion[] = [];
  for (const row of rows) {
    const current = Number(row.currentStock ?? 0);
    const onOrder = Number(row.outstandingOnOrder ?? 0);
    const point = Number(row.reorderPoint ?? 0);
    // Actual available stock nets in-flight purchases — no double-ordering.
    const available = current + onOrder;
    if (available > point) continue;
    const suggested =
      row.reorderQuantity !== null && Number(row.reorderQuantity) > 0
        ? Number(row.reorderQuantity)
        : Math.max(1, point - available);
    suggestions.push({
      variantId: row.variantId,
      productId: row.productId,
      productName: row.productName,
      sku: row.sku,
      currentStock: current,
      outstandingOnOrder: onOrder,
      reorderPoint: point,
      reorderQuantity:
        row.reorderQuantity !== null ? Number(row.reorderQuantity) : null,
      suggestedQuantity: suggested,
      lastSupplierId: row.lastSupplierId,
      lastSupplierName:
        row.lastSupplierId !== null
          ? (supplierNames.get(row.lastSupplierId) ?? null)
          : null,
      lastUnitCost:
        row.lastUnitCost !== null ? Number(row.lastUnitCost) : null,
    });
  }
  return suggestions;
}

export async function setReorderConfig(
  businessId: number,
  variantId: number,
  actorUserId: number | null,
  input: { reorderPoint: number | null; reorderQuantity: number | null },
) {
  for (const value of [input.reorderPoint, input.reorderQuantity]) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new BadRequestError(
        "Reorder values must be non-negative integers or null.",
      );
    }
  }
  return db.transaction(async (tx) => {
    const [variant] = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(eq(productVariants.id, variantId), eq(productVariants.businessId, businessId)),
      )
      .limit(1);
    if (!variant) throw new NotFoundError("Variant not found.");
    await tx
      .update(productVariants)
      .set({
        reorderPoint: input.reorderPoint,
        reorderQuantity: input.reorderQuantity,
      })
      .where(eq(productVariants.id, variantId));
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "product.reorder_configured",
      entityType: "product_variant",
      entityId: variantId,
      metadata: { ...input },
    });
    return { variantId, ...input };
  });
}

export interface ConvertInput {
  supplierId: number | null;
  items: { variantId: number; quantity?: number | undefined }[];
  note?: string | null | undefined;
}

/** Converts selected suggestions into a draft purchase order. */
export async function convertSuggestionsToPurchase(
  businessId: number,
  locationId: number,
  actorUserId: number | null,
  input: ConvertInput,
) {
  if (input.items.length === 0) {
    throw new BadRequestError("Select at least one suggestion to convert.");
  }
  const suggestions = await listReorderSuggestions(businessId, locationId);
  const byVariant = new Map(suggestions.map((s) => [s.variantId, s]));

  const purchaseItems0 = input.items.map((item) => {
    const suggestion = byVariant.get(item.variantId);
    if (!suggestion) {
      throw new BadRequestError(
        "One or more selected items are not current reorder suggestions.",
      );
    }
    const quantity =
      item.quantity !== undefined && item.quantity > 0
        ? item.quantity
        : suggestion.suggestedQuantity;
    return {
      variantId: item.variantId,
      quantity,
      // Prefill from purchase history; the buyer can edit the draft.
      purchasePrice: suggestion.lastUnitCost ?? 0,
      discount: 0,
      tax: 0,
    };
  });

  const purchase = await createPurchase(businessId, {
    items: purchaseItems0,
    supplierId: input.supplierId,
    purchaseDate: new Date(),
    notes: input.note ?? "Created from reorder suggestions",
    discount: 0,
    tax: 0,
    shippingCost: 0,
  });

  await db.transaction(async (tx) => {
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "purchase.from_reorder",
      entityType: "purchase",
      entityId: (purchase as { id?: number }).id ?? null,
      metadata: { itemCount: purchaseItems0.length, locationId },
    });
  });

  return purchase;
}

export async function getVariantReorderConfig(
  businessId: number,
  variantId: number,
) {
  const [variant] = await db
    .select({
      variantId: productVariants.id,
      reorderPoint: productVariants.reorderPoint,
      reorderQuantity: productVariants.reorderQuantity,
    })
    .from(productVariants)
    .where(
      and(eq(productVariants.id, variantId), eq(productVariants.businessId, businessId)),
    )
    .limit(1);
  if (!variant) throw new NotFoundError("Variant not found.");
  return variant;
}
