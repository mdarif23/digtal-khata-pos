import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
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
import {
  customerValidation,
  validatePayments,
  validateStock,
  validateVariants,
  type Items,
} from "./sales.validation.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { recordCashSaleInTx } from "../cashRegisters/cashRegisters.service.js";
import { getCartTotals, getLinePricing } from "./utils/cartPricing.js";
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
    cause.constraint === "sale_payments_method_reference_unique"
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
    })
    .from(sales)
    .leftJoin(customers, eq(sales.customerId, customers.id))
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
    })
    .from(saleItems)
    .innerJoin(productVariants, eq(saleItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(saleItems.saleId, saleId),
        eq(saleItems.businessId, businessId),
      ),
    )
    .orderBy(asc(saleItems.id));

  const variantIds = items.map((i) => i.variantId);
  const optionsMap = new Map<number, string[]>();

  if (variantIds.length > 0) {
    const optRows = await db
      .select({
        variantId: variantValues.variantId,
        value: variantOptions.value,
      })
      .from(variantValues)
      .innerJoin(variantOptions, eq(variantValues.optionId, variantOptions.id))
      .where(inArray(variantValues.variantId, variantIds));

    for (const opt of optRows) {
      const list = optionsMap.get(opt.variantId) ?? [];
      list.push(opt.value);
      optionsMap.set(opt.variantId, list);
    }
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

  return {
    saleId: sale.id,
    invoiceNumber: sale.invoiceNumber,
    saleDate: sale.saleDate,
    createdAt: sale.createdAt,
    customer: sale.customerId
      ? {
          id: sale.customerId,
          name: sale.customerName ?? 'Customer',
          phone: sale.customerPhone ?? null,
          address: sale.customerAddress ?? null,
        }
      : null,
    items: items.map((item) => {
      const optValues = optionsMap.get(item.variantId);
      const variantName =
        optValues && optValues.length > 0 ? optValues.join(' / ') : (item.sku || null);
      return {
        id: item.id,
        variantId: item.variantId,
        productName: item.productName,
        variantName,
        sku: item.sku,
        barcode: item.barcode,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
        discount: Number(item.discount),
        lineTotal: Number(item.lineTotal),
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

export async function createSale(
  businessId: number,
  locationId: number,
  cashierUserId: number,
  data: CreateSalePayload,
) {
  const { customerId, items, discount, vatPercent, payments, saleDate } = data;

  const result = await db.transaction(async (tx) => {
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

    // 5. Calculate every total from the same trusted items.
    const totals = getCartTotals(
      trustedItems,
      discount,
      Number(vatPercent ?? 0),
    );

    const totalDiscount = roundMoney(
      totals.itemDiscount + totals.cartDiscountAmount,
    );

    // 6. Validate payment amounts against the final total.
    const { change, dueAmount, paidAmount } = validatePayments(
      payments,
      totals.finalTotal,
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

    // 8. Insert the sale header.
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
        finalTotal: totals.finalTotal,
        dueAmount,
        paymentStatus,
        status: "completed",
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
      throw new Error("Failed to create sale.");
    }

    const saleId = newSale.id;

    // 9. Insert sale items with price and cost snapshots.
    for (const item of trustedItems) {
      const line = getLinePricing(item.unitPrice, item.quantity, item.discount);

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
        });

      if (updatedRows.length !== 1) {
        throw new Error(
          `Failed to update stock for variant ${item.variantId}.`,
        );
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
                payment.method === "cash"
                  ? null
                  : payment.reference?.trim() || null,
              tendered:
                payment.method === "cash" ? (payment.tendered ?? null) : null,
            };
          }),
        );

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
    // 11. Return receipt data; transaction commits on success.
    return {
      sale: newSale,
      change,
      paidAmount,
      dueAmount,
    };
  });

  const receipt = await getSaleReceipt(businessId, result.sale.id);
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
    })
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .for("update");
  if (!sale) throw new NotFoundError("Sale not found");

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
    })
    .returning({ id: saleRefunds.id });
  if (!refund) throw new NotFoundError("Could not create refund record");

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

  return refund.id;
}

export async function createSingleRefund(
  businessId: number,
  id: number,
  options: SaleRefundRequest,
) {
  return db.transaction(async (tx) => {
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

    const refundId = await applySaleRefund(
      tx,
      businessId,
      saleItem.saleId,
      [saleItem],
      options,
    );
    await pushRefundStatusAfterCommit(businessId, saleItem.saleId);
    return { message: "Refund created successfully", refundId };
  });
}

export async function createMultipleRefunds(
  businessId: number,
  id: number,
  options: SaleRefundRequest,
) {
  return db.transaction(async (tx) => {
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

    const refundId = await applySaleRefund(
      tx,
      businessId,
      id,
      refundableItems,
      options,
    );
    await pushRefundStatusAfterCommit(businessId, id);
    return { message: "Refund created successfully", refundId };
  });
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
