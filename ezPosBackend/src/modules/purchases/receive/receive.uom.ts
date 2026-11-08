import { and, eq, inArray } from "drizzle-orm";
import { BadRequestError } from "../../../utils/handleError.js";
import { productVariants } from "../../../db/schema/productVariants.js";
import type { DbExecutor } from "../../uom/uom.service.js";
import { resolveUomContext } from "../../uom/uom.service.js";
import { factorToMicros, perBasePriceMicros, microsToNumber } from "../../uom/uom.money.js";
import type { Items, PurchaseItem } from "./receive.types.js";

/**
 * UOM boundary for receiving (migration 0062): converts every entered
 * packaging quantity on a receive submission to BASE units, ONCE, so every
 * downstream rule (outstanding vs ordered, tolerance, batch sums, serial
 * counts, batch prices, stock) keeps its base-unit invariant untouched.
 *
 * The entered unit is, in order of authority:
 *  1. the payload's uomConversionId (receiving in a different authorized
 *     unit than the PO line was ordered in is allowed — the outstanding
 *     check runs in base), resolved ACTIVE from the DB;
 *  2. otherwise the ORDER line's stored factor snapshot;
 *  3. otherwise identity (base unit).
 *
 * Whole-base is enforced here: INTEGER stock/batch columns cannot hold a
 * fraction, so a half box can never partially receive.
 */
export async function normalizeReceiveItemsToBase(
  dbe: DbExecutor,
  businessId: number,
  existingItems: PurchaseItem[],
  items: Items[],
): Promise<Map<number, Items>> {
  const purchaseItemById = new Map(existingItems.map((pi) => [pi.id, pi]));

  // Resolve product ids for the variants involved (needed only when the
  // payload names an explicit conversion row).
  const variantIdsNeedingContext = [
    ...new Set(
      items
        .filter((item) => item.uomConversionId != null)
        .map((item) => purchaseItemById.get(item.itemId)?.variantId)
        .filter((id): id is number => id != null),
    ),
  ];
  const productByVariantId = new Map<number, number>();
  if (variantIdsNeedingContext.length > 0) {
    const rows = await dbe
      .select({ id: productVariants.id, productId: productVariants.productId })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.businessId, businessId),
          inArray(productVariants.id, variantIdsNeedingContext),
        ),
      );
    for (const row of rows) productByVariantId.set(row.id, row.productId);
  }

  const normalized = new Map<number, Items>();
  for (const receiveItem of items) {
    const purchaseItem = purchaseItemById.get(receiveItem.itemId);
    if (!purchaseItem) {
      // Validation elsewhere reports the missing item clearly.
      normalized.set(receiveItem.itemId, receiveItem);
      continue;
    }

    const payloadUnitId = receiveItem.uomConversionId ?? null;
    const lineUnitId = purchaseItem.uomConversionId ?? null;

    if (payloadUnitId == null && lineUnitId == null) {
      normalized.set(receiveItem.itemId, receiveItem);
      continue;
    }

    if (payloadUnitId != null) {
      const productId = productByVariantId.get(purchaseItem.variantId);
      if (productId == null) {
        throw new BadRequestError(
          `Variant ${purchaseItem.variantId} was not found for item ${purchaseItem.id}.`,
        );
      }
      const ctx = await resolveUomContext(
        dbe,
        businessId,
        productId,
        purchaseItem.variantId,
        payloadUnitId,
      );
      normalized.set(
        receiveItem.itemId,
        convertReceiveItemToBase(receiveItem, purchaseItem, ctx.factorMicros, {
          conversionId: ctx.conversion!.id,
          conversionFactor: ctx.factor,
        }),
      );
      continue;
    }

    // No payload unit: the line's snapshot decides (the factor is never
    // trusted from the client, and historical POs stay receivable after
    // the packaging row is deactivated).
    const factorMicros = factorToMicros(purchaseItem.conversionFactor ?? 1);
    normalized.set(
      receiveItem.itemId,
      convertReceiveItemToBase(receiveItem, purchaseItem, factorMicros, {
        conversionId: lineUnitId!,
        conversionFactor: purchaseItem.conversionFactor ?? 1,
      }),
    );
  }
  return normalized;
}

function convertReceiveItemToBase(
  receiveItem: Items,
  purchaseItem: PurchaseItem,
  factorMicros: bigint,
  snapshot: { conversionId: number; conversionFactor: number },
): Items {
  return {
    ...receiveItem,
    receiveNow: baseOrThrow(
      receiveItem.receiveNow,
      factorMicros,
      "Receive quantity",
      purchaseItem.id,
    ),
    rejectedQuantity:
      receiveItem.rejectedQuantity > 0
        ? baseOrThrow(
            receiveItem.rejectedQuantity,
            factorMicros,
            "Rejected quantity",
            purchaseItem.id,
          )
        : 0,
    batches: receiveItem.batches.map((batch) => ({
      ...batch,
      quantity: baseOrThrow(
        batch.quantity,
        factorMicros,
        `Batch ${batch.batchNumber}`,
        purchaseItem.id,
      ),
    })),
    unitCost: microsToNumber(
      perBasePriceMicros(receiveItem.unitCost, factorMicros),
    ),
    uomSnapshot: {
      conversionId: snapshot.conversionId,
      enteredQuantity: receiveItem.receiveNow,
      enteredUnitPrice: receiveItem.unitCost,
      conversionFactor: snapshot.conversionFactor,
    },
  };
}

/** entered × factor → whole base quantity, or a clear 400. */
function baseOrThrow(
  entered: number,
  factorMicros: bigint,
  label: string,
  itemId: number,
): number {
  const micros = (BigInt(Math.round(entered * 1000)) * factorMicros) / 1000n;
  if (micros % 1_000_000n !== 0n) {
    throw new BadRequestError(
      `${label} of item ${itemId} does not convert to a whole base quantity — adjust the entered quantity or receive in the base unit.`,
    );
  }
  return Number(micros) / 1e6;
}
