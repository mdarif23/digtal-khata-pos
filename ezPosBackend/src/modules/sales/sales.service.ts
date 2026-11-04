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
  NotFoundError,
} from "../../utils/handleError.js";
import { saleRefunds } from "../../db/schema/saleRefunds.js";
import { saleRefundItems } from "../../db/schema/saleRefundItems.js";
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
import {
  earnLoyaltyPointsInTx,
  redeemLoyaltyPointsInTx,
  reverseLoyaltyPointsInTx,
} from "../../services/loyalty.js";
import { redeemGiftCardInTx } from "../../services/giftCards.js";
import {
  evaluateCouponInTx,
  recordCouponRedemptionInTx,
} from "../../services/coupons.js";
import { notifyStockLevel } from "../../services/notifications.js";
import { publishRealtime } from "../realtime/realtime.service.js";
import {
  customerValidation,
  validatePayments,
  validateStock,
  validateVariants,
  type Items,
} from "./sales.validation.js";
import { roundMoney } from "../../utils/roundMoney.js";
import {
  recordCashRefundInTx,
  recordCashSaleInTx,
} from "../cashRegisters/cashRegisters.service.js";
import { units } from "../../db/schema/units.js";
import { users } from "../../db/schema/users.js";
import {
  getDocumentBranding,
  getDocumentSettings,
} from "../documentSettings/documentSettings.service.js";
import {
  getCartTotals,
  getCartTotalsWithTaxRules,
  getLinePricing,
  type DiscountInput,
  type TaxRuleSnapshot,
} from "./utils/cartPricing.js";
import { taxRates } from "../../db/schema/taxRates.js";
import { productTaxes } from "../../db/schema/productTaxes.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { pushRefundStatusAfterCommit } from "../../modules/integrations/integrations.service.js";
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import type { DbTransaction } from "../purchases/purchase.types.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
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
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      category: categories.name,
      cost: saleItems.costAtSale,
      price: productVariants.sellingPrice,
      soldQuantity: saleItems.quantity,
      soldPrice: saleItems.sellingPrice,
      lineTotal: saleItems.lineTotal,
      createdAt: sales.createdAt,
    })
    .from(saleItems)
    .innerJoin(sales, eq(saleItems.saleId, sales.id))
    .innerJoin(productVariants, eq(saleItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
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

export async function consumeStockFifo(
  tx: DbTransaction,
  businessId: number,
  locationId: number,
  variantId: number,
  quantity: number,
) {
  // 1. Oldest batches first. .for("update") locks the rows, so two sales
  //    at the same moment can't take the same stock. FIFO is per-location:
  //    a sale only consumes batches stocked at its own location.
  const batches = await tx
    .select()
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

    totalCost += take * batch.purchasePrice;
    remaining -= take;
  }

  // 3. Not enough stock: throwing rolls back the whole sale transaction
  if (remaining > 0) {
    throw new Error(
      `Insufficient stock for variant ${variantId}: short by ${remaining}`,
    );
  }

  return {
    totalCost: roundMoney(totalCost),
    costAtSale: roundMoney(totalCost / quantity), // average cost per unit
  };
}
export async function consumeSerials(
  tx: DbTransaction,
  businessId: number,
  variantId: number,
  serials: string[],
) {
  if (serials.length === 0)
    throw new Error("Select at least one serial number");
  if (new Set(serials).size !== serials.length)
    throw new Error("Duplicate serial number");

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
    throw new Error("One or more serial numbers are not available");
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
    .select()
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

    totalCost += take * batch.purchasePrice;
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
      unitName: units.abbreviation,
    })
    .from(saleItems)
    .innerJoin(productVariants, eq(saleItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(units, eq(products.unitId, units.id))
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

export async function createSale(
  businessId: number,
  locationId: number,
  cashierUserId: number,
  data: CreateSalePayload,
) {
  const { customerId, items, discount, vatPercent, payments, saleDate } = data;
  const couponCode = data.couponCode?.trim() || null;
  const idempotencyKey = data.idempotencyKey?.trim() || null;

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

    // 3. Lock inventory rows and validate stock.
    await validateStock(tx, businessId, locationId, variantIds, items);

    // 2. Trusted prices and tracking types come from the database
    const variantMap = new Map(existingVariants.map((v) => [v.id, v]));

    const trustedItems = items
      .map((item) => {
        const variant = variantMap.get(item.variantId);
        const unitPrice = Number(variant?.sellingPrice);
        if (!variant || !Number.isFinite(unitPrice) || unitPrice < 0) {
          throw new NotFoundError(
            `Valid selling price not found for variant ${item.variantId}.`,
          );
        }
        return { ...item, unitPrice, trackingType: variant.trackingType };
      })
      .sort((a, b) => a.variantId - b.variantId); // same lock order for every cashier

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
    const totals = usesTaxRules
      ? getCartTotalsWithTaxRules(trustedItems, discount, taxRulesByVariant)
      : getCartTotals(trustedItems, discount, Number(vatPercent ?? 0));
    const lineTaxes = "perLine" in totals ? totals.perLine : null;

    // Coupons (Module 6): server-validated; v1 stacking rule — a coupon
    // replaces the cart-level discount (both is rejected). The discount
    // reduces the final charge; recorded on the sale via coupon_redemptions.
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

    const totalDiscount = roundMoney(
      totals.itemDiscount + totals.cartDiscountAmount,
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
        idempotencyKey,
        cashierUserId,
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
      );
      if (!replay) {
        throw new ConflictError("Sale insert returned no row.");
      }
      return replay;
    }

    const saleId = newSale.id;

    // 9. Insert sale items with price, cost, and tax snapshots. perLine is
    // index-aligned with trustedItems (both derive from the same list; unit
    // prices are pre-validated so no line is skipped in the totals pass).
    for (const [itemIndex, item] of trustedItems.entries()) {
      const line = getLinePricing(item.unitPrice, item.quantity, item.discount);
      const lineTax = lineTaxes?.[itemIndex];

      let cost: { totalCost: number; costAtSale: number; serialIds?: number[] };

      if (item.trackingType === "serial") {
        // read from the DB, never from the request
        const serials = item.serialNumbers ?? [];
        if (serials.length !== item.quantity) {
          throw new Error(
            `Select exactly ${item.quantity} serial number(s) for variant ${item.variantId}.`,
          );
        }
        cost = await consumeSerials(tx, businessId, item.variantId, serials);
      } else {
        cost = await consumeStockFifo(
          tx,
          businessId,
          locationId,
          item.variantId,
          item.quantity,
        );
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
        })
        .returning({ id: saleItems.id });
      if (!saleItem) throw new Error("Failed to create sale item.");

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

      const updatedRows = await tx
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

      // Stock alerts (Module 14): deduped per variant+location per day.
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
          await notifyStockLevel(tx, {
            businessId,
            variantId: item.variantId,
            productName: variantInfo.productName,
            newQuantity: Number(updatedRows[0]?.quantity ?? 0),
            alertQuantity: Number(variantInfo.alertQuantity ?? 0),
            locationId,
          });
        }
      }
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
        await recordCashSaleInTx(
          tx,
          businessId,
          cashierUserId,
          locationId,
          cashAmount,
          saleId,
        );
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
      },
    });

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

    // Loyalty earn on the cash-equivalent amount paid (Module 7): dues
    // earn nothing, and points/store-credit-funded portions do not earn
    // points on themselves.
    if (customerId !== null && paidAmount > 0) {
      const fundedByAccount = receivedPayments
        .filter(
          (payment) =>
            payment.method === "loyalty_points" ||
            payment.method === "store_credit" ||
            payment.method === "gift_card",
        )
        .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);
      const earnBase = roundMoney(paidAmount - fundedByAccount);
      if (earnBase > 0) {
        await earnLoyaltyPointsInTx(tx, {
          businessId,
          customerId,
          paidAmount: earnBase,
          sourceId: saleId,
          actorUserId: cashierUserId,
        });
      }
    }
    return {
      sale: newSale,
      change,
      paidAmount,
      dueAmount,
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
  const batchEffective = items.reduce(
    (sum, item) => sum + (effectiveByItemId.get(item.id) ?? 0),
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
  }

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
    await tx.insert(saleRefundItems).values({
      businessId,
      refundId: refund.id,
      saleItemId: item.id,
      productId: variant.productId,
      quantity: item.quantity,
      refundPrice: roundMoney(effective / item.quantity),
      refundTotal: effective,
    });

    const serialStatus =
      options.disposition === "restock"
        ? "in_stock"
        : options.disposition === "damaged"
          ? "damaged"
          : "returned";
    await tx
      .update(serialNumbers)
      .set({ status: serialStatus })
      .where(
        and(
          eq(serialNumbers.saleItemId, item.id),
          eq(serialNumbers.businessId, businessId),
        ),
      );

    if (options.disposition !== "restock") continue;

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
        quantity: sql`coalesce(${inventoryStock.quantity}, 0) + ${item.quantity}`,
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
        quantityReceived: item.quantity,
        quantityRemaining: item.quantity,
      })
      .returning({ id: inventoryBatches.id });
    if (variant.trackingType === "serial" && returnBatch) {
      await tx
        .update(serialNumbers)
        .set({ batchId: returnBatch.id })
        .where(
          and(
            eq(serialNumbers.saleItemId, item.id),
            eq(serialNumbers.businessId, businessId),
          ),
        );
    }

    await tx.insert(inventoryMovements).values({
      businessId,
      variantId: item.variantId,
      locationId: stock.locationId,
      batchId: returnBatch?.id ?? null,
      movementType: "return",
      quantity: item.quantity,
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
    .select({ id: saleItems.id })
    .from(saleItems)
    .where(
      and(
        eq(saleItems.saleId, saleId),
        eq(saleItems.businessId, businessId),
      ),
    )
    .for("update");
  const refundedSaleItems = await tx
    .select({ saleItemId: saleRefundItems.saleItemId })
    .from(saleRefundItems)
    .innerJoin(saleRefunds, eq(saleRefundItems.refundId, saleRefunds.id))
    .where(
      and(
        eq(saleRefunds.saleId, saleId),
        eq(saleRefunds.businessId, businessId),
      ),
    );
  const refundedIds = new Set(
    refundedSaleItems.flatMap((row) =>
      row.saleItemId === null ? [] : [row.saleItemId],
    ),
  );
  if (
    allSaleItems.length > 0 &&
    allSaleItems.every((saleItem) => refundedIds.has(saleItem.id))
  ) {
    await tx
      .update(sales)
      .set({ status: "refunded" })
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)));
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
        allSaleItems.every((saleItem) => refundedIds.has(saleItem.id));
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

  return { refundId: refund.id, refundTotal, locationId: sale.locationId };
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
    const [alreadyRefunded] = await tx
      .select({ id: saleRefundItems.id })
      .from(saleRefundItems)
      .where(
        and(
          eq(saleRefundItems.saleItemId, saleItem.id),
          eq(saleRefundItems.businessId, businessId),
        ),
      )
      .limit(1);
    if (alreadyRefunded) {
      throw new ConflictError("This sale item has already been returned");
    }

    const { refundId, refundTotal, locationId: refundLocationId } =
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

    const items = await tx
      .select()
      .from(saleItems)
      .where(
        and(eq(saleItems.saleId, id), eq(saleItems.businessId, businessId)),
      )
      .for("update");
    if (items.length === 0) throw new NotFoundError("Sale items not found");

    const alreadyRefunded = await tx
      .select({ saleItemId: saleRefundItems.saleItemId })
      .from(saleRefundItems)
      .where(
        and(
          eq(saleRefundItems.businessId, businessId),
          inArray(
            saleRefundItems.saleItemId,
            items.map((item) => item.id),
          ),
        ),
      );
    const refundedIds = new Set(
      alreadyRefunded.flatMap((row) =>
        row.saleItemId === null ? [] : [row.saleItemId],
      ),
    );
    const refundableItems = items.filter((item) => !refundedIds.has(item.id));
    if (refundableItems.length === 0) {
      throw new ConflictError("All items in this sale have already been returned");
    }

    const { refundId, refundTotal, locationId: refundLocationId } =
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
) {
  const idempotencyKey = payload.idempotencyKey?.trim() || null;
  if (payload.returns.length === 0) {
    throw new BadRequestError("An exchange requires at least one returned item.");
  }
  if (payload.replacements.length === 0) {
    throw new BadRequestError("An exchange requires at least one replacement item.");
  }

  const result = await db.transaction(async (tx) => {
    // 0. Idempotent replay: the replacement sale carries the key.
    if (idempotencyKey) {
      const replay = await findSaleByIdempotencyKey(tx, businessId, idempotencyKey);
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
    const { refundId, refundTotal } = await applySaleRefund(
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
    const trustedReplacements = replacementItems
      .map((item) => {
        const variant = variantMap.get(item.variantId);
        const unitPrice = Number(variant?.sellingPrice);
        if (!variant || !Number.isFinite(unitPrice) || unitPrice < 0) {
          throw new NotFoundError(
            `Valid selling price not found for variant ${item.variantId}.`,
          );
        }
        return { ...item, unitPrice, trackingType: variant.trackingType };
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
      const replay = await findSaleByIdempotencyKey(tx, businessId, idempotencyKey);
      if (!replay) throw new ConflictError("Exchange sale insert returned no row.");
      return { replayed: true as const, ...replay };
    }

    // Items: stock consumption + tax snapshots (same machinery as createSale).
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
    quantity: number;
    discount?: DiscountInput | null | undefined;
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
        sellingPrice: productVariants.sellingPrice,
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
    const trustedItems = payload.items.map((item) => {
      const unitPrice = priceById.get(item.variantId);
      if (unitPrice === undefined || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new NotFoundError(
          `Valid selling price not found for variant ${item.variantId}.`,
        );
      }
      return {
        variantId: item.variantId,
        quantity: item.quantity,
        unitPrice,
        discount: item.discount ?? null,
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
    const totals = usesTaxRules
      ? getCartTotalsWithTaxRules(trustedItems, payload.cartDiscount ?? null, taxRulesByVariant)
      : getCartTotals(trustedItems, payload.cartDiscount ?? null, Number(payload.vatPercent ?? 0));

    // Coupon preview: same evaluation rules as createSale (no lock), same
    // v1 stacking rule — a coupon excludes the cart-level discount.
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
      ...(coupon ? { coupon } : {}),
      ...(coupon === null && couponCode
        ? { couponError: "Coupon is not valid." }
        : {}),
    };
  });
}
