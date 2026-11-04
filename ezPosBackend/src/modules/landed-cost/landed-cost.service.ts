import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { purchaseItems } from "../../db/schema/purchaseItems.js";
import { purchases } from "../../db/schema/purchases.js";
import { landedCosts } from "../../db/schema/landedCosts.js";
import { variantOptions } from "../../db/schema/variantOptions.js";
import { variantValues } from "../../db/schema/variantValues.js";
import {
  buildVariantName,
  foldVariantOptionRows,
  variantNameFromMap,
} from "../../utils/variantDisplay.js";
import { LandedCostValidationError } from "./landed-cost.calculator.js";
import { capitalizableAmountMicros } from "./landed-cost.types.js";
import { calculateAllocation, type AllocationEngineResult } from "./landed-cost.calculator.js";
import type { LandedCostPreviewInput } from "./landed-cost.validation.js";

// ----------------------------------------------------
// Context loading
// ----------------------------------------------------

export interface LandedCostBatchContext {
  batchId: number;
  batchNumber: string;
  quantityReceived: number;
  quantityRemaining: number;
}

export interface LandedCostLineContext {
  purchaseItemId: number;
  variantId: number;
  productName: string;
  variantName: string;
  sku: string | null;
  unitCost: number;
  discount: number;
  receivedQuantity: number;
  orderedQuantity: number;
  variantWeight: number | null;
  variantWeightUnit: string | null;
  productDefaultWeightKg: number | null;
  batches: LandedCostBatchContext[];
}

export interface LandedCostContext {
  purchase: typeof purchases.$inferSelect;
  lines: LandedCostLineContext[];
  existingStatus: string | null;
  existingDocumentId: number | null;
}

/**
 * Landed-cost context for a purchase: header, received lines with their
 * batches (this purchase's receiving location) and weights. The purchase
 * must belong to the caller's business and have been received at least once.
 */
export async function getLandedCostContext(
  businessId: number,
  purchaseId: number,
): Promise<LandedCostContext> {
  const [purchase] = await db
    .select()
    .from(purchases)
    .where(and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)))
    .limit(1);
  if (!purchase) {
    throw new LandedCostValidationError([
      { code: "purchase_not_found", message: "Purchase not found." },
    ]);
  }
  if (!purchase.locationId) {
    throw new LandedCostValidationError([
      {
        code: "not_received",
        message:
          "Receive at least one quantity before allocating landed costs.",
      },
    ]);
  }

  const itemRows = await db
    .select({
      purchaseItemId: purchaseItems.id,
      variantId: purchaseItems.variantId,
      unitCost: purchaseItems.unitCost,
      discount: purchaseItems.discount,
      receivedQuantity: purchaseItems.receivedQuantity,
      orderedQuantity: purchaseItems.quantity,
      productName: products.name,
      sku: productVariants.sku,
      variantWeight: productVariants.weight,
      variantWeightUnit: productVariants.weightUnit,
      productWeightKg: products.shippingWeightKg,
    })
    .from(purchaseItems)
    .innerJoin(
      productVariants,
      and(
        eq(productVariants.id, purchaseItems.variantId),
        eq(productVariants.businessId, purchaseItems.businessId),
      ),
    )
    .innerJoin(
      products,
      and(
        eq(products.id, productVariants.productId),
        eq(products.businessId, purchaseItems.businessId),
      ),
    )
    .where(
      and(
        eq(purchaseItems.purchaseId, purchaseId),
        eq(purchaseItems.businessId, businessId),
        gt(purchaseItems.receivedQuantity, 0),
      ),
    );

  const batchRows = itemRows.length
    ? await db
        .select({
          batchId: inventoryBatches.id,
          purchaseItemId: inventoryBatches.purchaseItemId,
          batchNumber: inventoryBatches.batchNumber,
          quantityReceived: inventoryBatches.quantityReceived,
          quantityRemaining: inventoryBatches.quantityRemaining,
        })
        .from(inventoryBatches)
        .where(
          and(
            inArray(
              inventoryBatches.purchaseItemId,
              itemRows.map((r) => r.purchaseItemId),
            ),
            eq(inventoryBatches.businessId, businessId),
          ),
        )
        .orderBy(asc(inventoryBatches.id))
    : [];

  // Variant option labels batched per distinct variant (a join would fan
  // out the lines per option value).
  const variantIds = [...new Set(itemRows.map((r) => r.variantId))];
  let optionsByVariant = new Map<number, string[]>();
  if (variantIds.length > 0) {
    const optRows = await db
      .select({
        variantId: variantValues.variantId,
        value: variantOptions.value,
      })
      .from(variantValues)
      .innerJoin(variantOptions, eq(variantValues.optionId, variantOptions.id))
      .where(inArray(variantValues.variantId, variantIds))
      .orderBy(asc(variantValues.optionId));
    optionsByVariant = foldVariantOptionRows(optRows);
  }

  // Existing document, if any (unique per purchase).
  const [existing] = await db
    .select({ id: landedCosts.id, status: landedCosts.status })
    .from(landedCosts)
    .where(
      and(
        eq(landedCosts.purchaseId, purchaseId),
        eq(landedCosts.businessId, businessId),
      ),
    )
    .limit(1);

  const lines: LandedCostLineContext[] = itemRows.map((row) => ({
    purchaseItemId: row.purchaseItemId,
    variantId: row.variantId,
    productName: row.productName,
    variantName: variantNameFromMap(
      optionsByVariant,
      row.variantId,
      row.productName,
    ),
    sku: row.sku,
    unitCost: Number(row.unitCost),
    discount: Number(row.discount),
    receivedQuantity: Number(row.receivedQuantity),
    orderedQuantity: Number(row.orderedQuantity),
    variantWeight:
      row.variantWeight === null ? null : Number(row.variantWeight),
    variantWeightUnit: row.variantWeightUnit,
    productDefaultWeightKg:
      row.productWeightKg === null ? null : Number(row.productWeightKg),
    batches: batchRows
      .filter((b) => b.purchaseItemId === row.purchaseItemId)
      .map((b) => ({
        batchId: b.batchId,
        batchNumber: b.batchNumber,
        quantityReceived: b.quantityReceived,
        quantityRemaining: b.quantityRemaining,
      })),
  }));

  return {
    purchase,
    lines,
    existingStatus: existing?.status ?? null,
    existingDocumentId: existing?.id ?? null,
  };
}

// ----------------------------------------------------
// Preview (the exact calculation posting will use)
// ----------------------------------------------------

export interface AccountingImpact {
  capitalizableToInventory: number;
  periodExpenses: number;
  bySettlement: { settlementType: string; amount: number }[];
}

export interface LandedCostPreview {
  totalExpenseAmount: number;
  totalCapitalizableAmount: number;
  totalNonCapitalizableAmount: number;
  allocation: AllocationEngineResult;
  accountingImpact: AccountingImpact;
}

export function computeLandedCostPreview(
  lines: LandedCostLineContext[],
  input: LandedCostPreviewInput,
): LandedCostPreview {
  const capitalizableMicros = capitalizableAmountMicros(input.expenses);
  if (capitalizableMicros <= 0n) {
    throw new LandedCostValidationError([
      {
        code: "nothing_capitalizable",
        message: "At least one capitalizable expense is required.",
      },
    ]);
  }

  const allocation = calculateAllocation({
    method: input.method,
    total: Number(capitalizableMicros) / 1_000_000,
    lines: lines.map((line) => ({
      purchaseItemId: line.purchaseItemId,
      variantId: line.variantId,
      unitCost: line.unitCost,
      discount: line.discount,
      quantityOrdered: line.orderedQuantity,
      batches: line.batches.map((b) => ({
        batchId: b.batchId,
        batchNumber: b.batchNumber,
        quantityReceived: b.quantityReceived,
      })),
      variantWeight: line.variantWeight,
      variantWeightUnit: line.variantWeightUnit,
      productDefaultWeightKg: line.productDefaultWeightKg,
    })),
    ...(input.manualAllocations ? { manualLines: input.manualAllocations } : {}),
  });

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const totalExpenseAmount = round2(
    input.expenses.reduce((sum, e) => sum + Number(e.amount), 0),
  );
  const totalCapitalizableAmount = round2(
    Number(capitalizableMicros) / 1_000_000,
  );

  const bySettlement = new Map<string, number>();
  for (const expense of input.expenses) {
    const capitalizable =
      expense.isCapitalizable === false
        ? 0
        : Number(expense.amount) +
          (expense.taxTreatment === "non_recoverable"
            ? Number(expense.taxAmount ?? 0)
            : 0);
    const total =
      capitalizable +
      (expense.isCapitalizable === false ? Number(expense.amount) : 0);
    const settlement = expense.settlementType ?? "unpaid";
    bySettlement.set(settlement, round2((bySettlement.get(settlement) ?? 0) + total));
  }

  return {
    totalExpenseAmount,
    totalCapitalizableAmount,
    totalNonCapitalizableAmount: round2(
      totalExpenseAmount - totalCapitalizableAmount,
    ),
    allocation,
    accountingImpact: {
      capitalizableToInventory: totalCapitalizableAmount,
      periodExpenses: round2(
        input.expenses
          .filter((e) => e.isCapitalizable === false)
          .reduce((sum, e) => sum + Number(e.amount), 0),
      ),
      bySettlement: [...bySettlement].map(([settlementType, amount]) => ({
        settlementType,
        amount,
      })),
    },
  };
}
