import { and, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import { createPurchase } from "../purchases/purchases.service.js";
import { recordAuditInTx } from "../../services/audit.js";
import {
  computeReorderRows,
  rowsToSuggestions,
} from "../procurement/reorderPlanning.service.js";

/**
 * Automated replenishment (Module 2C).
 *
 * Suggestions are DERIVED at read time (never stored) and share ONE
 * computation with the Smart Reorder dashboard
 * (procurement/reorderPlanning.service): available = (stock − reserved)
 * + outstanding POs + in-transit inbound transfers, so in-flight orders
 * are never double-ordered. The default order size is the configured
 * reorder quantity, else the shortfall to the point. The last purchase's
 * supplier and unit cost prefill the purchase-order conversion.
 */

export interface ReorderSuggestion {
  variantId: number;
  productId: number;
  productName: string;
  variantOptions: string | null;
  variantName: string | null;
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
  const rows = await computeReorderRows(businessId, locationId);
  return rowsToSuggestions(rows);
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
    discountBasis: "fixed",
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
