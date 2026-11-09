import { db } from "../../db/schema/index.js";
import {
  foldVariantOptionRows,
  variantNameFromMap,
  variantOptionsFromMap,
} from "../../utils/variantDisplay.js";
import { variantOptions } from "../../db/schema/variantOptions.js";
import { variantValues } from "../../db/schema/variantValues.js";
import { purchaseItems } from "../../db/schema/purchaseItems.js";
import { purchaseReturns } from "../../db/schema/purchaseReturns.js";
import { supplierLedger } from "../../db/schema/supplierLedger.js";
import { purchaseReturnItems } from "../../db/schema/purchaseReturnItems.js";
import { purchases } from "../../db/schema/purchases.js";
import { landedCosts } from "../../db/schema/landedCosts.js";
import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { roundMoney } from "../../utils/roundMoney.js";
import {
  postPurchasePaymentLedgerEntry,
  postPurchaseReceiveLedgerEntry,
} from "./purchases.ledger.js";
import { products } from "../../db/schema/products.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import type { CreatePurchaseInput } from "./schemas/purchase.schema.js";
import {
  calculatePurchaseFinancials,
} from "./purchaseFinancials.service.js";
import { suppliers } from "../../db/schema/suppliers.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { units } from "../../db/schema/units.js";
import type { ReceiveItemsFormValues } from "./schemas/receiveItem.schema.js";
import { normalizeReceiveItemsToBase } from "./receive/receive.uom.js";
import { resolveUomContext, convertEnteredLine } from "../uom/uom.service.js";
import { checkPriceIncreasesInTx } from "../procurement/priceAlerts.service.js";
import { applyReceiveDeltaInTx, lockDocumentForPurchaseInTx } from "../landed-cost/landed-cost.lifecycle.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { locations } from "../../db/schema/locations.js";
import {
  basicRequestValidation,
  batchValidation,
  purchaseItemsValidation,
  purchaseValidation,
  receiveItemsValidation,
  serialAvailabilityValidation,
  serialNumberValidation,
} from "./receive/receive.validation.js";
import { getReceivingSettings } from "./receivingSettings.service.js";
import {
  getPurchaseCancelledValueInTx,
  getPurchaseReturnedValueInTx,
} from "./outstandingResolution.service.js";
import {
  calculatePurchaseStatus,
  calculatePayments,
  calculatePaymentStatus,
} from "./receive/receive.calculations.js";
import {
  getAllPurchaseItems,
  getPurchaseReceivedAmountInTx,
  insertInventoryBatches,
  insertPurchasePayments,
  insertReceivingRecords,
  insertSerialNumbers,
  updateProductVariants,
  updatePurchase,
  updatePurchaseItems,
  type ReceivingRecordInput,
} from "./receive/receive.service.js";
import { purchaseDiscrepancies } from "../../db/schema/purchaseDiscrepancies.js";
import {
  incrementStockForReceive,
  recordStockMovement,
} from "../inventory/index.js";
import {
  formatPurchaseOrderNumber,
  nextDocumentNumber,
} from "../../utils/documentSequence.js";

// Every function takes the caller's server-verified businessId (from
// requireBusinessContext) and scopes all reads and writes to it.

export async function createPurchase(
  businessId: number,
  data: CreatePurchaseInput,
) {
  return db.transaction(async (tx) => {
    const {
      supplierId,
      items,
      purchaseDate,
      notes,
      discount,
      discountBasis,
      tax,
      shippingCost,
    } = data;

    // 1. Validate Supplier (same business only)
    if (supplierId) {
      const supplier = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(
          and(
            eq(suppliers.id, supplierId),
            eq(suppliers.businessId, businessId),
          ),
        );
      if (supplier.length === 0) {
        throw new NotFoundError("Supplier not found");
      }
    }

    // 2. Validate Variants (same business only)
    const variantIds = [...new Set(items.map((item) => item.variantId))];
    const existingVariants = await tx
      .select({ id: productVariants.id, status: productVariants.status })
      .from(productVariants)
      .where(
        and(
          inArray(productVariants.id, variantIds),
          eq(productVariants.businessId, businessId),
        ),
      );

    if (existingVariants.length !== variantIds.length) {
      const foundIds = existingVariants.map((v) => v.id);
      const missingIds = variantIds.filter((id) => !foundIds.includes(id));
      throw new NotFoundError(
        `These variant IDs do not exist: ${missingIds.join(", ")}`,
      );
    }

    // Check for inactive variants
    for (const variant of existingVariants) {
      if (variant.status !== "active") {
        throw new NotFoundError(`Variant ${variant.id} is inactive`);
      }
    }

    // 3. Calculate totals — the authoritative financial service (Phase 2).
    // Same per-line-round-then-sum formula as before, now single-sourced.
    const financials = calculatePurchaseFinancials({
      lines: items.map((item) => ({
        quantity: item.quantity,
        unitPrice: item.purchasePrice,
        discount: item.discount,
        tax: item.tax,
      })),
      orderDiscount: discount,
      orderDiscountBasis: discountBasis,
      orderTax: tax,
      supplierShipping: shippingCost,
    });
    const subtotal = financials.itemsSubtotal;
    const totalAmount = financials.grandTotal;

    // 4. Per-business PO number. The number comes from the business's own
    // document_sequences counter inside this transaction (rollback-safe);
    // the year in the prefix is the document's issue year.
    const number = await nextDocumentNumber(tx, businessId, "purchase_order");
    const purchaseOrderNumber = formatPurchaseOrderNumber(
      new Date(purchaseDate).getFullYear(),
      number,
    );

    // 5. Create Purchase
    const [newPurchase] = await tx
      .insert(purchases)
      .values({
        businessId,
        supplierId,
        purchaseOrderNumber,
        purchaseDate,
        notes,
        subtotal,
        // The RESOLVED invoice discount (Phase 12 fix): a percentage
        // discount is stored as the money it resolves to, so the stored
        // header always reconciles with totalAmount and the acquisition
        // classification reads the real discount, not the raw percent.
        discount: String(financials.orderDiscount),
        tax: String(tax),
        shippingCost: String(shippingCost),
        totalAmount,
        dueAmount: totalAmount,
      })
      .returning();

    if (!newPurchase) {
      throw new Error("Failed to create purchase record");
    }

    // 6. Create Purchase Items (BULK INSERT).
    // UOM (migration 0062): the payload's quantity/purchasePrice are in the
    // ENTERED unit (uomConversionId, null = base). Stored quantity/unitCost
    // stay BASE-unit so the generated total and every per-unit derivation
    // keep their meaning; the entered figures become immutable snapshots.
    // Financials above were computed from the ENTERED values (exact line
    // money); base figures below carry no extra discount/tax arithmetic.
    const productsByVariantId = new Map<number, number>();
    if (items.some((item) => item.uomConversionId != null)) {
      const variantRows = await tx
        .select({ id: productVariants.id, productId: productVariants.productId })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.businessId, businessId),
            inArray(productVariants.id, variantIds),
          ),
        );
      for (const row of variantRows) productsByVariantId.set(row.id, row.productId);
    }

    const itemsToInsert = [] as (typeof purchaseItems.$inferInsert)[];
    for (const item of items) {
      const line: typeof purchaseItems.$inferInsert = {
        businessId,
        purchaseId: newPurchase.id,
        variantId: item.variantId,
        quantity: item.quantity,
        receivedQuantity: 0,
        unitCost: item.purchasePrice,
        discount: item.discount,
        tax: item.tax,
      };
      if (item.uomConversionId != null) {
        const productId = productsByVariantId.get(item.variantId);
        if (productId == null) {
          throw new NotFoundError(`Variant ${item.variantId} not found.`);
        }
        const ctx = await resolveUomContext(
          tx,
          businessId,
          productId,
          item.variantId,
          item.uomConversionId,
        );
        // Ordered base quantities live on a numeric(12,3) column: the
        // converted amount must sit on that grid or every outstanding/
        // tolerance ratio downstream would drift.
        const converted = convertEnteredLine(ctx, item.quantity, null);
        if (converted.baseMicros % 1000n !== 0n) {
          throw new BadRequestError(
            `The ordered quantity for this packaging unit does not convert to a valid base quantity.`,
          );
        }
        const priced = convertEnteredLine(
          ctx,
          item.quantity,
          item.purchasePrice,
        );
        line.quantity = converted.baseQuantity;
        line.unitCost = priced.baseUnitPrice;
        line.uomConversionId = ctx.conversion!.id;
        line.enteredQuantity = item.quantity;
        line.enteredUnitPrice = item.purchasePrice;
        line.conversionFactor = ctx.factor;
      }
      itemsToInsert.push(line);
    }

    // Insert them all in ONE single database query!
    await tx.insert(purchaseItems).values(itemsToInsert);

    // 7. Return the new purchase so the frontend can use it. The id was
    // added in Phase 5 (Smart Procurement draft creation navigates to the
    // created PO); consumers reading purchaseOrderNumber are unaffected.
    return {
      id: newPurchase.id,
      purchaseOrderNumber: newPurchase.purchaseOrderNumber,
    };
  });
}
// Landed-cost status for the purchases list indicator. Only applicable
// states are surfaced: draft/posted docs with unallocated capitalizable
// amount → "pending"; posted/adjusted docs fully allocated → "allocated";
// no document or a fully reversed document → null (no indicator).
export function deriveLandedCostStatus(row: {
  landedCostDocStatus: string | null;
  landedCostPending: string | number | null;
}): "pending" | "allocated" | null {
  if (row.landedCostDocStatus === "draft") return "pending";
  if (
    row.landedCostDocStatus === "posted" ||
    row.landedCostDocStatus === "adjusted"
  ) {
    // 0.005 tolerance absorbs numeric(14,4) rounding residue.
    return Number(row.landedCostPending ?? 0) > 0.005 ? "pending" : "allocated";
  }
  return null;
}

/**
 * Purchase rows joined with the (single, unique-per-purchase) landed-cost
 * document so the list can show a landed-cost allocation indicator.
 */
function purchasesWithLandedCostQuery() {
  return db
    .select({
      ...getTableColumns(purchases),
      supplierName: suppliers.name,
      // Feeds the list page's supplier search (Phase 2, §2.4).
      supplierPhone: suppliers.phone,
      landedCostDocStatus: landedCosts.status,
      landedCostPending: landedCosts.pendingAllocationAmount,
      // Derived (Phase 3 — no schema change): a purchase whose lines
      // accepted ZERO goods but wrote some off is workflow-complete
      // (status "received") without anything physically arriving. The
      // list surfaces this so the UI never presents it as received goods.
      fullyCancelled: sql<boolean>`(
        SELECT COALESCE(SUM(pi.received_quantity), 0) = 0
          AND COALESCE(SUM(pi.cancelled_quantity), 0) > 0
        FROM purchase_items pi WHERE pi.purchase_id = ${purchases.id}
      )`,
    })
    .from(purchases)
    .leftJoin(suppliers, eq(purchases.supplierId, suppliers.id))
    .leftJoin(
      landedCosts,
      and(
        eq(landedCosts.purchaseId, purchases.id),
        eq(landedCosts.businessId, purchases.businessId),
      ),
    );
}

function withLandedCostStatus<
  T extends {
    landedCostDocStatus: string | null;
    landedCostPending: string | number | null;
  },
>(row: T) {
  const { landedCostDocStatus, landedCostPending, ...rest } = row;
  return {
    ...rest,
    landedCostStatus: deriveLandedCostStatus({ landedCostDocStatus, landedCostPending }),
  };
}

export async function getPurchasesSummary(businessId: number) {
  const [
    orderedPurchase,
    allPurchases,
    partiallyPaidPurchase,
    completedPurchase,
  ] = await Promise.all([
    purchasesWithLandedCostQuery()
      .where(
        and(
          eq(purchases.status, "ordered"),
          eq(purchases.businessId, businessId),
        ),
      ),
    purchasesWithLandedCostQuery().where(eq(purchases.businessId, businessId)),
    purchasesWithLandedCostQuery()
      .where(
        and(
          inArray(purchases.paymentStatus, ["partial", "unpaid"]),
          eq(purchases.businessId, businessId),
        ),
      ),
    purchasesWithLandedCostQuery()
      .where(
        and(
          inArray(purchases.paymentStatus, ["paid"]),
          eq(purchases.businessId, businessId),
        ),
      ),
  ]);
  return {
    orderedPurchase: orderedPurchase.map(withLandedCostStatus),
    allPurchases: allPurchases.map(withLandedCostStatus),
    partiallyPaidPurchase: partiallyPaidPurchase.map(withLandedCostStatus),
    completedPurchase: completedPurchase.map(withLandedCostStatus),
  };
}
export async function getPurchasesItems(
  businessId: number,
  locationId: number,
) {
  const rows = await db
    .select({
      // 1. Spread the table to get all its columns
      ...getTableColumns(purchaseItems),

      // 2. Select specific related columns
      productName: products.name,
      productUnit: units.name,
      sellingPrice: productVariants.sellingPrice,
      productId: products.id,
      variantSku: productVariants.sku,
      trackingType: products.trackingType,
      availableStock: inventoryStock.quantity,
    })
    .from(purchaseItems)
    // 3. Join Variant (Purchase Items link to Variants, not directly to Products!)
    .innerJoin(
      productVariants,
      eq(purchaseItems.variantId, productVariants.id),
    )
    // 4. Join Product (Variants link to Products)
    .innerJoin(products, eq(productVariants.productId, products.id))
    // 5. Join Unit (Products link to Units)
    .leftJoin(units, eq(units.id, products.unitId))
    .leftJoin(
      inventoryStock,
      and(
        eq(inventoryStock.variantId, productVariants.id),
        eq(inventoryStock.businessId, businessId),
        eq(inventoryStock.locationId, locationId),
      ),
    )
    .where(eq(purchaseItems.businessId, businessId)); // leftJoin is safer in case a product has no unit

  // Option labels batched per distinct variant — a direct join would fan out
  // one row per option value.
  const variantIds = [...new Set(rows.map((row) => row.variantId))];
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

  return rows.map((row) => ({
    ...row,
    variantOptions: variantOptionsFromMap(optionsByVariant, row.variantId),
    variantName: variantNameFromMap(optionsByVariant, row.variantId, row.productName),
  }));
}

/**
 * Purchase detail: header (with supplier name + landed-cost status) and the
 * order's items with variant display. Stock is shown at the purchase's
 * receiving location when one is recorded.
 */
export async function getPurchaseDetail(businessId: number, purchaseId: number) {
  const [purchase] = await purchasesWithLandedCostQuery()
    .where(
      and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)),
    )
    .limit(1);

  if (!purchase) {
    throw new NotFoundError("Purchase order not found.");
  }

  const itemRows = await db
    .select({
      ...getTableColumns(purchaseItems),
      productName: products.name,
      productUnit: units.name,
      sellingPrice: productVariants.sellingPrice,
      productId: products.id,
      variantSku: productVariants.sku,
      trackingType: products.trackingType,
      availableStock: inventoryStock.quantity,
    })
    .from(purchaseItems)
    .innerJoin(productVariants, eq(purchaseItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(units, eq(units.id, products.unitId))
    .leftJoin(
      inventoryStock,
      and(
        eq(inventoryStock.variantId, productVariants.id),
        eq(inventoryStock.businessId, businessId),
        eq(inventoryStock.locationId, purchase.locationId ?? -1),
      ),
    )
    .where(
      and(
        eq(purchaseItems.purchaseId, purchaseId),
        eq(purchaseItems.businessId, businessId),
      ),
    );

  // Option labels batched per distinct variant (a join would fan out rows).
  const variantIds = [...new Set(itemRows.map((row) => row.variantId))];
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

  const items = itemRows.map((row) => ({
    ...row,
    variantOptions: variantOptionsFromMap(optionsByVariant, row.variantId),
    variantName: variantNameFromMap(optionsByVariant, row.variantId, row.productName),
  }));

  // Return status (Phase 11) mirrors the list's derivation: returned
  // quantities vs accepted received quantities, two-status independent.
  // Phase 1 (return module): the same query now groups PER ITEM so the
  // return context can carry previously-returned quantities per line.
  const returnRows = await db
    .select({
      purchaseItemId: purchaseReturnItems.purchaseItemId,
      returned: sql<string>`COALESCE(SUM(${purchaseReturnItems.quantity}), 0)`,
    })
    .from(purchaseReturnItems)
    .innerJoin(
      purchaseReturns,
      and(
        eq(purchaseReturnItems.purchaseReturnId, purchaseReturns.id),
        eq(purchaseReturnItems.businessId, purchaseReturns.businessId),
      ),
    )
    .where(
      and(
        eq(purchaseReturns.purchaseId, purchaseId),
        eq(purchaseReturns.businessId, businessId),
      ),
    )
    .groupBy(purchaseReturnItems.purchaseItemId);
  const returnedByItem = new Map(
    returnRows.map((row) => [row.purchaseItemId, Number(row.returned)]),
  );
  const returnedQuantity = returnRows.reduce(
    (sum, row) => sum + Number(row.returned),
    0,
  );
  const receivedQuantity = items.reduce(
    (sum, item) => sum + Number(item.receivedQuantity),
    0,
  );
  const returnStatus: "Returned" | "Partially returned" | null =
    returnedQuantity === 0
      ? null
      : returnedQuantity >= receivedQuantity
        ? "Returned"
        : "Partially returned";

  // Phase 1 (return module): the return context evaluates eligibility at
  // the purchase's RECEIVING location — never the caller's active
  // location. The return service deducts stock there, so the page's
  // availability and clamps must be computed against the same place.
  const receivingLocationId = purchase.locationId;
  const [receivingLocation] = receivingLocationId
    ? await db
        .select({ name: locations.name })
        .from(locations)
        .where(
          and(
            eq(locations.id, receivingLocationId),
            eq(locations.businessId, businessId),
          ),
        )
        .limit(1)
    : [];
  const stockRows =
    receivingLocationId && variantIds.length
      ? await db
          .select({
            variantId: inventoryStock.variantId,
            quantity: inventoryStock.quantity,
          })
          .from(inventoryStock)
          .where(
            and(
              eq(inventoryStock.businessId, businessId),
              eq(inventoryStock.locationId, receivingLocationId),
              inArray(inventoryStock.variantId, variantIds),
            ),
          )
      : [];
  const stockByVariant = new Map(
    stockRows.map((row) => [row.variantId, Number(row.quantity ?? 0)]),
  );
  // Phase 3 - supplier credit visibility: the supplier's recorded credit
  // balance (returns + cancellations). supplier_ledger is CREDIT-ONLY in
  // this system (payments never write it, nothing consumes credits), so
  // the sum IS the unapplied credit balance. It is not a cash refund.
  let supplierCreditBalance = 0;
  if (purchase.supplierId !== null) {
    const [ledgerAgg] = await db
      .select({
        credits: sql<string>`COALESCE(SUM(${supplierLedger.credit}), 0)`,
      })
      .from(supplierLedger)
      .where(
        and(
          eq(supplierLedger.supplierId, purchase.supplierId),
          eq(supplierLedger.businessId, businessId),
        ),
      );
    supplierCreditBalance = Math.max(0, Number(ledgerAgg?.credits ?? 0));
  }

  const canReturn = purchase.supplierId !== null && receivingLocationId !== null;
  const returnContext = {
    locationId: receivingLocationId,
    locationName: receivingLocation?.name ?? null,
    canReturn,
    reason: canReturn
      ? null
      : purchase.supplierId === null
        ? ("no_supplier" as const)
        : ("not_received" as const),
    items: items.map((item) => ({
      purchaseItemId: item.id,
      orderedQuantity: Number(item.quantity),
      receivedQuantity: Number(item.receivedQuantity),
      returnedQuantity: returnedByItem.get(item.id) ?? 0,
      // Stock of the line's VARIANT at the receiving location — returns
      // draw from a variant-wide batch pool (shared across sibling lines).
      availableStock: stockByVariant.get(item.variantId) ?? 0,
    })),
  };

  const { landedCostDocStatus, landedCostPending, ...purchaseHeader } = purchase;
  return {
    purchase: {
      ...purchaseHeader,
      landedCostStatus: deriveLandedCostStatus({ landedCostDocStatus, landedCostPending }),
      returnStatus,
      supplierCreditBalance,
    },
    items,
    returnContext,
  };
}

export async function createReceivePurchase(
  businessId: number,
  locationId: number,
  data: ReceiveItemsFormValues,
  actorUserId?: number,
  canOverReceive = false,
) {
  const { purchaseId, items, paymentAmount, paymentMethod, paymentNotes } =
    data;

  // Over-receiving tolerance (migration 0052). Defaults to 0% — every
  // over-receive then requires the purchases.over_receive permission.
  const settings = await getReceivingSettings(businessId);
  const overReceiveOptions = {
    tolerancePercent: settings.overReceiveTolerancePercent,
    canOverReceive,
  };

  return db.transaction(async (tx) => {
    const itemIds = basicRequestValidation(items);
    const purchase = await purchaseValidation(tx, businessId, purchaseId);

    // Lock-order anchor: take the (optional) landed-cost document row lock
    // BEFORE the purchase items, so a concurrent landed-cost post holding
    // the doc lock can never wait on this tx's item locks (deadlock).
    await lockDocumentForPurchaseInTx(tx, businessId, purchaseId);

    // Stamp the receiving location on the purchase header (first receive
    // wins; later partial receives must go to the same location).
    if (purchase.locationId === null) {
      await tx
        .update(purchases)
        .set({ locationId })
        .where(and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)));
    } else if (purchase.locationId !== locationId) {
      throw new ConflictError(
        "This purchase is already being received at another location.",
      );
    }

    const existingItems = await purchaseItemsValidation(
      tx,
      businessId,
      purchaseId,
      itemIds,
    );

    // UOM boundary (migration 0062): convert entered packaging quantities
    // to BASE units once, up front, so every downstream rule keeps its
    // base-unit invariant. Identity lines pass through unchanged.
    const normalizedByItemId = await normalizeReceiveItemsToBase(
      tx,
      businessId,
      existingItems,
      items,
    );

    const receiveItemMap = normalizedByItemId;

    // Per-line decisions, kept for the receiving records + discrepancies.
    const overReceiveDecisions = new Map<
      number,
      { overQuantity: number; withinTolerance: boolean }
    >();

    for (const purchaseItem of existingItems) {
      const receiveItem = receiveItemMap.get(purchaseItem.id);
      if (!receiveItem) {
        throw new NotFoundError(
          `Missing receiving information for purchase item ${purchaseItem.id}.`,
        );
      }
      const decision = receiveItemsValidation(
        purchaseItem,
        receiveItem,
        overReceiveOptions,
      );
      if (decision) {
        overReceiveDecisions.set(purchaseItem.id, decision);
      }

      if (receiveItem.receiveNow > 0 && receiveItem.trackingType === "batch") {
        batchValidation(purchaseItem, receiveItem);
      }

      if (receiveItem.receiveNow > 0 && receiveItem.trackingType === "serial") {
        serialNumberValidation(purchaseItem, receiveItem);
      }
    }

    // Serials are unique per business — reject duplicates before any write
    // so the client gets a clear 400 instead of a raw constraint error.
    await serialAvailabilityValidation(tx, businessId, [
      ...normalizedByItemId.values(),
    ]);

    // Per-delivery audit rows (one per item with any delivered quantity).
    // Rejected goods exist ONLY here — they never reach batches, stock,
    // movements, or valuation.
    const receivingRecordInputs: ReceivingRecordInput[] = [];

    for (const purchaseItem of existingItems) {
      const receiveItem = receiveItemMap.get(purchaseItem.id)!;
      const rejectedQuantity = Number(receiveItem.rejectedQuantity ?? 0);

      if (receiveItem.receiveNow <= 0 && rejectedQuantity <= 0) {
        continue;
      }

      const newReceivedQuantity =
        purchaseItem.receivedQuantity + receiveItem.receiveNow;
      const newDeliveredQuantity =
        Number(purchaseItem.deliveredQuantity ?? 0) +
        receiveItem.receiveNow +
        rejectedQuantity;
      const newRejectedQuantity =
        Number(purchaseItem.rejectedQuantity ?? 0) + rejectedQuantity;

      // D1 (batch-authoritative): the line's unit_cost keeps the PO order
      // cost; this session's cost lands on the batches created below.
      // The ordered `quantity` column is never mutated by receiving.
      await updatePurchaseItems(tx, businessId, purchaseItem.id, {
        receivedQuantity: newReceivedQuantity,
        deliveredQuantity: newDeliveredQuantity,
        rejectedQuantity: newRejectedQuantity,
      });

      const overDecision = overReceiveDecisions.get(purchaseItem.id);

      if (receiveItem.receiveNow > 0 || rejectedQuantity > 0) {
        receivingRecordInputs.push({
          purchaseId,
          purchaseItemId: purchaseItem.id,
          variantId: purchaseItem.variantId,
          locationId,
          acceptedQuantity: receiveItem.receiveNow,
          rejectedQuantity,
          unitCost: receiveItem.unitCost,
          rejectionCategory: receiveItem.rejectionCategory,
          rejectionReason: receiveItem.rejectionReason,
          overReceived: overDecision !== undefined,
          approvalReason: receiveItem.overReceiveReason,
          receivedByUserId: actorUserId ?? 0,
          approvedByUserId: overDecision ? actorUserId : undefined,
          // UOM snapshot: what the operator typed at this session (base
          // figures stay in accepted/rejected/unitCost).
          uomConversionId: receiveItem.uomSnapshot?.conversionId ?? null,
          enteredQuantity: receiveItem.uomSnapshot?.enteredQuantity ?? null,
          enteredUnitPrice: receiveItem.uomSnapshot?.enteredUnitPrice ?? null,
          conversionFactor: receiveItem.uomSnapshot?.conversionFactor ?? null,
        });
      }

      // Only ACCEPTED goods flow into inventory below — rejected goods are
      // never stocked, valued, or payable.
      if (receiveItem.receiveNow <= 0) {
        continue;
      }

      await updateProductVariants(
        tx,
        businessId,
        receiveItem.sellingPrice,
        purchaseItem.variantId,
      );

      await incrementStockForReceive(tx, {
        businessId,
        locationId,
        variantId: purchaseItem.variantId,
        quantity: receiveItem.receiveNow,
      });

      await recordStockMovement(tx, {
        businessId,
        variantId: purchaseItem.variantId,
        locationId,
        movementType: "purchase",
        referenceType: "purchase",
        referenceId: purchaseId,
        quantity: receiveItem.receiveNow,
      });

      const insertedBatches = await insertInventoryBatches(
        tx,
        businessId,
        locationId,
        receiveItem,
        purchaseItem.variantId,
        purchaseItem.id,
      );

      if (receiveItem.trackingType === "serial") {
        const firstBatch = insertedBatches[0];

        if (!firstBatch) {
          throw new Error(
            `No inventory batch was created for purchase item ${purchaseItem.id}.`,
          );
        }

        await insertSerialNumbers(
          tx,
          businessId,
          locationId,
          receiveItem,
          purchaseItem.variantId,
          purchaseItem.id,
          firstBatch.id,
        );
      }
    }

    // Write the audit trail + over-receiving discrepancy records.
    const insertedRecords = await insertReceivingRecords(
      tx,
      businessId,
      receivingRecordInputs,
    );
    const recordIdByItem = new Map(
      insertedRecords.map((row) => [row.purchaseItemId, row.id]),
    );
    const discrepancyRows: (typeof purchaseDiscrepancies.$inferInsert)[] = [
      ...[...overReceiveDecisions.entries()].map(
        ([purchaseItemId, decision]) => ({
          businessId,
          purchaseId,
          purchaseItemId,
          receivingRecordId: recordIdByItem.get(purchaseItemId) ?? null,
          type: "over_receival" as const,
          quantity: decision.overQuantity,
          reason: receiveItemMap.get(purchaseItemId)!.overReceiveReason ?? null,
          status: "resolved" as const,
          resolution: null,
          requestedByUserId: actorUserId ?? 0,
          resolvedByUserId: actorUserId ?? 0,
          resolvedAt: new Date(),
        }),
      ),
    ];

    // Rejected goods (Phase 4): each rejection opens a discrepancy that
    // stays OPEN until a supplier_credit / replacement resolution is
    // recorded. The goods themselves never entered inventory.
    for (const record of receivingRecordInputs) {
      if (record.rejectedQuantity <= 0) continue;
      discrepancyRows.push({
        businessId,
        purchaseId,
        purchaseItemId: record.purchaseItemId,
        receivingRecordId: recordIdByItem.get(record.purchaseItemId) ?? null,
        type: "rejection" as const,
        quantity: record.rejectedQuantity,
        reason: record.rejectionReason ?? null,
        category: record.rejectionCategory ?? null,
        status: "open" as const,
        resolution: null,
        requestedByUserId: actorUserId ?? 0,
        resolvedByUserId: null,
        resolvedAt: null,
      });
    }
    if (discrepancyRows.length > 0) {
      await tx.insert(purchaseDiscrepancies).values(discrepancyRows);
    }
    const discrepancySummary = [...overReceiveDecisions.entries()].map(
      ([purchaseItemId, decision]) => ({
        purchaseItemId,
        type: "over_receival" as const,
        overQuantity: decision.overQuantity,
        withinTolerance: decision.withinTolerance,
      }),
    );

    // Landed-cost delta (Part F): a posted landed-cost document on this
    // purchase adjusts incrementally in the SAME transaction — the new
    // batches are visible to its target recomputation. No-op otherwise.
    // The delta info rides back to the client for the adjustment notice.
    const landedCost = await applyReceiveDeltaInTx(
      tx,
      businessId,
      purchaseId,
      actorUserId ?? 0,
    );

    const allPurchaseItems = await getAllPurchaseItems(
      tx,
      businessId,
      purchaseId,
    );

    const newStatus = calculatePurchaseStatus(allPurchaseItems);

    // Payment limit is based on the value of goods ACTUALLY received
    // (batch-authoritative, D1) capped by the invoice total net of
    // cancelled quantities (Phase 3).
    const receivedAmount = await getPurchaseReceivedAmountInTx(
      tx,
      businessId,
      purchaseId,
    );
    const cancelledAmount = await getPurchaseCancelledValueInTx(
      tx,
      businessId,
      purchaseId,
    );

    const returnedAmount = await getPurchaseReturnedValueInTx(
      tx,
      businessId,
      purchaseId,
    );

    const {
      updatedPaidAmount,
      updatedDueAmount,
      newPaymentAmount,
    } = calculatePayments({
      paidAmount: purchase.paidAmount,
      paymentAmount,
      totalAmount: purchase.totalAmount,
      receivedAmount,
      cancelledAmount,
      returnedAmount,
    });

    const paymentStatus = calculatePaymentStatus(
      updatedPaidAmount,
      purchase.totalAmount,
    );

    // =========================================================
    // 13. UPDATE PURCHASE
    // =========================================================

    await updatePurchase(
      tx,
      newStatus,
      updatedPaidAmount,
      updatedDueAmount,
      paymentStatus,
      businessId,
      purchaseId,
    );

    // =========================================================
    // 14. PAYMENT RECORD
    // =========================================================

    let purchasePaymentId: number | null = null;
    if (newPaymentAmount > 0) {
      purchasePaymentId = await insertPurchasePayments(
        tx,
        businessId,
        purchaseId,
        paymentMethod,
        newPaymentAmount,
        paymentNotes,
      );
    }

    // =========================================================
    // 14b. FINANCE LEDGER POSTING (Finance & Growth Stage 3)
    // Receive: DR 1050 Inventory + DR 1045 VAT input / CR 2010 payable.
    // At-receive payment: DR 2010 / CR cash. Both no-op before Finance
    // activation; idempotent per receiving submission / payment row.
    // =========================================================
    const receiveLineValues = receivingRecordInputs.map((record) => {
      const line = existingItems.find((pi) => pi.id === record.purchaseItemId);
      const ordered = Number(line?.quantity ?? 0);
      const lineTax = Number(line?.tax ?? 0);
      return {
        value: roundMoney(record.acceptedQuantity * record.unitCost),
        vatShare:
          ordered > 0 ? roundMoney(lineTax * (record.acceptedQuantity / ordered)) : 0,
      };
    });
    await postPurchaseReceiveLedgerEntry(tx, {
      businessId,
      purchaseId,
      receiveEventId:
        receiveLineValues.length > 0 && recordIdByItem.size > 0
          ? Math.min(...recordIdByItem.values())
          : null,
      lines: receiveLineValues,
      locationId,
      actorUserId: actorUserId ?? null,
    });
    if (purchasePaymentId != null) {
      await postPurchasePaymentLedgerEntry(tx, {
        businessId,
        paymentId: purchasePaymentId,
        purchaseId,
        amount: newPaymentAmount,
        method: paymentMethod,
        locationId,
        actorUserId: actorUserId ?? null,
      });
    }

    // =========================================================
    // 15. PRICE-INCREASE ALERTS (Smart Procurement)
    // Factual supplier price monitoring: compares each received line's
    // actual unit cost against this supplier's previous actual price for
    // the variant; records a deduplicated notification when the business's
    // configured threshold is met. Runs inside this transaction but never
    // blocks a legitimate receive.
    // =========================================================

    try {
      await checkPriceIncreasesInTx(tx, {
        businessId,
        purchaseId,
        supplierId: purchase.supplierId,
        items: items.map((receiveItem) => ({
          variantId:
            existingItems.find((pi) => pi.id === receiveItem.itemId)?.variantId ?? 0,
          unitCost: receiveItem.unitCost,
          receiveNow: receiveItem.receiveNow,
        })),
      });
    } catch (alertError) {
      console.error("Price-increase alert check failed:", alertError);
    }

    // =========================================================
    // 15. RETURN
    // =========================================================

    // Unified mutation envelope ({success, message, data}) — the same shape
    // the purchase-return endpoint uses.
    return {
      success: true,
      message:
        newStatus === "received"
          ? "Purchase completely received."
          : "Purchase partially received.",
      data: {
        purchaseId,
        status: newStatus,
        receivedAmount,
        paidAmount: updatedPaidAmount,
        dueAmount: updatedDueAmount,
        // Authoritative landed-cost feedback: whether a posted document
        // adjusted, by how much, and which document. The frontend renders
        // this as a notice — it never computes landed-cost amounts itself.
        landedCost,
        // Over-receiving outcome per line (empty for normal receives).
        discrepancies: discrepancySummary,
      },
    };
  });
}
