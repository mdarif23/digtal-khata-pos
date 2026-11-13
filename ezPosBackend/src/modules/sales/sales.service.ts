import {
  and,
  asc,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { products } from "../../db/schema/products.js";
import { categories } from "../../db/schema/categories.js";
import { saleItems } from "../../db/schema/saleItems.js";
import { sales } from "../../db/schema/sales.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { variantOptions } from "../../db/schema/variantOptions.js";
import { variantValues } from "../../db/schema/variantValues.js";
import type { saleDataInput } from "../../types/sales-types.js";
import { salePayments } from "../../db/schema/salePayments.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../utils/handleError.js";
import { saleRefunds } from "../../db/schema/saleRefunds.js";
import { saleItemBatchConsumptions } from "../../db/schema/saleItemBatchConsumptions.js";
import { saleRefundItems } from "../../db/schema/saleRefundItems.js";
import {
  postRefundLedgerEntry,
  postSaleLedgerEntry,
} from "./sales.ledger.js";
import {
  type DashboardPeriod,
  getExpensesSummary,
  getInvoiceDues,
  getLowStockSummary,
  getNetProfit,
  getPaymentBreakdown,
  getProductsSummary,
  getProfitByCategory,
  getPurchasesSummary,
  getRecentSalesSummary,
  getReturnSummary,
  getSalesOverview,
  getSalesActivity,
  getSalesSummary,
  getStaleStockSummary,
  getTopCategories,
  getTopItemsByGross,
  getTopSellingProducts,
} from "./dashboardMatrix.service.js";
import type { CreateSalePayload } from "./schemas/sales.schema.js";
import { normalizeSaleItemsToBase } from "./sales.uom.js";
import type { SaleRefundRequest } from "./schemas/sales.schema.js";
import { customers } from "../../db/schema/customers.js";
import { recordAuditInTx, recordAudit } from "../../services/audit.js";
import { recordOrderEventInTx } from "../commerce/orderTimeline.service.js";
import { salePaymentIntents } from "../../db/schema/salePaymentIntents.js";
import { resolveIntentProvider } from "../../services/payments/saleProviders.js";
import {
  foldVariantOptionRows,
  variantNameFromMap,
  variantOptionsFromMap,
} from "../../utils/variantDisplay.js";
import {
  consumeStoreCreditInTx,
  grantStoreCreditInTx,
} from "../../services/storeCredit.js";
import { promotionUsage } from "../../db/schema/pricing.js";
import { businessMemberships } from "../../db/schema/businessMemberships.js";
import { getBomsForVariants } from "../bom/bom.service.js";
import {
  calculateCommissionsForSaleInTx,
  reverseCommissionsForRefundInTx,
} from "../commission/commission.service.js";
import {
  computeEligibleEarnBaseInTx,
  earnLoyaltyPointsInTx,
  getEarnRule,
  recordLoyaltySpendInTx,
  redeemLoyaltyPointsInTx,
  restoreRedeemedPointsInTx,
  reverseLoyaltyPointsInTx,
} from "../../services/loyalty.js";
import { redeemGiftCardInTx } from "../../services/giftCards.js";
import {
  evaluateCouponInTx,
  recordCouponRedemptionInTx,
} from "../../services/coupons.js";
import { notifyStockLevel } from "../../services/notifications.js";
import { publishRealtime } from "../realtime/realtime.service.js";
import { sha256OfJson } from "../../utils/canonicalJson.js";
import {
  customerValidation,
  validatePayments,
  validateStock,
  validateVariants,
  type Items,
} from "./sales.validation.js";
import { roundMoney } from "../../utils/roundMoney.js";
import {
  assertOpenDrawerForCashInTx,
  recordCashRefundInTx,
  recordCashSaleInTx,
} from "../cashRegisters/cashRegisters.service.js";
import {
  consumeApprovalInTx,
  isApprovalRequired,
} from "../../services/managerApproval.js";
import { getRequireOpenDrawer } from "../posSettings/posSettings.service.js";
import { units } from "../../db/schema/units.js";
import { alias } from "drizzle-orm/pg-core";
import { productUnitConversions } from "../../db/schema/productUnitConversions.js";

/** The units table aliased for the ENTERED unit join on UOM sale lines. */
const enteredUnits = alias(units, "entered_units");
import { users } from "../../db/schema/users.js";
import {
  getDocumentBranding,
  getDocumentSettings,
} from "../documentSettings/documentSettings.service.js";
import {
  getCartTotals,
  getCartTotalsWithTaxRules,
  getLinePricing,
  lineChargeAfterAllocations,
  type DiscountInput,
  type TaxRuleSnapshot,
} from "./utils/cartPricing.js";
import {
  evaluateSaleGroupPricing,
  toCartGroupInput,
} from "../pricing/pricing.salePricing.js";
import {
  evaluateSalePromotions,
  toCartPromotionInput,
} from "../pricing/pricing.salePromotions.js";
import { evaluateMinimumFloors } from "../pricing/pricing.saleFloors.js";
import { taxRates } from "../../db/schema/taxRates.js";
import { productTaxes } from "../../db/schema/productTaxes.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { pushRefundStatusAfterCommit } from "../../modules/integrations/integrations.service.js";
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import type { DbTransaction } from "../purchases/purchase.types.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import {
  applyRefundWarrantyEffects,
  createWarrantiesForSaleItems,
  voidWarrantiesForSale,
  type WarrantyGenerationItem,
} from "../warranty/warrantyEngine.service.js";
import {
  getSerialsForSale,
  getWarrantiesForSale,
} from "../warranty/warranty.service.js";
import {
  formatSaleInvoiceNumber,
  nextDocumentNumber,
} from "../../utils/documentSequence.js";

// Every function takes the caller's server-verified businessId (from
// requireBusinessContext) and scopes all reads and writes to it.

function isDuplicatePaymentReferenceError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const cause = "cause" in error ? error.cause : error;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "23505" &&
    "constraint" in cause &&
    cause.constraint === "sale_payments_business_method_reference_unique"
  );
}

export async function getSalesData(businessId: number) {
  const rows = await db
    .select({
      saleId: sales.id,
      invoiceNumber: sales.invoiceNumber,
      saleTotal: sales.finalTotal,
      paymentStatus: sales.paymentStatus,
      saleStatus: sales.status,
      customerName: customers.name,
      saleItemsId: saleItems.id,
      id: products.id,
      variantId: productVariants.id,
      productName: products.name,
      // Returned to the frontend so the partial-return UI can keep serial
      // lines whole (a partial serial return requires a serial selection).
      trackingType: products.trackingType,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      category: categories.name,
      cost: saleItems.costAtSale,
      price: productVariants.sellingPrice,
      soldQuantity: saleItems.quantity,
      soldPrice: saleItems.sellingPrice,
      lineTotal: saleItems.lineTotal,
      // UOM snapshot (migration 0062): sold-products can show "2 Box"
      // instead of "24 pcs" for packaging-unit lines.
      enteredQuantity: saleItems.enteredQuantity,
      enteredUnitPrice: saleItems.enteredUnitPrice,
      conversionFactor: saleItems.conversionFactor,
      unitAbbreviation: units.abbreviation,
      createdAt: sales.createdAt,
    })
    .from(saleItems)
    .innerJoin(sales, eq(saleItems.saleId, sales.id))
    .innerJoin(productVariants, eq(saleItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(units, eq(products.unitId, units.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(customers, eq(sales.customerId, customers.id))
    .where(
      and(
        inArray(sales.status, ["completed", "refunded"]),
        eq(sales.businessId, businessId),
      ),
    );

  if (rows.length === 0) return [];

  // Variant option labels (one batched query for every variant on the page —
  // joining variant_values directly would fan the item rows out per option).
  const variantIds = [...new Set(rows.map((row) => row.variantId))];
  const optRows = await db
    .select({
      variantId: variantValues.variantId,
      value: variantOptions.value,
    })
    .from(variantValues)
    .innerJoin(variantOptions, eq(variantValues.optionId, variantOptions.id))
    .where(inArray(variantValues.variantId, variantIds))
    .orderBy(asc(variantValues.optionId));
  const optionsByVariant = foldVariantOptionRows(optRows);

  const returnedRows = await db
    .select({
      saleItemId: saleRefundItems.saleItemId,
      quantity: saleRefundItems.quantity,
      reason: saleRefunds.reason,
      disposition: saleRefunds.status,
    })
    .from(saleRefundItems)
    .innerJoin(saleRefunds, eq(saleRefundItems.refundId, saleRefunds.id))
    .where(
      and(
        eq(saleRefundItems.businessId, businessId),
        inArray(
          saleRefundItems.saleItemId,
          rows.map((row) => row.saleItemsId),
        ),
      ),
    );

  const returnsByItem = new Map<
    number,
    { quantity: number; reasons: string[]; dispositions: string[] }
  >();
  for (const returned of returnedRows) {
    if (returned.saleItemId === null) continue;
    const current = returnsByItem.get(returned.saleItemId) ?? {
      quantity: 0,
      reasons: [],
      dispositions: [],
    };
    current.quantity += returned.quantity ?? 0;
    if (returned.reason) current.reasons.push(returned.reason);
    if (returned.disposition) current.dispositions.push(returned.disposition);
    returnsByItem.set(returned.saleItemId, current);
  }

  return rows.map((row) => {
    const returned = returnsByItem.get(row.saleItemsId);
    return {
      ...row,
      variantOptions: variantOptionsFromMap(optionsByVariant, row.variantId),
      variantName: variantNameFromMap(optionsByVariant, row.variantId, row.productName),
      returnedQuantity: returned?.quantity ?? 0,
      returnReason: returned?.reasons.join(", ") ?? null,
      returnDisposition: returned?.dispositions.at(-1) ?? null,
      trackingType: row.trackingType,
    };
  });
}
export async function calculateSubtotals(
  existingVariants: {
    id: number;
    sellingPrice: number;
  }[],
  items: Items[],
) {
  const variantMap = new Map(existingVariants.map((v) => [v.id, v]));

  const subTotal = items.reduce((sum, item) => {
    const variant = variantMap.get(item.variantId);
    if (!variant) {
      throw new Error(`Variant ${item.variantId} not found`);
    }
    return sum + item.quantity * Number(variant.sellingPrice);
  }, 0);
  return roundMoney(subTotal);
}

export type BatchConsumption = { batchId: number; quantity: number; unitCost: number };

/**
 * Persists the per-batch detail of a sale line's FIFO consumption (Q2).
 * The cost snapshot on sale_items stays the blended average — these rows
 * carry WHICH batch each unit came from and its effective unit cost, so a
 * later landed-cost adjustment can split exactly between remaining stock
 * and already-sold units (Part F). Additive only; zero behavior change.
 */
export async function insertSaleItemConsumptions(
  tx: DbTransaction,
  businessId: number,
  saleId: number,
  saleItemId: number,
  variantId: number,
  consumed: BatchConsumption[],
) {
  if (consumed.length === 0) return;
  await tx.insert(saleItemBatchConsumptions).values(
    consumed.map((c) => ({
      businessId,
      saleId,
      saleItemId,
      batchId: c.batchId,
      variantId,
      quantity: c.quantity,
      unitCostAtConsumption: c.unitCost,
    })),
  );
}

export async function consumeStockFifo(
  tx: DbTransaction,
  businessId: number,
  locationId: number,
  variantId: number,
  quantity: number,
  opts: { allowShortfall?: boolean } = {},
) {
  // 1. Oldest batches first. .for("update") locks the rows, so two sales
  //    at the same moment can't take the same stock. FIFO is per-location:
  //    a sale only consumes batches stocked at its own location.
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
      landedCostPerUnit: inventoryBatches.landedCostPerUnit,
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
        eq(inventoryBatches.locationId, locationId),
        gt(inventoryBatches.quantityRemaining, 0),
      ),
    )
    .orderBy(asc(inventoryBatches.id))
    .for("update");

  let remaining = quantity;
  let totalCost = 0;
  const consumed: { batchId: number; quantity: number; unitCost: number }[] = [];

  // 2. Take from each batch until the quantity is covered
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

    // Effective cost = original purchase + landed additions (equal to
    // purchase_price while no landed cost has been allocated — zero-diff).
    const unitCost = Number(batch.landedCostPerUnit ?? batch.purchasePrice);
    totalCost += take * unitCost;
    consumed.push({ batchId: batch.id, quantity: take, unitCost });
    remaining -= take;
  }

  // 3. Not enough stock: throwing rolls back the whole sale transaction.
  //    ConflictError (409), not a bare 500 — offline terminals must be able
  //    to distinguish "no stock" from "server bug" when they replay.
  //    Offline-originated sales are different: the sale PHYSICALLY happened,
  //    so with allowShortfall the batches are consumed as far as possible and
  //    the gap is returned for a sync_conflicts row (never silently lost).
  if (remaining > 0 && !opts.allowShortfall) {
    throw new ConflictError(
      `Insufficient stock for variant ${variantId}: short by ${remaining}`,
    );
  }

  return {
    totalCost: roundMoney(totalCost),
    costAtSale: roundMoney(totalCost / quantity), // average cost per unit
    consumed,
    ...(remaining > 0 ? { shortfall: remaining } : {}),
  };
}
export async function consumeSerials(
  tx: DbTransaction,
  businessId: number,
  variantId: number,
  serials: string[],
) {
  if (serials.length === 0)
    throw new BadRequestError("Select at least one serial number");
  if (new Set(serials).size !== serials.length)
    throw new BadRequestError("Duplicate serial number");

  // 1. Find and lock the serials (must be in stock, for this variant and business)
  const rows = await tx
    .select()
    .from(serialNumbers)
    .where(
      and(
        eq(serialNumbers.variantId, variantId),
        eq(serialNumbers.businessId, businessId),
        inArray(serialNumbers.serialNumber, serials),
        eq(serialNumbers.status, "in_stock"),
      ),
    )
    .for("update");

  if (rows.length !== serials.length) {
    // 409, not 500: an already-sold/unknown serial is a client-facing
    // conflict (offline replay safety — see consumeStockFifo above).
    throw new ConflictError("One or more serial numbers are not available");
  }
  if (rows.some((r) => r.batchId == null)) {
    throw new Error("A serial number has no batch. Backfill it first.");
  }

  // 2. Count how many units come from each batch
  const perBatch = new Map<number, number>();
  for (const r of rows) {
    perBatch.set(r.batchId!, (perBatch.get(r.batchId!) ?? 0) + 1);
  }

  // 3. Lock those batches, reduce stock, add up the cost
  const batches = await tx
    .select({
      id: inventoryBatches.id,
      businessId: inventoryBatches.businessId,
      variantId: inventoryBatches.variantId,
      locationId: inventoryBatches.locationId,
      purchaseItemId: inventoryBatches.purchaseItemId,
      batchNumber: inventoryBatches.batchNumber,
      purchasePrice: inventoryBatches.purchasePrice,
      landedCostPerUnit: inventoryBatches.landedCostPerUnit,
      quantityReceived: inventoryBatches.quantityReceived,
      quantityRemaining: inventoryBatches.quantityRemaining,
      manufacturedDate: inventoryBatches.manufacturedDate,
      expiryDate: inventoryBatches.expiryDate,
    })
    .from(inventoryBatches)
    .where(
      and(
        inArray(inventoryBatches.id, [...perBatch.keys()]),
        eq(inventoryBatches.businessId, businessId),
      ),
    )
    .for("update");

  let totalCost = 0;
  const used: { batchId: number; quantity: number; unitCost: number }[] = [];

  for (const batch of batches) {
    const take = perBatch.get(batch.id)!;
    if (batch.quantityRemaining < take) {
      throw new Error(`Batch ${batch.id} has less stock than expected`);
    }

    await tx
      .update(inventoryBatches)
      .set({ quantityRemaining: batch.quantityRemaining - take })
      .where(
        and(
          eq(inventoryBatches.id, batch.id),
          eq(inventoryBatches.businessId, businessId),
        ),
      );

    totalCost += take * Number(batch.landedCostPerUnit ?? batch.purchasePrice);
    used.push({
      batchId: batch.id,
      quantity: take,
      unitCost: batch.purchasePrice,
    });
  }

  // 4. Mark as sold now. saleItemId is linked after the sale_items insert.
  const serialIds = rows.map((r) => r.id);
  await tx
    .update(serialNumbers)
    .set({ status: "sold", soldAt: new Date() })
    .where(inArray(serialNumbers.id, serialIds));

  return {
    totalCost: roundMoney(totalCost),
    costAtSale: roundMoney(totalCost / serials.length),
    used,
    serialIds,
  };
}
function getPaymentStatus(paid: number, due: number) {
  if (due <= 0) return "paid";
  if (paid > 0) return "partial";
  return "unpaid";
}

/** Per-line warranty summary embedded in the receipt payload. */
interface WarrantyReceiptSummary {
  warrantyNumber: string;
  provider: string;
  warrantyType: string;
  duration: number;
  durationUnit: string;
  startDate: Date;
  validUntil: Date;
}

export async function getSaleReceipt(businessId: number, saleId: number) {
  const [sale] = await db
    .select({
      id: sales.id,
      invoiceNumber: sales.invoiceNumber,
      saleDate: sales.saleDate,
      createdAt: sales.createdAt,
      subtotal: sales.subtotal,
      discount: sales.discount,
      vat: sales.vat,
      finalTotal: sales.finalTotal,
      dueAmount: sales.dueAmount,
      paymentStatus: sales.paymentStatus,
      note: sales.note,
      customerId: sales.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerAddress: customers.address,
      cashierName: users.fullName,
    })
    .from(sales)
    .leftJoin(customers, eq(sales.customerId, customers.id))
    .leftJoin(users, eq(sales.cashierUserId, users.id))
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .limit(1);

  if (!sale) {
    throw new NotFoundError(`Sale #${saleId} not found`);
  }

  const items = await db
    .select({
      id: saleItems.id,
      variantId: saleItems.variantId,
      productName: products.name,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      quantity: saleItems.quantity,
      unitPrice: saleItems.sellingPrice,
      discount: saleItems.discount,
      lineTotal: saleItems.lineTotal,
      taxAmount: saleItems.taxAmount,
      taxDetail: saleItems.taxDetail,
      // Discount attribution snapshots (Phases 4-6): the receipt/invoice
      // renders the automatic group + promotion lines and override notes.
      priceAdjustments: saleItems.priceAdjustments,
      unitName: units.abbreviation,
      // UOM snapshot (migration 0062): receipts can show "1 Box" instead of
      // "12 pcs" when the line was sold in a packaging unit.
      enteredQuantity: saleItems.enteredQuantity,
      enteredUnitPrice: saleItems.enteredUnitPrice,
      conversionFactor: saleItems.conversionFactor,
      enteredUnitAbbreviation: enteredUnits.abbreviation,
    })
    .from(saleItems)
    .innerJoin(productVariants, eq(saleItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(units, eq(products.unitId, units.id))
    .leftJoin(
      productUnitConversions,
      and(
        eq(productUnitConversions.id, saleItems.uomConversionId),
        eq(productUnitConversions.businessId, saleItems.businessId),
      ),
    )
    .leftJoin(
      enteredUnits,
      eq(enteredUnits.id, productUnitConversions.unitId),
    )
    .where(
      and(
        eq(saleItems.saleId, saleId),
        eq(saleItems.businessId, businessId),
      ),
    )
    .orderBy(asc(saleItems.id));

  const variantIds = items.map((i) => i.variantId);
  let optionsMap = new Map<number, string[]>();

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
    optionsMap = foldVariantOptionRows(optRows);
  }

  const payments = await db
    .select({
      id: salePayments.id,
      method: salePayments.paymentMethod,
      amount: salePayments.amount,
      tendered: salePayments.tendered,
      reference: salePayments.reference,
      paymentDate: salePayments.paymentDate,
    })
    .from(salePayments)
    .where(
      and(
        eq(salePayments.saleId, saleId),
        eq(salePayments.businessId, businessId),
      ),
    )
    .orderBy(asc(salePayments.id));

  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
  const change = payments.reduce((max, p) => {
    if (p.method === 'cash' && p.tendered != null) {
      const diff = Number(p.tendered) - Number(p.amount);
      return diff > 0 ? diff : max;
    }
    return max;
  }, 0);

  // Document branding + active templates ride along with every receipt, so
  // the printed output always matches the business's saved customization.
  // Financial values above stay sourced from the immutable sale rows.
  const [branding, documentSettings] = await Promise.all([
    getDocumentBranding(businessId),
    getDocumentSettings(businessId),
  ]);

  // Warranty enrichment (migration 0064): per-line serial texts + warranty
  // snapshots so receipts/invoices can print warranty sub-lines. Additive —
  // consumers that don't know the fields ignore them.
  const [serialRows, warrantyRows] = await Promise.all([
    getSerialsForSale(businessId, saleId),
    getWarrantiesForSale(businessId, saleId),
  ]);
  const serialsByItem = new Map<number, string[]>();
  for (const row of serialRows) {
    if (row.saleItemId == null) continue;
    const list = serialsByItem.get(row.saleItemId) ?? [];
    list.push(row.serialNumber);
    serialsByItem.set(row.saleItemId, list);
  }
  const warrantyByItem = new Map<number, WarrantyReceiptSummary>();
  for (const row of warrantyRows) {
    // First warranty per line is the display row (quantity lines have one;
    // serial lines share the same terms per unit).
    if (!warrantyByItem.has(row.saleItemId)) {
      warrantyByItem.set(row.saleItemId, {
        warrantyNumber: row.warrantyNumber,
        provider: row.provider,
        warrantyType: row.warrantyType,
        duration: row.duration,
        durationUnit: row.durationUnit,
        startDate: row.startDate,
        validUntil: row.expiryDate,
      });
    }
  }

  return {
    saleId: sale.id,
    invoiceNumber: sale.invoiceNumber,
    saleDate: sale.saleDate,
    createdAt: sale.createdAt,
    cashierName: sale.cashierName ?? null,
    customer: sale.customerId
      ? {
          id: sale.customerId,
          name: sale.customerName ?? 'Customer',
          phone: sale.customerPhone ?? null,
          address: sale.customerAddress ?? null,
        }
      : null,
    business: branding,
    documentSettings,
    items: items.map((item) => {
      const optLabel = variantOptionsFromMap(optionsMap, item.variantId);
      const variantName = optLabel !== "" ? optLabel : (item.sku || null);
      return {
        id: item.id,
        variantId: item.variantId,
        productName: item.productName,
        variantName,
        sku: item.sku,
        barcode: item.barcode,
        unitName: item.unitName ?? null,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
        discount: Number(item.discount),
        lineTotal: Number(item.lineTotal),
        taxAmount: Number(item.taxAmount),
        taxDetail: item.taxDetail,
        // Attribution snapshots for the receipt breakdown (Phases 4-6).
        priceAdjustments: item.priceAdjustments ?? [],
        // UOM snapshot (migration 0062): receipts can show "1 Box" instead
        // of "12 pcs" when the line was sold in a packaging unit.
        enteredQuantity: item.enteredQuantity == null ? null : Number(item.enteredQuantity),
        enteredUnitPrice: item.enteredUnitPrice == null ? null : Number(item.enteredUnitPrice),
        conversionFactor: item.conversionFactor == null ? null : Number(item.conversionFactor),
        enteredUnitAbbreviation: item.enteredUnitAbbreviation ?? null,
        serialNumbers: serialsByItem.get(item.id) ?? undefined,
        warranty: warrantyByItem.get(item.id) ?? undefined,
      };
    }),
    subtotal: Number(sale.subtotal ?? 0),
    discount: Number(sale.discount ?? 0),
    vat: Number(sale.vat ?? 0),
    finalTotal: Number(sale.finalTotal ?? 0),
    dueAmount: Number(sale.dueAmount ?? 0),
    paidAmount: Number(totalPaid),
    change: Number(change),
    paymentStatus: sale.paymentStatus,
    note: sale.note,
    payments: payments.map((p) => ({
      id: p.id,
      method: p.method,
      amount: Number(p.amount),
      tendered: p.tendered != null ? Number(p.tendered) : null,
      reference: p.reference,
      paymentDate: p.paymentDate,
    })),
  };
}

/**
 * Resolves an idempotent checkout replay: rebuilds the same response shape
 * as a fresh createSale from the already-committed sale. `paidAmount` and
 * `change` are re-derived from the stored payment rows so the response is
 * truthful about what was actually recorded.
 */
async function findSaleByIdempotencyKey(
  tx: DbTransaction,
  businessId: number,
  idempotencyKey: string,
  expectedPayloadHash?: string | null,
) {
  const [sale] = await tx
    .select({
      id: sales.id,
      invoiceNumber: sales.invoiceNumber,
      subtotal: sales.subtotal,
      discount: sales.discount,
      vat: sales.vat,
      finalTotal: sales.finalTotal,
      dueAmount: sales.dueAmount,
      paymentStatus: sales.paymentStatus,
      idempotencyPayloadHash: sales.idempotencyPayloadHash,
    })
    .from(sales)
    .where(
      and(
        eq(sales.businessId, businessId),
        eq(sales.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!sale) return null;
  // Payload binding: a key reused with DIFFERENT sale data is a client bug
  // (or tampering) — never silently hand back the first sale. Legacy rows
  // (hash NULL) keep the old replay behavior.
  if (
    expectedPayloadHash &&
    sale.idempotencyPayloadHash &&
    sale.idempotencyPayloadHash !== expectedPayloadHash
  ) {
    throw new ConflictError(
      "This idempotency key was already used with different sale data. Refusing to replay it.",
    );
  }
  const payments = await tx
    .select({ amount: salePayments.amount })
    .from(salePayments)
    .where(
      and(
        eq(salePayments.saleId, sale.id),
        eq(salePayments.businessId, businessId),
      ),
    );
  const paidAmount = payments.reduce(
    (sum, p) => sum + Number(p.amount ?? 0),
    0,
  );
  return {
    sale,
    change: roundMoney(Math.max(0, paidAmount - Number(sale.finalTotal))),
    paidAmount: roundMoney(paidAmount),
    dueAmount: Number(sale.dueAmount),
  };
}

/**
 * Resolves the tax rules in effect for each variant at transaction time:
 * product assignments → active rates whose location scope and effective
 * dates (matched against saleDate) qualify. The result drives server-side
 * tax computation AND the per-line historical snapshot — the live
 * tax_rates rows are never consulted for money math after this point.
 */
async function resolveTaxRulesForSale(
  tx: DbTransaction,
  businessId: number,
  locationId: number,
  saleDate: Date,
  variantIds: number[],
): Promise<Map<number, TaxRuleSnapshot[]>> {
  const map = new Map<number, TaxRuleSnapshot[]>();
  if (variantIds.length === 0) return map;
  const saleDateStr = saleDate.toISOString().slice(0, 10);
  const rows = await tx
    .select({
      variantId: productVariants.id,
      taxRateId: taxRates.id,
      name: taxRates.name,
      rate: taxRates.rate,
      isInclusive: taxRates.isInclusive,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(productTaxes, eq(productTaxes.productId, products.id))
    .innerJoin(taxRates, eq(taxRates.id, productTaxes.taxRateId))
    .where(
      and(
        eq(productVariants.businessId, businessId),
        inArray(productVariants.id, variantIds),
        eq(taxRates.businessId, businessId),
        eq(taxRates.isActive, true),
        or(isNull(taxRates.locationId), eq(taxRates.locationId, locationId)),
        or(isNull(taxRates.validFrom), lte(taxRates.validFrom, saleDateStr)),
        or(isNull(taxRates.validTo), gte(taxRates.validTo, saleDateStr)),
      ),
    );
  for (const row of rows) {
    const list = map.get(row.variantId) ?? [];
    list.push({
      taxRateId: row.taxRateId,
      name: row.name,
      rate: Number(row.rate),
      isInclusive: row.isInclusive,
    });
    map.set(row.variantId, list);
  }
  return map;
}

/** CreateSaleOptions: extra context for non-POS invocations of the engine. */
export interface CreateSaleOptions {
  /** 'offline' marks a LAN-server replica applied through /api/sync/ops. */
  channel?: "pos" | "offline";
  /**
   * Offline-originated sales (Phase 3) may exceed stock: the sale PHYSICALLY
   * happened, so it must never be dropped at sync time — inventory is
   * allowed to go negative and a sync_conflicts row flags it for manager
   * review. Oversell prevention itself happens at sale time via the
   * allocation gates, not here.
   */
  allowNegativeStock?: boolean;
  /**
   * Phase 6: the controller passes callerHasPermission(req,
   * 'pricing.below_minimum_override'). False (default) blocks sales whose
   * lines land below the minimum floors; true allows them with a mandatory
   * reason recorded on the line snapshots and the audit log.
   */
  allowBelowMinimum?: boolean;
}

export async function createSale(
  businessId: number,
  locationId: number,
  cashierUserId: number | null,
  data: CreateSalePayload,
  terminalId: number | null = null,
  options: CreateSaleOptions = {},
) {
  const { customerId, items, discount, vatPercent, payments, saleDate } = data;
  // Phase 5 (Feature 13): salesperson attribution — validated at insert.
  const salespersonUserId = data.salespersonUserId ?? null;
  const couponCode = data.couponCode?.trim() || null;
  const idempotencyKey = data.idempotencyKey?.trim() || null;
  // Binds the idempotency key to THIS payload so a replay with different
  // sale data cannot masquerade as a retry (see findSaleByIdempotencyKey).
  // The approval token is excluded: a retry after a timeout may legitimately
  // carry a freshly minted token — that must still resolve to the SAME sale,
  // not a duplicate.
  const { approvalToken: _approvalToken, ...idempotencyPayload } = data;
  void _approvalToken;
  const payloadHash = idempotencyKey ? sha256OfJson(idempotencyPayload) : null;
  const batchShortfalls: { variantId: number; qty: number }[] = [];

  const result = await db.transaction(async (tx) => {
    // 0. Idempotent checkout: a retried submission with the same key returns
    // the original sale instead of creating a duplicate. The composite
    // (business_id, idempotency_key) unique constraint backstops the race
    // the pre-check cannot cover — a losing concurrent insert conflicts,
    // and the caller below refetches and replays the winner.
    if (idempotencyKey) {
      const replay = await findSaleByIdempotencyKey(
        tx,
        businessId,
        idempotencyKey,
        payloadHash,
      );
      if (replay) return replay;
    }

    // 1. Validate customer (same business only).
    await customerValidation(tx, businessId, customerId);

    // 2. Validate variants and lock their rows (same business only).
    const { variantIds, existingVariants } = await validateVariants(
      tx,
      businessId,
      items,
    );

    // UOM boundary (migration 0062): convert entered selling units to
    // base-unit lines ONCE. quantity/unitPrice on every line below are
    // BASE figures; the entered unit is preserved as an immutable
    // snapshot. Identity payloads pass through untouched.
    const baseItems = await normalizeSaleItemsToBase(
      tx,
      businessId,
      existingVariants,
      items,
    );

    // 3. Lock inventory rows and validate stock (aggregated base demand).
    // Phase 4 (Feature 9): composite variants consume their BOM components
    // (assemble-on-sale) — their OWN stock is not validated here; component
    // availability is enforced in the consumption loop.
    const bomByVariant = await getBomsForVariants(
      businessId,
      baseItems.map((i) => i.variantId),
    );

    await validateStock(tx, businessId, locationId, variantIds, baseItems, {
      ...(options.allowNegativeStock ? { allowNegative: true } : {}),
      skipVariants: [...bomByVariant.keys()],
    });

    // 2. Trusted prices and tracking types come from the database
    const variantMap = new Map(existingVariants.map((v) => [v.id, v]));

    const trustedItems = baseItems
      .map((item) => {
        const variant = variantMap.get(item.variantId);
        const unitPrice = item.unitPrice;
        if (!variant || !Number.isFinite(unitPrice) || unitPrice < 0) {
          throw new NotFoundError(
            `Valid selling price not found for variant ${item.variantId}.`,
          );
        }
        return {
          ...item,
          unitPrice,
          trackingType: variant.trackingType,
          productId: variant.productId,
        };
      })
      .sort((a, b) => a.variantId - b.variantId); // same lock order for every cashier

    // Phase 4 (Feature 10): identity (base-unit) lines must be whole
    // numbers UNLESS the variant is sold by weight (scale/PLU selling).
    for (const item of trustedItems) {
      const variant = variantMap.get(item.variantId);
      if (
        !variant?.soldByWeight &&
        item.uomSnapshot?.conversionId == null &&
        !Number.isInteger(item.quantity)
      ) {
        throw new BadRequestError(
          `Quantity must be a whole number for variant ${item.variantId} (not sold by weight).`,
        );
      }
    }

    // 5. Calculate every total from the same trusted items. When any line's
    // product carries tax rules, VAT comes from those rules (server-side,
    // snapshotted per line) and the legacy cart-wide vatPercent is not
    // applied at all — mixing the two semantics would double-tax.
    const taxRulesByVariant = await resolveTaxRulesForSale(
      tx,
      businessId,
      locationId,
      new Date(saleDate),
      trustedItems.map((i) => i.variantId),
    );
    const usesTaxRules = [...taxRulesByVariant.values()].some(
      (rules) => rules.length > 0,
    );
    // Customer-group layer (Phase 4): automatic, computed BEFORE the manual
    // cart discount (stacking policy — approved report §6). Empty for
    // walk-ins and customers without an active group → zero behavior change.
    const groupPricing = await evaluateSaleGroupPricing(
      tx,
      businessId,
      customerId,
      trustedItems,
    );
    const groupInput = toCartGroupInput(groupPricing);
    // Promotion layer (Phase 5): auto-applied, priced on the POST-GROUP
    // bases; a coupon in the cart suppresses non-stacking promotions.
    const promoEvaluation = await evaluateSalePromotions(
      tx,
      businessId,
      trustedItems,
      groupPricing,
      Boolean(couponCode),
      { locationId, customerId },
    );
    const promoInput = toCartPromotionInput(promoEvaluation);
    const totals = usesTaxRules
      ? getCartTotalsWithTaxRules(trustedItems, discount, taxRulesByVariant, groupInput, promoInput)
      : getCartTotals(trustedItems, discount, Number(vatPercent ?? 0), groupInput, promoInput);
    const lineTaxes = "perLine" in totals ? totals.perLine : null;
    // Self-describing snapshots: promotion names by id for price_adjustments.
    const promoNameById = new Map(
      promoEvaluation.applied.map((p) => [p.id, p.name] as const),
    );

    // Minimum-price protection (Phase 6): a line whose effective per-base
    // charge (after line discount and the group/promotion/manual layers)
    // lands below `product_variants.min_selling_price` or the business-wide
    // `pricing_settings.min_margin_percent` floor is BLOCKED unless the
    // caller holds pricing.below_minimum_override — then a reason is
    // mandatory and recorded on the line snapshots + audit log.
    const lineCharges = lineChargeAfterAllocations(trustedItems, totals);
    const floorViolations = await evaluateMinimumFloors(
      tx,
      businessId,
      trustedItems.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
        minSellingPrice:
          variantMap.get(item.variantId)?.minSellingPrice == null
            ? null
            : Number(variantMap.get(item.variantId)!.minSellingPrice),
      })),
      lineCharges,
    );
    const payloadBelowMinimumReason = data.belowMinimumReason?.trim() || null;
    let belowMinimumApprovedBy: number | null = null;
    if (floorViolations.length > 0) {
      if (!options.allowBelowMinimum) {
        throw new BadRequestError(
          `Sale blocked: ${floorViolations.length} line(s) priced below the minimum — ${floorViolations
            .map((v) => `variant ${v.variantId}: ${v.message}`)
            .join(" | ")}`,
        );
      }
      const missingReason = floorViolations.some((v) => {
        const overrideReason = trustedItems[v.index]?.overrideSnapshot?.reason ?? null;
        return !overrideReason && !payloadBelowMinimumReason;
      });
      if (missingReason) {
        throw new BadRequestError(
          "A reason is required for a sale that prices below the minimum.",
        );
      }
      // Phase 1: the business may additionally demand a one-time manager
      // approval token for below-minimum pricing (pos_settings).
      if (await isApprovalRequired(businessId, "pricing.below_minimum")) {
        if (!data.approvalToken) {
          throw new ForbiddenError(
            "A manager approval is required for below-minimum pricing.",
          );
        }
        const approval = await consumeApprovalInTx(tx, businessId, {
          token: data.approvalToken,
          opType: "pricing.below_minimum",
        });
        belowMinimumApprovedBy = approval.approverUserId;
      }
    }
    // Snapshot entries for overridden lines + below-minimum approvals,
    // appended AFTER the group/promotion entries (application order).
    const manualAdjustmentsByLine = new Map<
      number,
      { kind: "manual"; refId: null; name: string; amount: number; reason: string | null }[]
    >();
    trustedItems.forEach((item, idx) => {
      const entries: {
        kind: "manual";
        refId: null;
        name: string;
        amount: number;
        reason: string | null;
      }[] = [];
      if (item.overrideSnapshot != null) {
        const list = item.listUnitPrice;
        entries.push({
          kind: "manual",
          refId: null,
          name: "Price override",
          amount: roundMoney(
            ((list ?? item.unitPrice) - item.unitPrice) * item.quantity,
          ),
          reason: item.overrideSnapshot.reason,
        });
      }
      const violation = floorViolations.find((v) => v.index === idx);
      if (violation) {
        entries.push({
          kind: "manual",
          refId: null,
          name: "Below-minimum approval",
          amount: 0,
          reason:
            item.overrideSnapshot?.reason ?? payloadBelowMinimumReason ?? null,
        });
      }
      if (entries.length > 0) manualAdjustmentsByLine.set(idx, entries);
    });
    // Coupons (Module 6): server-validated; v1 stacking rule — a coupon
    // replaces the MANUAL cart-level discount (both is rejected) but stacks
    // with the automatic customer-group discount. The discount reduces the
    // final charge; recorded on the sale via coupon_redemptions.
    let couponEvaluation: Awaited<
      ReturnType<typeof evaluateCouponInTx>
    > | null = null;
    if (couponCode) {
      if (discount !== null && (discount.value ?? 0) > 0) {
        throw new BadRequestError(
          "Use either a cart discount or a coupon — not both.",
        );
      }
      couponEvaluation = await evaluateCouponInTx(tx, {
        businessId,
        code: couponCode,
        afterDiscountTotal: totals.afterDiscount,
        customerId,
      });
    }
    const couponDiscount = couponEvaluation?.discountAmount ?? 0;
    const finalTotalWithCoupon = roundMoney(
      Math.max(0, totals.finalTotal - couponDiscount),
    );

    // Header discount keeps its conflated meaning (line + manual cart) and
    // now also carries the automatic group + promotion layers; per-line
    // attribution lives in sale_items.price_adjustments (kind 'group' then
    // kind 'promotion', in application order).
    const totalDiscount = roundMoney(
      totals.itemDiscount +
        totals.cartDiscountAmount +
        totals.groupCartAmount +
        totals.lineGroupTotal +
        totals.promoCartAmount +
        totals.promoLineTotal,
    );

    // 6. Validate payment amounts against the final total (coupon applied).
    const { change, dueAmount, paidAmount } = validatePayments(
      payments,
      finalTotalWithCoupon,
      customerId,
    );

    const paymentStatus = getPaymentStatus(paidAmount, dueAmount);

    // 7. Per-business invoice number from the business's own
    // document_sequences counter inside this transaction (rollback-safe).
    // The year in the prefix is the issue year from the document date.
    const invoiceNumber = formatSaleInvoiceNumber(
      new Date(saleDate).getFullYear(),
      await nextDocumentNumber(tx, businessId, "sale_invoice"),
    );

    // 8. Insert the sale header. onConflictDoNothing covers the case where a
    // concurrent request with the same idempotency key committed first; the
    // refetch below then replays that winner.
    const [newSale] = await tx
      .insert(sales)
      .values({
        businessId,
        locationId,
        invoiceNumber,
        saleDate,
        customerId,
        subtotal: totals.itemsBase,
        discount: totalDiscount,
        vat: totals.vat,
        finalTotal: finalTotalWithCoupon,
        dueAmount,
        paymentStatus,
        status: "completed",
        channel: options.channel ?? undefined,
        // Customer group AT SALE TIME (Phase 4 snapshot, no FK by design).
        customerGroupId: groupPricing.groupId,
        idempotencyKey,
        idempotencyPayloadHash: payloadHash,
        terminalId,
        cashierUserId,
        ...(salespersonUserId !== null
          ? {
              salespersonUserId,
              salespersonAssignedAt: new Date(),
              salespersonAssignedBy: cashierUserId,
            }
          : {}),
      })
      .onConflictDoNothing({
        target: [sales.businessId, sales.idempotencyKey],
      })
      .returning({
        id: sales.id,
        invoiceNumber: sales.invoiceNumber,
        subtotal: sales.subtotal,
        discount: sales.discount,
        vat: sales.vat,
        finalTotal: sales.finalTotal,
        dueAmount: sales.dueAmount,
        paymentStatus: sales.paymentStatus,
      });

    if (!newSale) {
      if (!idempotencyKey) {
        throw new ConflictError("Sale insert returned no row.");
      }
      const replay = await findSaleByIdempotencyKey(
        tx,
        businessId,
        idempotencyKey,
        payloadHash,
      );
      if (!replay) {
        throw new ConflictError("Sale insert returned no row.");
      }
      return replay;
    }

    const saleId = newSale.id;

    // Phase 6 audit trail: permission-gated price overrides and approved
    // below-minimum lines land in the audit log with the sale (in-tx, so it
    // rolls back with the sale itself).
    if (manualAdjustmentsByLine.size > 0) {
      await recordAuditInTx(tx, {
        businessId,
        actorUserId: cashierUserId,
        action: "pricing.price_override",
        entityType: "sale",
        entityId: saleId,
        metadata: {
          overrides: [...manualAdjustmentsByLine.entries()].map(([idx, entries]) => ({
            variantId: trustedItems[idx]!.variantId,
            entries,
          })),
          belowMinimum: floorViolations.map((v) => ({
            variantId: v.variantId,
            message: v.message,
          })),
        },
      });
    }

    // 9. Insert sale items with price, cost, and tax snapshots. perLine is
    // index-aligned with trustedItems (both derive from the same list; unit
    // prices are pre-validated so no line is skipped in the totals pass).
    const warrantyItems: WarrantyGenerationItem[] = [];
    for (const [itemIndex, item] of trustedItems.entries()) {
      const line = getLinePricing(item.unitPrice, item.quantity, item.discount);
      const lineTax = lineTaxes?.[itemIndex];

      let cost: {
        totalCost: number;
        costAtSale: number;
        serialIds?: number[];
        used?: { batchId: number; quantity: number; unitCost: number }[];
        consumed?: BatchConsumption[];
      };

      if (item.trackingType === "serial") {
        // read from the DB, never from the request
        const serials = item.serialNumbers ?? [];
        if (serials.length !== item.quantity) {
          throw new BadRequestError(
            `Select exactly ${item.quantity} serial number(s) for variant ${item.variantId}.`,
          );
        }
        cost = await consumeSerials(tx, businessId, item.variantId, serials);
        cost.consumed = (cost.used ?? []).map((u) => ({
          batchId: u.batchId,
          quantity: u.quantity,
          unitCost: u.unitCost,
        }));
      } else if (bomByVariant.has(item.variantId)) {
        // Phase 4 (Feature 9): assemble-on-sale composite — the PARENT is
        // not stocked; its COMPONENTS are consumed through the same FIFO
        // machinery (waste-inclusive). Refunds restock the components via
        // the persisted consumptions. Serial-tracked composites rejected.
        const components = bomByVariant.get(item.variantId)!;
        if (item.trackingType === "serial") {
          throw new BadRequestError(
            "Serial-tracked composite products are not supported.",
          );
        }
        const consumedAll: BatchConsumption[] = [];
        let componentTotalCost = 0;
        for (const component of components) {
          const required = roundMoney(
            item.quantity * component.quantity * (1 + component.wastePercent / 100),
          );
          if (!options.allowNegativeStock) {
            const [stock] = await tx
              .select({ quantity: inventoryStock.quantity })
              .from(inventoryStock)
              .where(
                and(
                  eq(inventoryStock.businessId, businessId),
                  eq(inventoryStock.variantId, component.componentVariantId),
                  eq(inventoryStock.locationId, locationId),
                ),
              )
              .for("update");
            if (Number(stock?.quantity ?? 0) < required) {
              throw new BadRequestError(
                `Insufficient stock for component ${component.componentName}: need ${required}, have ${Number(stock?.quantity ?? 0)}.`,
              );
            }
          }
          const componentCost = await consumeStockFifo(
            tx,
            businessId,
            locationId,
            component.componentVariantId,
            required,
            { ...(options.allowNegativeStock ? { allowShortfall: true } : {}) },
          );
          if (
            "shortfall" in componentCost &&
            Number(componentCost.shortfall) > 0
          ) {
            batchShortfalls.push({
              variantId: component.componentVariantId,
              qty: Number(componentCost.shortfall),
            });
          }
          componentTotalCost += componentCost.totalCost;
          consumedAll.push(
            ...componentCost.consumed.map((c) => ({
              batchId: c.batchId,
              quantity: c.quantity,
              unitCost: c.unitCost,
            })),
          );
          // Component movement (the parent itself is not stocked).
          await tx.insert(inventoryMovements).values({
            businessId,
            variantId: component.componentVariantId,
            locationId,
            movementType: "sale",
            quantity: -required,
            referenceType: "bom_sale",
            referenceId: saleId,
          });
        }
        cost = {
          totalCost: roundMoney(componentTotalCost),
          costAtSale: roundMoney(componentTotalCost / item.quantity),
          consumed: consumedAll,
        };
      } else {
        cost = await consumeStockFifo(
          tx,
          businessId,
          locationId,
          item.variantId,
          item.quantity,
          { ...(options.allowNegativeStock ? { allowShortfall: true } : {}) },
        );
        if ("shortfall" in cost && Number(cost.shortfall) > 0) {
          batchShortfalls.push({
            variantId: item.variantId,
            qty: Number(cost.shortfall),
          });
        }
      }

      if (!Number.isFinite(cost.costAtSale) || cost.costAtSale < 0) {
        throw new Error(
          `Invalid inventory cost for variant ${item.variantId}.`,
        );
      }

      const [saleItem] = await tx
        .insert(saleItems)
        .values({
          businessId,
          saleId,
          variantId: item.variantId,
          quantity: item.quantity,
          sellingPrice: item.unitPrice,
          costAtSale: cost.costAtSale,
          lineTotal: line.total,
          discount: line.discountAmount,
          taxAmount: lineTax?.taxAmount ?? 0,
          taxDetail: lineTax?.detail ?? [],
          // UOM snapshot: the selling unit the cashier selected (null =
          // base unit, every legacy line).
          uomConversionId: item.uomSnapshot?.conversionId ?? null,
          enteredQuantity: item.uomSnapshot?.enteredQuantity ?? null,
          enteredUnitPrice: item.uomSnapshot?.enteredUnitPrice ?? null,
          conversionFactor: item.uomSnapshot?.conversionFactor ?? null,
          // Discount attribution (Phases 4-5): index-aligned with
          // trustedItems via the totals pass; names added here so the
          // snapshot is self-describing. Order = application order: group
          // entries first, then promotions.
          priceAdjustments: [
            ...(
              "perLine" in totals
                ? (lineTaxes?.[itemIndex]?.groupAdjustments ?? [])
                : (totals.groupLineAdjustments[itemIndex] ?? [])
            ).map((a) => ({
              kind: "group" as const,
              refId: a.refId,
              name: groupPricing.groupName,
              amount: a.amount,
            })),
            ...(
              "perLine" in totals
                ? (lineTaxes?.[itemIndex]?.promotionAdjustments ?? [])
                : (totals.promoLineAdjustments[itemIndex] ?? [])
            ).map((a) => ({
              kind: "promotion" as const,
              refId: a.refId,
              name:
                (a.refId != null
                  ? promoNameById.get(a.refId)
                  : null) ?? null,
              amount: a.amount,
            })),
            ...(manualAdjustmentsByLine.get(itemIndex) ?? []),
          ],
        })
        .returning({ id: saleItems.id });
      if (!saleItem) throw new Error("Failed to create sale item.");

      if (cost.consumed?.length) {
        await insertSaleItemConsumptions(
          tx,
          businessId,
          saleId,
          saleItem.id,
          item.variantId,
          cost.consumed,
        );
      }

      // Link the serials consumed for this line to the sale item. Refunds
      // key off serial_numbers.sale_item_id, so leaving it NULL would make
      // serial-tracked stock unsellable after the first sale. The WHERE
      // guards re-assert the business/variant ownership of the rows; a row
      // count mismatch aborts the transaction (full rollback).
      if (item.trackingType === "serial" && cost.serialIds?.length) {
        const linkedSerials = await tx
          .update(serialNumbers)
          .set({ saleItemId: saleItem.id })
          .where(
            and(
              inArray(serialNumbers.id, cost.serialIds),
              eq(serialNumbers.businessId, businessId),
              eq(serialNumbers.variantId, item.variantId),
              eq(serialNumbers.status, "sold"),
            ),
          )
          .returning({ id: serialNumbers.id });
        if (linkedSerials.length !== cost.serialIds.length) {
          throw new Error(
            `Failed to link serial numbers for variant ${item.variantId}.`,
          );
        }
      }

      // Phase 4 (Feature 9): composite lines do NOT decrement the parent —
      // their components were consumed in the BOM branch above; their stock
      // rows are decremented here (atomic with the sale).
      let updatedRows: { variantId: number; quantity: number | null }[] = [];
      if (bomByVariant.has(item.variantId)) {
        const components = bomByVariant.get(item.variantId)!;
        for (const component of components) {
          const required = roundMoney(
            item.quantity * component.quantity * (1 + component.wastePercent / 100),
          );
          await tx
            .update(inventoryStock)
            .set({
              quantity: sql`${inventoryStock.quantity} - ${required}`,
            })
            .where(
              and(
                eq(inventoryStock.variantId, component.componentVariantId),
                eq(inventoryStock.businessId, businessId),
                eq(inventoryStock.locationId, locationId),
              ),
            );
        }
      } else {
      // Online sales: the row was locked+validated, so a plain decrement
      // is safe. Offline-originated sales may reference a variant with NO
      // stock row at this location — the atomic upsert creates it at the
      // negative delta.
      updatedRows = options.allowNegativeStock
        ? await tx
            .insert(inventoryStock)
            .values({
              businessId,
              variantId: item.variantId,
              locationId,
              quantity: -item.quantity,
            })
            .onConflictDoUpdate({
              target: [
                inventoryStock.businessId,
                inventoryStock.variantId,
                inventoryStock.locationId,
              ],
              set: {
                quantity: sql`${inventoryStock.quantity} - ${item.quantity}`,
              },
            })
            .returning({
              variantId: inventoryStock.variantId,
              quantity: inventoryStock.quantity,
            })
        : await tx
            .update(inventoryStock)
            .set({
              quantity: sql`${inventoryStock.quantity} - ${item.quantity}`,
            })
            .where(
              and(
                eq(inventoryStock.variantId, item.variantId),
                eq(inventoryStock.businessId, businessId),
                eq(inventoryStock.locationId, locationId),
              ),
            )
            .returning({
              variantId: inventoryStock.variantId,
              quantity: inventoryStock.quantity,
            });

      if (updatedRows.length !== 1) {
        throw new Error(
          `Failed to update stock for variant ${item.variantId}.`,
        );
      }
      } // end non-composite decrement

      // Stock alerts (Module 14): deduped per variant+location per day.
      // Phase 4: composite lines alert on the PARENT's stock (unchanged by
      // the sale — components were consumed instead).
      {
        const [variantInfo] = await tx
          .select({
            alertQuantity: productVariants.alertQuantity,
            productName: products.name,
          })
          .from(productVariants)
          .innerJoin(products, eq(products.id, productVariants.productId))
          .where(eq(productVariants.id, item.variantId))
          .limit(1);
        if (variantInfo) {
          const alertQuantity = bomByVariant.has(item.variantId)
            ? Number(
                (
                  await tx
                    .select({ quantity: inventoryStock.quantity })
                    .from(inventoryStock)
                    .where(
                      and(
                        eq(inventoryStock.variantId, item.variantId),
                        eq(inventoryStock.businessId, businessId),
                        eq(inventoryStock.locationId, locationId),
                      ),
                    )
                    .limit(1)
                ).at(0)?.quantity ?? 0,
              )
            : Number(updatedRows[0]?.quantity ?? 0);
          await notifyStockLevel(tx, {
            businessId,
            variantId: item.variantId,
            productName: variantInfo.productName,
            newQuantity: alertQuantity,
            alertQuantity: Number(variantInfo.alertQuantity ?? 0),
            locationId,
          });
        }
      }
      if (!bomByVariant.has(item.variantId)) {
        await tx.insert(inventoryMovements).values({
          businessId,
          variantId: item.variantId,
          locationId,
          movementType: "sale",
          quantity: item.quantity,
          referenceType: "sale",
          referenceId: saleId,
        });
      }

      // Warranty generation input: the sale item id and the concrete sold
      // serials exist by this point. Products without an active warranty
      // config are filtered inside the engine (D2/D4 — quantity rows for
      // ordinary products, per-serial rows for trackingType='serial').
      warrantyItems.push({
        saleItemId: saleItem.id,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        serialIds: item.trackingType === "serial" ? (cost.serialIds ?? []) : [],
      });
    }

    // 8b. Issue customer warranties inside the same transaction — the sale
    // and its warranties commit or roll back together. Idempotency: the
    // replay path above returns before this point, and the partial unique
    // indexes make duplicate rows impossible regardless.
    if (warrantyItems.length > 0) {
      await createWarrantiesForSaleItems(tx, {
        businessId,
        locationId,
        saleId,
        saleDate,
        customerId: customerId ?? null,
        items: warrantyItems,
      });
    }

    // 9. Insert actual received payments.
    const receivedPayments = payments.filter(
      (payment) => payment.method !== "due" && (payment.amount ?? 0) > 0,
    );

    if (receivedPayments.length > 0) {
      try {
        await tx.insert(salePayments).values(
          receivedPayments.map((payment) => {
            if (payment.amount === undefined) {
              throw new NotFoundError("payment amount not found");
            }
            return {
              businessId,
              saleId,
              customerId,
              amount: payment.amount,
              paymentMethod: payment.method,
              reference:
                payment.method === "cash" || payment.method === "gift_card"
                  ? null
                  : payment.reference?.trim() || null,
              tendered:
                payment.method === "cash" ? (payment.tendered ?? null) : null,
            };
          }),
        );

        // Store credit spends: locked against the customer's ledger inside
        // this transaction — insufficient balance aborts the whole sale.
        for (const payment of receivedPayments) {
          if (payment.method !== "store_credit") continue;
          if (customerId === null) {
            throw new BadRequestError(
              "Store credit payments require a customer on the sale.",
            );
          }
          await consumeStoreCreditInTx(tx, {
            businessId,
            customerId,
            amount: Number(payment.amount),
            sourceType: "sale_payment",
            sourceId: saleId,
            actorUserId: cashierUserId,
            note: `Sale ${invoiceNumber}`,
          });
        }

        // Loyalty redemption: same ledger-lock pattern (Module 7).
        for (const payment of receivedPayments) {
          if (payment.method !== "loyalty_points") continue;
          if (customerId === null) {
            throw new BadRequestError(
              "Loyalty payments require a customer on the sale.",
            );
          }
          await redeemLoyaltyPointsInTx(tx, {
            businessId,
            customerId,
            amount: Number(payment.amount),
            sourceId: saleId,
            actorUserId: cashierUserId,
          });
        }

        // Gift card redemption: code resolved + ledger locked inside this
        // transaction — concurrent double-redemption is impossible (M7).
        for (const payment of receivedPayments) {
          if (payment.method !== "gift_card") continue;
          const code = payment.reference?.trim() ?? "";
          if (code.length < 8) {
            throw new BadRequestError(
              "Gift card payments require the full card code as the reference.",
            );
          }
          await redeemGiftCardInTx(tx, {
            businessId,
            code,
            amount: Number(payment.amount),
            saleId,
            actorUserId: cashierUserId,
          });
        }

        // Cash drawer attribution: the cash portion lands in the seller's
        // open register session (same transaction; no-op without a session).
        const cashAmount = receivedPayments
          .filter((payment) => payment.method === "cash")
          .reduce((sum, payment) => sum + (payment.amount ?? 0), 0);
        // A sale without a cashier (LAN replicas of legacy rows) records no
        // drawer movement — register_transactions.userId is NOT NULL.
        if (cashierUserId !== null) {
          // Phase 1 gate: when require_open_drawer is on, cash cannot change
          // hands without a drawer to land in (offline replays included).
          if (
            cashAmount > 0 &&
            (await getRequireOpenDrawer(businessId))
          ) {
            await assertOpenDrawerForCashInTx(
              tx,
              businessId,
              cashierUserId,
              locationId,
              terminalId,
            );
          }
          await recordCashSaleInTx(
            tx,
            businessId,
            cashierUserId,
            locationId,
            cashAmount,
            saleId,
            terminalId,
          );
        }
      } catch (error: unknown) {
        if (isDuplicatePaymentReferenceError(error)) {
          throw new ConflictError(
            "This transaction reference has already been used for this payment method.",
          );
        }
        throw error;
      }
    }
    // 11. Audit the sale transactionally, then return receipt data.
    await recordAuditInTx(tx, {
      businessId,
      actorUserId: cashierUserId,
      action: "sale.create",
      entityType: "sale",
      entityId: saleId,
      metadata: {
        invoiceNumber: newSale.invoiceNumber,
        finalTotal: Number(newSale.finalTotal),
        dueAmount: Number(newSale.dueAmount),
        paymentStatus: newSale.paymentStatus,
        itemCount: items.length,
        ...(belowMinimumApprovedBy !== null ? { belowMinimumApprovedBy } : {}),
      },
    });

    // Phase 3: record promotion usage — idempotent per (sale, promotion) via
    // the unique constraint; powers usage_limit / per_customer_limit.
    const appliedPromoIds = [
      ...new Set(
        [
          ...promoEvaluation.cartAmounts.map((a) => a.refId),
          ...promoEvaluation.lineAdjustments.flatMap((a) =>
            a && a.refId != null ? [a.refId] : [],
          ),
        ].filter((id): id is number => typeof id === "number"),
      ),
    ];
    if (appliedPromoIds.length > 0) {
      await tx
        .insert(promotionUsage)
        .values(
          appliedPromoIds.map((promotionId) => ({
            businessId,
            promotionId,
            saleId,
            ...(customerId !== null ? { customerId } : {}),
          })),
        )
        .onConflictDoNothing();
    }

    // Coupon redemption recorded atomically with the sale (Module 6).
    if (couponEvaluation) {
      await recordCouponRedemptionInTx(tx, {
        businessId,
        couponId: couponEvaluation.couponId,
        saleId,
        customerId,
        discountAmount: couponDiscount,
      });
    }

    // Loyalty earn (Phase 2A engine): dues earn nothing, points/store-
    // credit/gift-card-funded portions do not earn on themselves, and the
    // earning rule's excluded products/categories never earn. The base is
    // capped by the amount actually paid, so dues still earn nothing.
    if (customerId !== null && paidAmount > 0) {
      const fundedByAccount = receivedPayments
        .filter(
          (payment) =>
            payment.method === "loyalty_points" ||
            payment.method === "store_credit" ||
            payment.method === "gift_card",
        )
        .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);
      const rule = await getEarnRule(businessId);
      const eligibleLines = await computeEligibleEarnBaseInTx(tx, {
        businessId,
        saleId,
        excludedProductIds: rule.excludedProductIds,
        excludedCategoryIds: rule.excludedCategoryIds,
      });
      const earnBase = roundMoney(
        Math.max(0, Math.min(eligibleLines, paidAmount) - fundedByAccount),
      );
      if (earnBase > 0) {
        await earnLoyaltyPointsInTx(tx, {
          businessId,
          customerId,
          eligibleBase: earnBase,
          sourceId: saleId,
          actorUserId: cashierUserId,
          meetsMinimum: earnBase >= rule.minTransactionAmount,
        });
      }
    }

    // Phase 2A: every customer sale counts toward tier-qualifying spend
    // (independent of whether points were earned on it).
    if (customerId !== null) {
      await recordLoyaltySpendInTx(tx, {
        businessId,
        customerId,
        amount: Number(newSale.finalTotal ?? 0),
      });
    }

    // Phase 5 (Feature 13): commission calculation — validated salesperson
    // membership, entries per matching rule, committed with the sale.
    if (salespersonUserId !== null) {
      const [member] = await tx
        .select({ id: businessMemberships.id })
        .from(businessMemberships)
        .where(
          and(
            eq(businessMemberships.businessId, businessId),
            eq(businessMemberships.userId, salespersonUserId),
          ),
        )
        .limit(1);
      if (!member) {
        throw new BadRequestError(
          "Salesperson is not a member of this business.",
        );
      }
      const costBasisRow = await tx
        .select({
          cost: sql<string>`COALESCE(SUM(${saleItems.costAtSale} * ${saleItems.quantity}), 0)`,
        })
        .from(saleItems)
        .where(eq(saleItems.saleId, saleId));
      await calculateCommissionsForSaleInTx(tx, {
        businessId,
        saleId,
        salespersonUserId,
        finalTotal: Number(newSale.finalTotal ?? 0),
        costBasis: Number(costBasisRow[0]?.cost ?? 0),
      });
    }

    // Finance & Growth: post the sale to the double-entry ledger (no-op
    // before activation; idempotent per sale; atomic with the sale).
    await postSaleLedgerEntry(tx, {
      saleId: newSale.id,
      businessId,
      locationId,
      payments: receivedPayments.map((payment) => ({
        method: payment.method,
        amount: Number(payment.amount ?? 0),
      })),
      actorUserId: cashierUserId,
    });

    return {
      sale: newSale,
      change,
      paidAmount,
      dueAmount,
      ...(batchShortfalls.length > 0 ? { batchShortfalls } : {}),
    };
  });

  const receipt = await getSaleReceipt(businessId, result.sale.id);
  // Real-time register updates (Module 11): other registers at this
  // location refresh their stock views. Signal only — they refetch through
  // the normal APIs and the backend re-validates everything.
  publishRealtime(businessId, locationId, {
    kind: "sale.created",
    locationId,
    saleId: result.sale.id,
  });
  return {
    ...result,
    receipt,
  };
}
async function applySaleRefund(
  tx: DbTransaction,
  businessId: number,
  saleId: number,
  items: (typeof saleItems.$inferSelect)[],
  options: SaleRefundRequest,
) {
  const reason = options.notes
    ? `${options.reason}: ${options.notes}`
    : options.reason;

  // Money correctness: sale_items.line_total is price minus item discount —
  // it carries neither the cart-level discount nor the VAT, so refunding raw
  // line totals over-refunds discounted sales. The sale's final total differs
  // from the sum of line totals by a single sale-level delta (vat − cart
  // discount); allocate that delta across all of the sale's items pro rata so
  // the effective refund value of a line is its true share of what the
  // customer actually paid or owes.
  const [sale] = await tx
    .select({
      finalTotal: sales.finalTotal,
      dueAmount: sales.dueAmount,
      paymentStatus: sales.paymentStatus,
      locationId: sales.locationId,
      customerId: sales.customerId,
    })
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .for("update");
  if (!sale) throw new NotFoundError("Sale not found");
  if (options.refundMethod === "store_credit" && sale.customerId === null) {
    throw new BadRequestError(
      "Store credit refunds require the sale to have a customer.",
    );
  }

  const allItems = await tx
    .select({ lineTotal: saleItems.lineTotal })
    .from(saleItems)
    .where(and(eq(saleItems.saleId, saleId), eq(saleItems.businessId, businessId)));
  const totalLineBase = allItems.reduce(
    (sum, row) => sum + Number(row.lineTotal),
    0,
  );
  const delta = Number(sale.finalTotal) - totalLineBase;
  const effectiveByItemId = new Map<number, number>();
  for (const item of items) {
    const share =
      totalLineBase > 0 ? Number(item.lineTotal) / totalLineBase : 0;
    effectiveByItemId.set(
      item.id,
      Math.max(0, roundMoney(Number(item.lineTotal) + delta * share)),
    );
  }
  // Per-line partial returns (UOM Phase 5): a ledger of previously
  // returned quantities per sale item replaces the once-only guard.
  const priorReturnedRows = await tx
    .select({
      saleItemId: saleRefundItems.saleItemId,
      returned: sql<string>`COALESCE(SUM(${saleRefundItems.quantity}), 0)`,
    })
    .from(saleRefundItems)
    .innerJoin(saleRefunds, eq(saleRefundItems.refundId, saleRefunds.id))
    .where(
      and(eq(saleRefunds.saleId, saleId), eq(saleRefunds.businessId, businessId)),
    )
    .groupBy(saleRefundItems.saleItemId);
  const returnedByItem = new Map<number, number>(
    priorReturnedRows.flatMap((row) =>
      row.saleItemId === null ? [] : [[row.saleItemId, Number(row.returned)] as const],
    ),
  );
  const requestedQuantityByItemId = new Map<number, number>();
  if (options.quantities) {
    const wantedIds = new Set(items.map((i) => i.id));
    for (const entry of options.quantities) {
      if (!wantedIds.has(entry.saleItemId)) continue;
      if (requestedQuantityByItemId.has(entry.saleItemId)) {
        throw new BadRequestError(
          "Duplicate quantity entries for the same sale item are not allowed.",
        );
      }
      requestedQuantityByItemId.set(entry.saleItemId, entry.quantity);
    }
  }
  const requestedByItem = new Map<number, number>();
  for (const item of items) {
    const remaining = item.quantity - (returnedByItem.get(item.id) ?? 0);
    const requested = requestedQuantityByItemId.get(item.id) ?? remaining;
    if (!Number.isInteger(requested) || requested <= 0) {
      throw new BadRequestError(
        `Invalid return quantity for sale item ${item.id}.`,
      );
    }
    if (requested > remaining) {
      throw new ConflictError(
        `Cannot return ${requested} of sale item ${item.id}; only ${Math.max(remaining, 0)} unit(s) remain returnable.`,
      );
    }
    requestedByItem.set(item.id, requested);
  }

  // Effective money is pro-rated by the returned share of each line, so a
  // 3-of-12 partial return refunds exactly 3/12 of the line's effective
  // value (cart-discount/VAT delta included).
  const batchEffective = items.reduce(
    (sum, item) =>
      sum +
      roundMoney(
        (effectiveByItemId.get(item.id) ?? 0) *
          (requestedByItem.get(item.id) ?? 0) /
          Number(item.quantity),
      ),
    0,
  );

  // Never refund more than the sale is worth in total (defense in depth —
  // the per-item double-refund guard already blocks the common path).
  const [priorRefunds] = await tx
    .select({
      total: sql<string>`COALESCE(SUM(${saleRefunds.refundTotal}), 0)`,
    })
    .from(saleRefunds)
    .where(
      and(eq(saleRefunds.saleId, saleId), eq(saleRefunds.businessId, businessId)),
    );
  const remainingValue = Math.max(
    0,
    Number(sale.finalTotal) - Number(priorRefunds?.total ?? 0),
  );
  const refundTotal = Math.min(roundMoney(batchEffective), remainingValue);
  if (refundTotal <= 0) {
    throw new ConflictError("This sale has no refundable value left.");
  }

  const [refund] = await tx
    .insert(saleRefunds)
    .values({
      businessId,
      // The refund belongs to the sale's location — it must show up in
      // that location's ledgers, comparison and Z-report.
      locationId: sale.locationId,
      saleId,
      reason,
      status: options.disposition,
      refundTotal,
      refundMethod: options.refundMethod ?? null,
      // provider_refund_id is filled after commit when the provider payout
      // succeeds; NULL until then (retryable — see the callers).
    })
    .returning({ id: saleRefunds.id });
  if (!refund) throw new NotFoundError("Could not create refund record");

  // Store credit settlement: the refund value becomes spendable customer
  // balance, recorded transactionally in the ledger (balances reconcile by
  // construction). Exchanges net out against replacement value upstream.
  if (options.refundMethod === "store_credit") {
    await grantStoreCreditInTx(tx, {
      businessId,
      customerId: sale.customerId!,
      amount: refundTotal,
      sourceType: "refund",
      sourceId: refund.id,
      note: `Refund credit (sale #${saleId})`,
    });
  }

  // Loyalty clawback: points earned on refunded value are reversed
  // transactionally (Module 7). The balance may go negative when points
  // were already spent — recorded honestly; redemption cannot overdraw.
  if (sale.customerId !== null) {
    await reverseLoyaltyPointsInTx(tx, {
      businessId,
      customerId: sale.customerId,
      refundedAmount: refundTotal,
      sourceId: saleId,
    });
    // Phase 2A: points REDEEMED on the refunded sale come back
    // proportionally (never expiring) — each refund restores at most once
    // because the sourceId is the refund id.
    await restoreRedeemedPointsInTx(tx, {
      businessId,
      customerId: sale.customerId,
      saleId,
      refundId: refund.id,
      refundTotal,
      saleFinalTotal: Number(sale.finalTotal ?? 0),
    });
  }

  // Phase 5 (Feature 13): commission reversal — proportional negative
  // entries; history preserved. Only PENDING entries reverse; approved+
  // money is handled manually per policy.
  await reverseCommissionsForRefundInTx(tx, {
    businessId,
    saleId,
    refundId: refund.id,
    refundTotal,
    saleFinalTotal: Number(sale.finalTotal ?? 0),
  });

  // Value returned to inventory (Finance & Growth ledger hook input):
  // restocked units re-enter at their original blended cost_at_sale.
  let restockedCost = 0;
  for (const item of items) {
    const [variant] = await tx
      .select({
        productId: productVariants.productId,
        trackingType: products.trackingType,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          eq(productVariants.id, item.variantId),
          eq(productVariants.businessId, businessId),
        ),
      )
      .limit(1);
    if (!variant) {
      throw new NotFoundError(`Variant ${item.variantId} not found`);
    }

    const effective = effectiveByItemId.get(item.id) ?? 0;
    const returnedQuantity = requestedByItem.get(item.id) ?? item.quantity;
    const effectiveShare = roundMoney(
      (effective * returnedQuantity) / Number(item.quantity),
    );
    await tx.insert(saleRefundItems).values({
      businessId,
      refundId: refund.id,
      saleItemId: item.id,
      productId: variant.productId,
      quantity: returnedQuantity,
      refundPrice: effectiveShare / returnedQuantity,
      refundTotal: effectiveShare,
    });

    const serialStatus =
      options.disposition === "restock"
        ? "in_stock"
        : options.disposition === "damaged"
          ? "damaged"
          : "returned";
    const partialReturn = returnedQuantity < Number(item.quantity);
    if (variant.trackingType !== "serial") {
      // Non-serial lines: the disposition applies to the returned units.
      await tx
        .update(serialNumbers)
        .set({ status: serialStatus })
        .where(
          and(
            eq(serialNumbers.saleItemId, item.id),
            eq(serialNumbers.businessId, businessId),
          ),
        );
    } else if (!partialReturn) {
      // Full-line return: every serial of the line flips (legacy behavior).
      await tx
        .update(serialNumbers)
        .set({ status: serialStatus })
        .where(
          and(
            eq(serialNumbers.saleItemId, item.id),
            eq(serialNumbers.businessId, businessId),
          ),
        );
    } else {
      // PARTIAL serial return: the operator must say WHICH serials came
      // back — a package quantity can never bypass serial tracking.
      const selection = options.serialIds?.find(
        (entry) => entry.saleItemId === item.id,
      );
      const wanted = selection?.serialIds ?? [];
      if (wanted.length !== returnedQuantity) {
        throw new BadRequestError(
          `Select exactly ${returnedQuantity} serial number(s) for the partial return of sale item ${item.id}.`,
        );
      }
      const updated = await tx
        .update(serialNumbers)
        .set({ status: serialStatus })
        .where(
          and(
            inArray(serialNumbers.id, wanted),
            eq(serialNumbers.saleItemId, item.id),
            eq(serialNumbers.businessId, businessId),
          ),
        )
        .returning({ id: serialNumbers.id });
      if (updated.length !== wanted.length) {
        throw new BadRequestError(
          `One or more selected serials do not belong to sale item ${item.id}.`,
        );
      }
    }

    // Warranty coverage follows the return, unit-exactly (D2): serial
    // warranties void only for the serials that came back; quantity
    // warranties track returned units and void when exhausted.
    if (variant.trackingType === "serial") {
      const serialIdsForWarranty = partialReturn
        ? (options.serialIds
            ?.find((entry) => entry.saleItemId === item.id)
            ?.serialIds ?? [])
        : (
            await tx
              .select({ id: serialNumbers.id })
              .from(serialNumbers)
              .where(
                and(
                  eq(serialNumbers.saleItemId, item.id),
                  eq(serialNumbers.businessId, businessId),
                ),
              )
          ).map((row) => row.id);
      if (serialIdsForWarranty.length > 0) {
        await applyRefundWarrantyEffects(tx, {
          businessId,
          saleItemId: item.id,
          returnedQuantity,
          serialIds: serialIdsForWarranty,
          refundId: refund.id,
        });
      }
    } else {
      await applyRefundWarrantyEffects(tx, {
        businessId,
        saleItemId: item.id,
        returnedQuantity,
        serialIds: [],
        refundId: refund.id,
      });
    }

    if (options.disposition !== "restock") continue;
    restockedCost += Number(item.costAtSale) * returnedQuantity;

    const [stock] = await tx
      .select()
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.variantId, item.variantId),
          eq(inventoryStock.businessId, businessId),
          // Returns restock the sale's own location — never another store's.
          ...(sale.locationId !== null
            ? [eq(inventoryStock.locationId, sale.locationId)]
            : []),
        ),
      )
      .for("update");
    if (!stock) {
      throw new NotFoundError(
        `No inventory record exists for variant ${item.variantId}`,
      );
    }

    await tx
      .update(inventoryStock)
      .set({
        quantity: sql`coalesce(${inventoryStock.quantity}, 0) + ${returnedQuantity}`,
      })
      .where(
        and(
          eq(inventoryStock.id, stock.id),
          eq(inventoryStock.businessId, businessId),
        ),
      );

    const [returnBatch] = await tx
      .insert(inventoryBatches)
      .values({
        businessId,
        variantId: item.variantId,
        locationId: stock.locationId,
        batchNumber: `RETURN-${refund.id}-${item.id}`,
        purchasePrice: item.costAtSale,
        quantityReceived: returnedQuantity,
        quantityRemaining: returnedQuantity,
      })
      .returning({ id: inventoryBatches.id });
    if (variant.trackingType === "serial" && returnBatch) {
      // Full-line returns re-point every serial of the line; partial
      // returns re-point exactly the serials selected above.
      await tx
        .update(serialNumbers)
        .set({ batchId: returnBatch.id })
        .where(
          and(
            eq(serialNumbers.saleItemId, item.id),
            eq(serialNumbers.businessId, businessId),
            partialReturn && options.serialIds
              ? inArray(
                  serialNumbers.id,
                  options.serialIds.find((e) => e.saleItemId === item.id)
                    ?.serialIds ?? [],
                )
              : undefined,
          ),
        );
    }

    await tx.insert(inventoryMovements).values({
      businessId,
      variantId: item.variantId,
      locationId: stock.locationId,
      batchId: returnBatch?.id ?? null,
      movementType: "return",
      // The ACTUAL restocked quantity — a partial return of 2 of 12 must not
      // log a 12-unit movement (stock math is already exact; this is the
      // movements ledger that reconciliation and reports read).
      quantity: returnedQuantity,
      referenceType: "sale_refund",
      referenceId: refund.id,
    });
  }

  // A refund returns value to the customer: on credit (unpaid/partial) sales
  // this reduces what the customer still owes. The customer due summary reads
  // this maintained due_amount, so refunds now net off receivables. (For
  // fully paid sales the refund cash-out record arrives with the dedicated
  // refund-payments table; the refund header already records the amount.)
  if (sale.paymentStatus !== "paid") {
    const paid = Number(sale.finalTotal) - Number(sale.dueAmount);
    const newDue = Math.max(0, Number(sale.dueAmount) - refundTotal);
    await tx
      .update(sales)
      .set({
        dueAmount: newDue,
        paymentStatus: getPaymentStatus(paid, newDue),
      })
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)));
  }

  const allSaleItems = await tx
    .select({ id: saleItems.id, quantity: saleItems.quantity })
    .from(saleItems)
    .where(
      and(
        eq(saleItems.saleId, saleId),
        eq(saleItems.businessId, businessId),
      ),
    )
    .for("update");
  const returnedAgg = await tx
    .select({
      saleItemId: saleRefundItems.saleItemId,
      returned: sql<string>`COALESCE(SUM(${saleRefundItems.quantity}), 0)`,
    })
    .from(saleRefundItems)
    .innerJoin(saleRefunds, eq(saleRefundItems.refundId, saleRefunds.id))
    .where(
      and(
        eq(saleRefunds.saleId, saleId),
        eq(saleRefunds.businessId, businessId),
      ),
    )
    .groupBy(saleRefundItems.saleItemId);
  const returnedByItemAll = new Map<number, number>(
    returnedAgg.flatMap((row) =>
      row.saleItemId === null ? [] : [[row.saleItemId, Number(row.returned)] as const],
    ),
  );
  const quantitiesByItem = new Map(
    allSaleItems.map((row) => [row.id, Number(row.quantity)]),
  );
  if (
    allSaleItems.length > 0 &&
    allSaleItems.every(
      (saleItem) =>
        (returnedByItemAll.get(saleItem.id) ?? 0) >=
        (quantitiesByItem.get(saleItem.id) ?? 0),
    )
  ) {
    await tx
      .update(sales)
      .set({ status: "refunded" })
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)));
    // Full return = every unit came back → void every remaining warranty of
    // the sale (D2). History (claims/events) is preserved; only coverage
    // ends.
    await voidWarrantiesForSale(tx, { businessId, saleId, refundId: refund.id });
  }

  // Online orders: mirror the return on the fulfillment workflow (module
  // two §6.8). Money-side truth stays in sale_refunds; POS sales keep their
  // fulfillment state untouched. Forward-only — a returned order can never
  // regress, so an order cannot be returned again in full.
  const [refundSale] = await tx
    .select({
      channel: sales.channel,
      fulfillmentStatus: sales.fulfillmentStatus,
    })
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .limit(1);
  if (refundSale && refundSale.channel !== "pos") {
    const current = refundSale.fulfillmentStatus;
    if (current !== "returned") {
      const fullyReturned =
        allSaleItems.length > 0 &&
        allSaleItems.every(
          (saleItem) =>
            (returnedByItemAll.get(saleItem.id) ?? 0) >=
            (quantitiesByItem.get(saleItem.id) ?? 0),
        );
      const nextReturnState = fullyReturned
        ? "returned"
        : "partially_returned";
      await tx
        .update(sales)
        .set({ fulfillmentStatus: nextReturnState })
        .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)));
      await recordOrderEventInTx(tx, {
        businessId,
        saleId,
        eventType: nextReturnState,
        previousStatus: current,
        newStatus: nextReturnState,
        actorType: "user",
        note: `Refund recorded — ${refundTotal.toFixed(2)}`,
        metadata: { refundId: refund.id, refundTotal },
      });
    }
  }

  return {
    refundId: refund.id,
    refundTotal,
    restockedCost,
    locationId: sale.locationId,
  };
}

export async function createSingleRefund(
  businessId: number,
  id: number,
  options: SaleRefundRequest,
  actorUserId: number | null = null,
) {
  const result = await db.transaction(async (tx) => {
    const [saleItem] = await tx
      .select()
      .from(saleItems)
      .where(
        and(eq(saleItems.id, id), eq(saleItems.businessId, businessId)),
      )
      .limit(1);
    if (!saleItem) throw new NotFoundError("Sale item not found");

    const [sale] = await tx
      .select({ id: sales.id, status: sales.status })
      .from(sales)
      .where(
        and(eq(sales.id, saleItem.saleId), eq(sales.businessId, businessId)),
      )
      .for("update");
    if (!sale) throw new NotFoundError("Sale not found");
    if (sale.status !== "completed") {
      throw new ConflictError("Only completed sales can be returned");
    }
    // Phase 1: manager approval when the business requires it for refunds —
    // consumed inside this transaction so a rollback un-burns the token.
    if (await isApprovalRequired(businessId, "sale.refund")) {
      if (!options.approvalToken) {
        throw new ForbiddenError(
          "A manager approval is required to refund this sale.",
        );
      }
      await consumeApprovalInTx(tx, businessId, {
        token: options.approvalToken,
        opType: "sale.refund",
        entityType: "sale",
        entityId: saleItem.saleId,
      });
    }
    // Fully-returned lines are rejected inside applySaleRefund's returned
    // ledger (partial returns may still refund the remainder).
    const { refundId, refundTotal, restockedCost, locationId: refundLocationId } =
      await applySaleRefund(tx, businessId, saleItem.saleId, [saleItem], options);
    // Counter payout: a cash refund (or an un-specified one — the schema
    // defaults it to cash) physically leaves the drawer, so the actor's
    // open session must absorb it transactionally. original_payment and
    // store_credit never touch drawer cash.
    if (options.refundMethod === undefined || options.refundMethod === "cash") {
      await recordCashRefundInTx(
        tx,
        businessId,
        actorUserId,
        refundLocationId,
        refundTotal,
        refundId,
      );
    }
    // Finance & Growth: post the refund to the ledger (no-op before
    // activation; idempotent per refund).
    await postRefundLedgerEntry(tx, {
      businessId,
      saleId: saleItem.saleId,
      refundId,
      refundTotal,
      cashOut:
        options.refundMethod === undefined || options.refundMethod === "cash"
          ? refundTotal
          : 0,
      nonCashMethod: options.refundMethod ?? null,
      restockedCost,
      locationId: refundLocationId,
      actorUserId,
    });
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "sale.refund_item",
      entityType: "sale",
      entityId: saleItem.saleId,
      metadata: {
        refundId,
        refundTotal,
        saleItemId: saleItem.id,
        reason: options.reason,
        disposition: options.disposition,
        refundMethod: options.refundMethod ?? "cash",
      },
    });
    await pushRefundStatusAfterCommit(businessId, saleItem.saleId);
    return {
      message: "Refund created successfully",
      refundId,
      refundTotal,
      saleItemSaleId: saleItem.saleId,
    };
  });

  // Provider payout fires after the ledger commits (ledger-first; retryable).
  let providerPayout: Awaited<
    ReturnType<typeof settleProviderRefundAfterCommit>
  > | null = null;
  if (options.refundMethod === "original_payment") {
    providerPayout = await settleProviderRefundAfterCommit(
      businessId,
      result.saleItemSaleId,
      result.refundId,
      result.refundTotal,
    );
  }
  return { ...result, providerPayout };
}

export async function createMultipleRefunds(
  businessId: number,
  id: number,
  options: SaleRefundRequest,
  actorUserId: number | null = null,
) {
  const result = await db.transaction(async (tx) => {
    const [sale] = await tx
      .select({ id: sales.id, status: sales.status })
      .from(sales)
      .where(and(eq(sales.id, id), eq(sales.businessId, businessId)))
      .for("update");
    if (!sale) throw new NotFoundError("Sale not found");
    if (sale.status !== "completed") {
      throw new ConflictError("Only completed sales can be returned");
    }

    // Phase 1: manager approval when the business requires it for refunds —
    // consumed inside this transaction so a rollback un-burns the token.
    if (await isApprovalRequired(businessId, "sale.refund")) {
      if (!options.approvalToken) {
        throw new ForbiddenError(
          "A manager approval is required to refund this sale.",
        );
      }
      await consumeApprovalInTx(tx, businessId, {
        token: options.approvalToken,
        opType: "sale.refund",
        entityType: "sale",
        entityId: id,
      });
    }

    const items = await tx
      .select()
      .from(saleItems)
      .where(
        and(eq(saleItems.saleId, id), eq(saleItems.businessId, businessId)),
      )
      .for("update");
    if (items.length === 0) throw new NotFoundError("Sale items not found");

    // Returnable = received − previously returned (per line). Fully
    // returned lines drop out; partially returned lines refund the rest.
    const alreadyReturned = await tx
      .select({
        saleItemId: saleRefundItems.saleItemId,
        returned: sql<string>`COALESCE(SUM(${saleRefundItems.quantity}), 0)`,
      })
      .from(saleRefundItems)
      .innerJoin(saleRefunds, eq(saleRefundItems.refundId, saleRefunds.id))
      .where(
        and(
          eq(saleRefundItems.businessId, businessId),
          eq(saleRefunds.saleId, id),
          inArray(
            saleRefundItems.saleItemId,
            items.map((item) => item.id),
          ),
        ),
      )
      .groupBy(saleRefundItems.saleItemId);
    const returnedBy = new Map<number, number>(
      alreadyReturned.flatMap((row) =>
        row.saleItemId === null ? [] : [[row.saleItemId, Number(row.returned)] as const],
      ),
    );
    const refundableItems = items.filter(
      (item) => item.quantity - (returnedBy.get(item.id) ?? 0) > 0,
    );
    if (refundableItems.length === 0) {
      throw new ConflictError("All items in this sale have already been returned");
    }

    const { refundId, refundTotal, restockedCost, locationId: refundLocationId } =
      await applySaleRefund(tx, businessId, id, refundableItems, options);
    // Counter payout (see createSingleRefund): cash refunds leave the
    // drawer transactionally; original_payment/store_credit never do.
    if (options.refundMethod === undefined || options.refundMethod === "cash") {
      await recordCashRefundInTx(
        tx,
        businessId,
        actorUserId,
        refundLocationId,
        refundTotal,
        refundId,
      );
    }
    // Finance & Growth: post the refund to the ledger (see createSingleRefund).
    await postRefundLedgerEntry(tx, {
      businessId,
      saleId: id,
      refundId,
      refundTotal,
      cashOut:
        options.refundMethod === undefined || options.refundMethod === "cash"
          ? refundTotal
          : 0,
      nonCashMethod: options.refundMethod ?? null,
      restockedCost,
      locationId: refundLocationId,
      actorUserId,
    });
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "sale.refund_sale",
      entityType: "sale",
      entityId: id,
      metadata: {
        refundId,
        refundTotal,
        itemCount: refundableItems.length,
        reason: options.reason,
        disposition: options.disposition,
        refundMethod: options.refundMethod ?? "cash",
      },
    });
    await pushRefundStatusAfterCommit(businessId, id);
    return { message: "Refund created successfully", refundId, refundTotal };
  });

  let providerPayout: Awaited<
    ReturnType<typeof settleProviderRefundAfterCommit>
  > | null = null;
  if (options.refundMethod === "original_payment") {
    providerPayout = await settleProviderRefundAfterCommit(
      businessId,
      id,
      result.refundId,
      result.refundTotal,
    );
  }
  return { ...result, providerPayout };
}
export async function getDashboardSummary(
  businessId: number,
  period: DashboardPeriod = "today",
  staleDays = 60,
  staleLimit = 10,
  locationId?: number,
) {
  const [
    salesOverview,
    top_sold_products_by_category,
    profitByCategory,
    topItemsByGross,
    productsSummary,
    salesSummary,
    salesActivity,
    paymentBreakdown,
    netProfit,
    invoiceDue,
    expensesSummary,
    purchasesSummary,
    return_summary,
    recentSalesSummary,
    lowStockSummary,
    staleStockSummary,
    topSellingProducts,
  ] = await Promise.all([
    getSalesOverview(businessId, period, locationId),
    getTopCategories(businessId, period, locationId),
    getProfitByCategory(businessId, period, locationId),
    getTopItemsByGross(businessId, period, locationId),
    getProductsSummary(businessId, locationId),
    getSalesSummary(businessId, period, locationId),
    getSalesActivity(businessId, period, locationId),
    getPaymentBreakdown(businessId, period, locationId),
    getNetProfit(businessId, period, locationId),
    getInvoiceDues(businessId, locationId),
    getExpensesSummary(businessId, period, locationId),
    getPurchasesSummary(businessId, period, locationId),
    getReturnSummary(businessId, period, locationId),
    getRecentSalesSummary(businessId, period, locationId),
    getLowStockSummary(businessId, locationId),
    getStaleStockSummary(businessId, staleDays, staleLimit, locationId),
    getTopSellingProducts(businessId, period, locationId),
  ]);
  return {
    salesOverview: salesOverview.rows,
    top_sold_products_by_category: top_sold_products_by_category.rows,
    profitByCategory: profitByCategory.rows,
    topItemsByGross: topItemsByGross.rows,
    productsSummary: productsSummary.rows,
    salesSummary: salesSummary.rows,
    salesActivity: salesActivity.rows,
    paymentBreakdown: paymentBreakdown.rows,
    netProfit: netProfit.rows,
    invoiceDue: invoiceDue.rows,
    expensesSummary: expensesSummary.rows,
    purchasesSummary: purchasesSummary.rows,
    return_summary: return_summary.rows,
    recentSalesSummary: recentSalesSummary.rows,
    lowStockSummary: lowStockSummary.rows,
    staleStockSummary: staleStockSummary.rows,
    topSellingProducts: topSellingProducts.rows,
  };
}
// GET /variants/:variantId/serials
export async function getAvailableSerials(
  businessId: number,
  variantId: number,
) {
  const rows = await db
    .select({ serialNumber: serialNumbers.serialNumber })
    .from(serialNumbers)
    .where(
      and(
        eq(serialNumbers.variantId, variantId),
        eq(serialNumbers.businessId, businessId),
        eq(serialNumbers.status, "in_stock"),
      ),
    )
    .orderBy(asc(serialNumbers.id));
  return rows.map((r) => r.serialNumber);
}

export async function updateAvailableSerial(
  businessId: number,
  variantId: number,
  currentSerial: string,
  serialNumber: string,
) {
  try {
    const [updated] = await db
      .update(serialNumbers)
      .set({ serialNumber })
      .where(
        and(
          eq(serialNumbers.variantId, variantId),
          eq(serialNumbers.businessId, businessId),
          eq(serialNumbers.serialNumber, currentSerial),
          eq(serialNumbers.status, "in_stock"),
        ),
      )
      .returning({ serialNumber: serialNumbers.serialNumber });

    if (!updated) {
      throw new NotFoundError("Available serial number not found");
    }

    return updated.serialNumber;
  } catch (err: unknown) {
    throw new ConflictError("Serial number is already in use");
  }
}

// ---------------------------------------------------------------------------
// Exchanges (Module 5). An exchange = refund of the returned items + a new
// replacement sale linked via sales.exchange_of_sale_id + settlement of the
// difference — all in ONE transaction, so stock, financials and the refund
// ledger can never drift apart.
// ---------------------------------------------------------------------------

export interface ExchangePayload {
  /** Full-item returns (the existing refund model is per sale item). */
  returns: { saleItemId: number }[];
  replacements: {
    variantId: number;
    quantity: number;
    discount?: { type: "percentage" | "fixed"; value: number } | null | undefined;
    uomConversionId?: number | null | undefined;
  }[];
  /** Required when the replacement is worth more than the returned value. */
  additionalPayments?: {
    method: "cash" | "bangla_qr" | "card";
    amount: number;
    reference?: string | null | undefined;
    tendered?: number | null | undefined;
  }[] | undefined;
  /** How a surplus (returned value > replacement) goes back to the customer. */
  refundMethod?: "cash" | "original_payment" | undefined;
  reason: "customer_request" | "wrong_item" | "damaged" | "quality_issue" | "other";
  notes?: string | undefined;
  disposition: "restock" | "inspection" | "damaged";
  idempotencyKey?: string | undefined;
}

/**
 * Resolves the provider payout for an original_payment refund AFTER the
 * ledger transaction has committed. Ledger-first: the refund row is valid
 * regardless; provider_refund_id is filled only on a successful payout and
 * stays NULL (retryable) otherwise. Never throws to the caller of the
 * refund — the outcome is returned and audited.
 */
export async function settleProviderRefundAfterCommit(
  businessId: number,
  saleId: number,
  refundId: number,
  refundTotal: number,
): Promise<{ paid: boolean; providerRefundId: string | null; status: string; reason?: string }> {
  let intent: { provider: string; providerTxnId: string | null } | undefined;
  try {
    [intent] = await db
      .select({
        provider: salePaymentIntents.provider,
        providerTxnId: salePaymentIntents.providerTxnId,
      })
      .from(salePaymentIntents)
      .where(
        and(
          eq(salePaymentIntents.saleId, saleId),
          eq(salePaymentIntents.businessId, businessId),
          eq(salePaymentIntents.status, "captured"),
        ),
      )
      .orderBy(desc(salePaymentIntents.id))
      .limit(1);
  } catch {
    intent = undefined;
  }
  if (!intent?.providerTxnId) {
    return {
      paid: false,
      providerRefundId: null,
      status: "NO_CAPTURED_PAYMENT",
      reason:
        "No verified electronic payment exists on this sale — use a cash refund instead.",
    };
  }
  const resolved = await resolveIntentProvider(businessId, intent.provider);
  if ("error" in resolved) {
    return { paid: false, providerRefundId: null, status: "CONFIG_ERROR", reason: resolved.error };
  }
  if (!resolved.provider.supportsRefund || !resolved.provider.refundPayment) {
    return {
      paid: false,
      providerRefundId: null,
      status: "PROVIDER_UNSUPPORTED",
      reason: `The ${intent.provider} adapter does not support refunds — settle externally.`,
    };
  }
  try {
    const outcome = await resolved.provider.refundPayment({
      transactionId: intent.providerTxnId,
      amount: refundTotal,
      reason: "ezPos sale refund",
    });
    if (!outcome.accepted) {
      await recordAudit({
        businessId,
        actorUserId: null,
        action: "sale.refund.provider_rejected",
        entityType: "sale_refund",
        entityId: refundId,
        metadata: { provider: intent.provider, status: outcome.status, amount: refundTotal },
      });
      return {
        paid: false,
        providerRefundId: null,
        status: outcome.status,
        reason:
          "The provider rejected the refund. The refund is recorded in the ledger; retry the payout later.",
      };
    }
    await db
      .update(saleRefunds)
      .set({ providerRefundId: outcome.refundId })
      .where(and(eq(saleRefunds.id, refundId), eq(saleRefunds.businessId, businessId)));
    await recordAudit({
      businessId,
      actorUserId: null,
      action: "sale.refund.provider_paid",
      entityType: "sale_refund",
      entityId: refundId,
      metadata: {
        provider: intent.provider,
        providerRefundId: outcome.refundId,
        amount: refundTotal,
      },
    });
    return { paid: true, providerRefundId: outcome.refundId, status: outcome.status };
  } catch (err) {
    await recordAudit({
      businessId,
      actorUserId: null,
      action: "sale.refund.provider_error",
      entityType: "sale_refund",
      entityId: refundId,
      metadata: {
        provider: intent.provider,
        amount: refundTotal,
        error: err instanceof Error ? err.message : "unknown",
      },
    });
    return {
      paid: false,
      providerRefundId: null,
      status: "PROVIDER_ERROR",
      reason:
        "The provider could not be reached. The refund is recorded in the ledger; retry the payout later.",
    };
  }
}

export async function createSaleExchange(
  businessId: number,
  saleId: number,
  actorUserId: number | null,
  payload: ExchangePayload,
  terminalId: number | null = null,
) {
  const idempotencyKey = payload.idempotencyKey?.trim() || null;
  const payloadHash = idempotencyKey ? sha256OfJson(payload) : null;
  if (payload.returns.length === 0) {
    throw new BadRequestError("An exchange requires at least one returned item.");
  }
  if (payload.replacements.length === 0) {
    throw new BadRequestError("An exchange requires at least one replacement item.");
  }

  const result = await db.transaction(async (tx) => {
    // 0. Idempotent replay: the replacement sale carries the key.
    if (idempotencyKey) {
      const replay = await findSaleByIdempotencyKey(tx, businessId, idempotencyKey, payloadHash);
      if (replay) return { replayed: true as const, ...replay };
    }

    // 1. The original sale: completed only (refunded sales have nothing
    // left to return; pending sales are not refundable either).
    const [original] = await tx
      .select({
        id: sales.id,
        customerId: sales.customerId,
        locationId: sales.locationId,
        paymentStatus: sales.paymentStatus,
        status: sales.status,
      })
      .from(sales)
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
      .for("update");
    if (!original) throw new NotFoundError("Sale not found.");
    if (original.status !== "completed") {
      throw new ConflictError(
        `Only completed sales can be exchanged (this one is ${original.status}).`,
      );
    }
    const exchangeLocationId = original.locationId;
    if (exchangeLocationId === null) {
      throw new ConflictError("The original sale has no location recorded.");
    }

    // 2. Returned items must belong to this sale and not be refunded yet.
    const returnIds = payload.returns.map((r) => r.saleItemId);
    const returnable = await tx
      .select()
      .from(saleItems)
      .where(
        and(
          eq(saleItems.saleId, saleId),
          eq(saleItems.businessId, businessId),
          inArray(saleItems.id, returnIds),
        ),
      );
    if (returnable.length !== new Set(returnIds).size) {
      throw new NotFoundError(
        "One or more returned items do not belong to this sale.",
      );
    }
    const alreadyRefunded = await tx
      .select({ saleItemId: saleRefundItems.saleItemId })
      .from(saleRefundItems)
      .innerJoin(saleRefunds, eq(saleRefundItems.refundId, saleRefunds.id))
      .where(
        and(
          eq(saleRefunds.saleId, saleId),
          eq(saleRefunds.businessId, businessId),
          inArray(saleRefundItems.saleItemId, returnIds),
        ),
      );
    if (alreadyRefunded.length > 0) {
      throw new ConflictError(
        "One or more returned items have already been refunded.",
      );
    }

    // 3. Refund side: the SAME allocation, ceiling, restock and serial
    // machinery as normal returns — one code path, no drift.
    const { refundId, refundTotal, restockedCost } = await applySaleRefund(
      tx,
      businessId,
      saleId,
      returnable,
      {
        reason: payload.reason,
        notes: payload.notes,
        disposition: payload.disposition,
        refundMethod: payload.refundMethod,
      },
    );

    // 4. Replacement side: trusted prices from the database, serial-tracked
    // replacements rejected (serial selection is a POS workflow — v1).
    const replacementItems = payload.replacements.map((r) => ({
      variantId: r.variantId,
      quantity: r.quantity,
      unitPrice: 0, // replaced by the DB price below
      discount: r.discount ?? null,
      uomConversionId: r.uomConversionId ?? null,
    }));
    const { variantIds, existingVariants } = await validateVariants(
      tx,
      businessId,
      replacementItems,
    );
    const variantMap = new Map(existingVariants.map((v) => [v.id, v]));
    for (const variant of existingVariants) {
      if (variant.trackingType === "serial") {
        throw new BadRequestError(
          "Serial-tracked products cannot be exchanged automatically yet — sell the replacement as a normal sale.",
        );
      }
    }
    // UOM boundary: identical conversion to createSale (base quantities +
    // per-base prices; entered units preserved as snapshots).
    const baseReplacements = await normalizeSaleItemsToBase(
      tx,
      businessId,
      existingVariants,
      replacementItems,
    );
    const trustedReplacements = baseReplacements
      .map((item) => {
        const variant = variantMap.get(item.variantId);
        const unitPrice = item.unitPrice;
        if (!variant || !Number.isFinite(unitPrice) || unitPrice < 0) {
          throw new NotFoundError(
            `Valid selling price not found for variant ${item.variantId}.`,
          );
        }
        return {
          ...item,
          unitPrice,
          trackingType: variant.trackingType,
          productId: variant.productId,
        };
      })
      .sort((a, b) => a.variantId - b.variantId);

    await validateStock(tx, businessId, exchangeLocationId, variantIds, trustedReplacements);

    // 5. Totals with the tax engine (same rules resolution as createSale).
    const taxRulesByVariant = await resolveTaxRulesForSale(
      tx,
      businessId,
      exchangeLocationId,
      new Date(),
      trustedReplacements.map((i) => i.variantId),
    );
    const usesTaxRules = [...taxRulesByVariant.values()].some(
      (rules) => rules.length > 0,
    );
    const totals = usesTaxRules
      ? getCartTotalsWithTaxRules(trustedReplacements, null, taxRulesByVariant)
      : getCartTotals(trustedReplacements, null, 0);
    const lineTaxes = "perLine" in totals ? totals.perLine : null;

    // 6. Difference settlement. Both directions must be fully settled:
    // exchanges never create dues.
    const replacementTotal = totals.finalTotal;
    const difference = roundMoney(replacementTotal - refundTotal);
    const additionalPayments = payload.additionalPayments ?? [];
    let cashAmount = 0;
    if (difference > 0.01) {
      const paidSum = roundMoney(
        additionalPayments.reduce((sum, p) => sum + Number(p.amount ?? 0), 0),
      );
      if (additionalPayments.length === 0 || Math.abs(paidSum - difference) > 0.01) {
        throw new BadRequestError(
          `The replacement costs ${difference.toFixed(2)} more than the returned value — collect exactly that amount.`,
        );
      }
      for (const payment of additionalPayments) {
        if (!["cash", "bangla_qr", "card"].includes(payment.method)) {
          throw new BadRequestError("Exchanges settle immediately — due is not allowed.");
        }
        if (payment.method === "cash") {
          cashAmount = roundMoney(cashAmount + Number(payment.amount ?? 0));
        }
      }
    } else if (difference < -0.01 && !payload.refundMethod) {
      throw new BadRequestError(
        `The returned value exceeds the replacement by ${(-difference).toFixed(2)} — choose how to refund the difference.`,
      );
    }

    // 7. The replacement sale.
    const invoiceNumber = formatSaleInvoiceNumber(
      new Date().getFullYear(),
      await nextDocumentNumber(tx, businessId, "sale_invoice"),
    );
    const [exchangeSale] = await tx
      .insert(sales)
      .values({
        businessId,
        locationId: exchangeLocationId,
        invoiceNumber,
        saleDate: new Date(),
        customerId: original.customerId,
        subtotal: totals.itemsBase,
        discount: roundMoney(totals.itemDiscount + totals.cartDiscountAmount),
        vat: totals.vat,
        finalTotal: replacementTotal,
        dueAmount: 0,
        paymentStatus: "paid",
        status: "completed",
        exchangeOfSaleId: saleId,
        idempotencyKey,
        idempotencyPayloadHash: payloadHash,
        terminalId,
        cashierUserId: actorUserId,
        note: payload.notes ?? null,
      })
      .onConflictDoNothing({
        target: [sales.businessId, sales.idempotencyKey],
      })
      .returning({
        id: sales.id,
        invoiceNumber: sales.invoiceNumber,
        subtotal: sales.subtotal,
        discount: sales.discount,
        vat: sales.vat,
        finalTotal: sales.finalTotal,
        dueAmount: sales.dueAmount,
        paymentStatus: sales.paymentStatus,
      });
    if (!exchangeSale) {
      if (!idempotencyKey) {
        throw new ConflictError("Exchange sale insert returned no row.");
      }
      const replay = await findSaleByIdempotencyKey(tx, businessId, idempotencyKey, payloadHash);
      if (!replay) throw new ConflictError("Exchange sale insert returned no row.");
      return { replayed: true as const, ...replay };
    }

    // Items: stock consumption + tax snapshots (same machinery as createSale).
    // The replacement is a real sale: batches AND the per-location stock row
    // must both move, plus the sale movement row — omitting the stock
    // decrement desynchronized batches from inventory_stock (audit R1).
    const exchangeWarrantyItems: WarrantyGenerationItem[] = [];
    for (const [itemIndex, item] of trustedReplacements.entries()) {
      const line = getLinePricing(item.unitPrice, item.quantity, item.discount);
      const cost = await consumeStockFifo(
        tx,
        businessId,
        exchangeLocationId,
        item.variantId,
        item.quantity,
      );
      if (!Number.isFinite(cost.costAtSale) || cost.costAtSale < 0) {
        throw new Error(`Invalid inventory cost for variant ${item.variantId}.`);
      }
      const lineTax = lineTaxes?.[itemIndex];
      const [saleItem] = await tx
        .insert(saleItems)
        .values({
          businessId,
          saleId: exchangeSale.id,
          variantId: item.variantId,
          quantity: item.quantity,
          sellingPrice: item.unitPrice,
          costAtSale: cost.costAtSale,
          lineTotal: line.total,
          discount: line.discountAmount,
          taxAmount: lineTax?.taxAmount ?? 0,
          taxDetail: lineTax?.detail ?? [],
        })
        .returning({ id: saleItems.id });
      if (!saleItem) throw new Error("Failed to create exchange sale item.");
      if (cost.consumed?.length) {
        await insertSaleItemConsumptions(
          tx,
          businessId,
          exchangeSale.id,
          saleItem.id,
          item.variantId,
          cost.consumed,
        );
      }
      // validateStock already locked this row and verified availability —
      // the decrement itself is unconditional, exactly like createSale.
      const updatedRows = await tx
        .update(inventoryStock)
        .set({
          quantity: sql`${inventoryStock.quantity} - ${item.quantity}`,
        })
        .where(
          and(
            eq(inventoryStock.variantId, item.variantId),
            eq(inventoryStock.businessId, businessId),
            eq(inventoryStock.locationId, exchangeLocationId),
          ),
        )
        .returning({
          variantId: inventoryStock.variantId,
        });
      if (updatedRows.length !== 1) {
        throw new Error(
          `Failed to update stock for variant ${item.variantId}.`,
        );
      }
      await tx.insert(inventoryMovements).values({
        businessId,
        variantId: item.variantId,
        locationId: exchangeLocationId,
        movementType: "sale",
        quantity: item.quantity,
        referenceType: "sale",
        referenceId: exchangeSale.id,
      });

      // Replacement items earn warranties like any other sale (D2). Serial-
      // tracked replacements are rejected upstream, so these are always
      // quantity-based rows keyed to the replacement sale's customer.
      exchangeWarrantyItems.push({
        saleItemId: saleItem.id,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        serialIds: [],
      });
    }

    if (exchangeWarrantyItems.length > 0) {
      await createWarrantiesForSaleItems(tx, {
        businessId,
        locationId: exchangeLocationId,
        saleId: exchangeSale.id,
        saleDate: new Date(),
        customerId: original.customerId ?? null,
        items: exchangeWarrantyItems,
      });
    }

    // Additional payments land as normal payment rows on the replacement
    // sale; the cash portion is attributed to the open register session.
    if (difference > 0.01 && additionalPayments.length > 0) {
      try {
        await tx.insert(salePayments).values(
          additionalPayments.map((payment) => ({
            businessId,
            saleId: exchangeSale.id,
            customerId: original.customerId,
            amount: roundMoney(Number(payment.amount)),
            paymentMethod: payment.method,
            reference:
              payment.method === "cash"
                ? null
                : payment.reference?.trim() || null,
            tendered:
              payment.method === "cash" ? (payment.tendered ?? null) : null,
          })),
        );
      } catch (error: unknown) {
        if (isDuplicatePaymentReferenceError(error)) {
          throw new ConflictError(
            "This transaction reference has already been used for this payment method.",
          );
        }
        throw error;
      }
      if (cashAmount > 0) {
        await recordCashSaleInTx(
          tx,
          businessId,
          actorUserId ?? 0,
          exchangeLocationId,
          cashAmount,
          exchangeSale.id,
          terminalId,
        );
      }
    }

    // Surplus payout in cash: when the returned value exceeds the
    // replacement and the customer takes the difference as counter cash,
    // that payout leaves the drawer. The returned value itself is NOT a
    // cash movement — it nets against the replacement sale. A payout to
    // the original instrument (gateway) never touches drawer cash.
    const cashSurplusPayout =
      difference < -0.01 &&
      (payload.refundMethod === undefined || payload.refundMethod === "cash")
        ? roundMoney(-difference)
        : 0;
    if (cashSurplusPayout > 0) {
      await recordCashRefundInTx(
        tx,
        businessId,
        actorUserId,
        exchangeLocationId,
        cashSurplusPayout,
        refundId,
        terminalId,
      );
    }

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "sale.exchange",
      entityType: "sale",
      entityId: saleId,
      metadata: {
        exchangeSaleId: exchangeSale.id,
        exchangeInvoiceNumber: exchangeSale.invoiceNumber,
        refundId,
        refundTotal,
        replacementTotal,
        difference,
        refundMethod: payload.refundMethod ?? (difference < -0.01 ? "cash" : null),
        disposition: payload.disposition,
      },
    });

    // Finance & Growth: post both sides of the exchange to the ledger.
    // The refund's non-cash value lands on 1040 (customer credit) and is
    // consumed by the replacement sale's own 1040 residual line — the two
    // entries net the receivable to zero. Only the surplus payout moves cash.
    await postRefundLedgerEntry(tx, {
      businessId,
      saleId,
      refundId,
      refundTotal,
      cashOut: cashSurplusPayout,
      nonCashMethod: payload.refundMethod ?? null,
      restockedCost,
      locationId: exchangeLocationId,
      actorUserId,
    });
    await postSaleLedgerEntry(tx, {
      saleId: exchangeSale.id,
      businessId,
      locationId: exchangeLocationId,
      payments:
        difference > 0.01
          ? additionalPayments.map((payment) => ({
              method: payment.method,
              amount: Number(payment.amount ?? 0),
            }))
          : [],
      actorUserId,
    });

    return {
      replayed: false as const,
      sale: exchangeSale,
      exchangeLocationId,
      refundId,
      refundTotal,
      replacementTotal,
      difference,
      change: 0,
      paidAmount: difference > 0.01 ? difference : 0,
      dueAmount: 0,
    };
  });

  if (result.replayed) {
    const receipt = await getSaleReceipt(businessId, result.sale.id);
    return { ...result, receipt, providerPayout: null };
  }

  // 8. Surplus payout to the original instrument, after commit (ledger-first).
  let providerPayout: { paid: boolean; status: string; reason?: string } | null = null;
  if (
    result.difference < -0.01 &&
    payload.refundMethod === "original_payment"
  ) {
    const surplus = roundMoney(-result.difference);
    providerPayout = await settleProviderRefundAfterCommit(
      businessId,
      saleId,
      result.refundId,
      surplus,
    );
  }

  const receipt = await getSaleReceipt(businessId, result.sale.id);
  if (!result.replayed) {
    publishRealtime(businessId, result.exchangeLocationId, {
      kind: "sale.created",
      locationId: result.exchangeLocationId,
      saleId: result.sale.id,
    });
  }
  return { ...result, receipt, providerPayout };
}

// ---------------------------------------------------------------------------
// Server-authoritative cart quote (checkout consistency). The POS displays
// totals from this endpoint so the cashier always sees what createSale will
// charge — including rules-based taxes that the client cannot compute.
// ---------------------------------------------------------------------------

export interface SaleQuotePayload {
  items: {
    variantId: number;
    /** ENTERED quantity — in the line's selling unit (base when no UOM). */
    quantity: number;
    discount?: DiscountInput | null | undefined;
    uomConversionId?: number | null | undefined;
    priceOverride?: { unitPrice: number; reason?: string | undefined } | null | undefined;
  }[];
  cartDiscount?: DiscountInput | null | undefined;
  vatPercent?: number | null | undefined;
  couponCode?: string | null | undefined;
  customerId?: number | null | undefined;
}

export async function quoteSaleTotals(
  businessId: number,
  locationId: number,
  payload: SaleQuotePayload,
) {
  if (payload.items.length === 0) {
    throw new BadRequestError("A quote requires at least one item.");
  }
  return db.transaction(async (tx) => {
    const variantIds = [...new Set(payload.items.map((i) => i.variantId))];
    const variants = await tx
      .select({
        id: productVariants.id,
        productId: productVariants.productId,
        sellingPrice: productVariants.sellingPrice,
        minSellingPrice: productVariants.minSellingPrice,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.businessId, businessId),
          inArray(productVariants.id, variantIds),
        ),
      );
    const priceById = new Map(
      variants.map((v) => [v.id, Number(v.sellingPrice)]),
    );
    // Existence guard (same contract as createSale's validateVariants): a
    // quote for a variant outside this business must 404, never price at 0.
    const missingVariants = variantIds.filter((id) => !priceById.has(id));
    if (missingVariants.length > 0) {
      throw new NotFoundError(
        `Variants not found in this business: ${missingVariants.join(", ")}.`,
      );
    }
    // UOM boundary: identical conversion to createSale, so a quoted total
    // always matches the checkout total for the same cart.
    const baseItems = await normalizeSaleItemsToBase(
      tx,
      businessId,
      variants,
      payload.items.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
        discount: item.discount ?? null,
        uomConversionId: item.uomConversionId ?? null,
        priceOverride: item.priceOverride ?? null,
      })),
    );
    const trustedItems = baseItems.map((item) => {
      const unitPrice = item.unitPrice;
      if (unitPrice === undefined || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new NotFoundError(
          `Valid selling price not found for variant ${item.variantId}.`,
        );
      }
      return {
        variantId: item.variantId,
        quantity: item.quantity,
        unitPrice,
        discount: item.discount,
      };
    });

    const taxRulesByVariant = await resolveTaxRulesForSale(
      tx,
      businessId,
      locationId,
      new Date(),
      variantIds,
    );
    const usesTaxRules = [...taxRulesByVariant.values()].some(
      (rules) => rules.length > 0,
    );
    // Customer-group layer (Phase 4): identical evaluation to createSale so
    // the quoted total always equals the checkout total.
    const groupPricing = await evaluateSaleGroupPricing(
      tx,
      businessId,
      payload.customerId ?? null,
      trustedItems,
    );
    const groupInput = toCartGroupInput(groupPricing);
    // Promotion layer (Phase 5): same evaluation as createSale — a coupon in
    // the request suppresses promotions that don't stack with coupons.
    const promoEvaluation = await evaluateSalePromotions(
      tx,
      businessId,
      trustedItems,
      groupPricing,
      Boolean(payload.couponCode?.trim()),
      { locationId, customerId: payload.customerId ?? null },
    );
    const promoInput = toCartPromotionInput(promoEvaluation);
    const groupBlock =
      groupPricing.groupId != null && groupPricing.total > 0
        ? {
            group: {
              id: groupPricing.groupId,
              name: groupPricing.groupName ?? "",
              discountAmount: groupPricing.total,
            },
          }
        : {};
    const promotionsBlock = {
      ...(promoEvaluation.applied.length > 0
        ? {
            promotions: {
              applied: promoEvaluation.applied,
              total: promoEvaluation.total,
            },
          }
        : {}),
      // Phase 3 offer discovery: promotions the cart almost qualifies for.
      ...(promoEvaluation.nearMisses.length > 0
        ? { nearMisses: promoEvaluation.nearMisses }
        : {}),
    };
    const totals = usesTaxRules
      ? getCartTotalsWithTaxRules(trustedItems, payload.cartDiscount ?? null, taxRulesByVariant, groupInput, promoInput)
      : getCartTotals(trustedItems, payload.cartDiscount ?? null, Number(payload.vatPercent ?? 0), groupInput, promoInput);

    // Minimum-price protection (Phase 6): the quote WARNS always (block or
    // approve happens at createSale, permission-gated there).
    const minPriceById = new Map(
      variants.map((v) => [v.id, v.minSellingPrice == null ? null : Number(v.minSellingPrice)] as const),
    );
    const floorViolations = await evaluateMinimumFloors(
      tx,
      businessId,
      trustedItems.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
        minSellingPrice: minPriceById.get(item.variantId) ?? null,
      })),
      lineChargeAfterAllocations(trustedItems, totals),
    );
    const warningsBlock =
      floorViolations.length > 0
        ? {
            warnings: floorViolations.map((v) => ({
              variantId: v.variantId,
              code: "below_minimum" as const,
              message: v.message,
              effectiveUnitPrice: v.effectiveUnitPrice,
              minPrice: v.minPrice,
              marginPercent: v.marginPercent,
              floorMarginPercent: v.floorMarginPercent,
            })),
          }
        : {};

    // Coupon preview: same evaluation rules as createSale (no lock), same
    // v1 stacking rule — a coupon excludes the MANUAL cart-level discount
    // but stacks with the automatic customer-group discount.
    let coupon: { code: string; discountAmount: number; description: string | null } | null = null;
    const couponCode = payload.couponCode?.trim();
    if (couponCode && payload.cartDiscount !== null && payload.cartDiscount !== undefined) {
      return {
        itemsBase: totals.itemsBase,
        itemDiscount: totals.itemDiscount,
        itemsTotal: totals.itemsTotal,
        cartDiscountAmount: totals.cartDiscountAmount,
        afterDiscount: totals.afterDiscount,
        vatPercent: "vatPercent" in totals ? totals.vatPercent : 0,
        vat: totals.vat,
        finalTotal: totals.finalTotal,
        usesTaxRules,
        perLine: "perLine" in totals ? totals.perLine : [],
        ...groupBlock,
        ...promotionsBlock,
        ...warningsBlock,
        couponError:
          "Use either a cart discount or a coupon — not both.",
      };
    }
    if (couponCode) {
      try {
        const evaluation = await evaluateCouponInTx(tx, {
          businessId,
          code: couponCode,
          afterDiscountTotal: totals.afterDiscount,
          customerId: payload.customerId ?? null,
        });
        coupon = {
          code: evaluation.code,
          discountAmount: evaluation.discountAmount,
          description: evaluation.description,
        };
      } catch (err) {
        return {
          itemsBase: totals.itemsBase,
          itemDiscount: totals.itemDiscount,
          itemsTotal: totals.itemsTotal,
          cartDiscountAmount: totals.cartDiscountAmount,
          afterDiscount: totals.afterDiscount,
          vatPercent: "vatPercent" in totals ? totals.vatPercent : 0,
          vat: totals.vat,
          finalTotal: totals.finalTotal,
          usesTaxRules,
          perLine: "perLine" in totals ? totals.perLine : [],
          ...groupBlock,
          ...promotionsBlock,
          ...warningsBlock,
          couponError:
            err instanceof Error ? err.message : "Coupon is not valid.",
        };
      }
    }
    const couponDiscount = coupon?.discountAmount ?? 0;
    const perLine = "perLine" in totals ? totals.perLine : [];
    return {
      itemsBase: totals.itemsBase,
      itemDiscount: totals.itemDiscount,
      itemsTotal: totals.itemsTotal,
      cartDiscountAmount: totals.cartDiscountAmount,
      afterDiscount: totals.afterDiscount,
      vatPercent: "vatPercent" in totals ? totals.vatPercent : 0,
      vat: totals.vat,
      finalTotal: roundMoney(Math.max(0, totals.finalTotal - couponDiscount)),
      usesTaxRules,
      perLine,
      ...groupBlock,
      ...promotionsBlock,
      ...warningsBlock,
      ...(coupon ? { coupon } : {}),
      ...(coupon === null && couponCode
        ? { couponError: "Coupon is not valid." }
        : {}),
    };
  });
}
