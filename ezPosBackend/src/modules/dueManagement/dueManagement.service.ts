import { and, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { customers } from "../../db/schema/customers.js";
import { purchaseItems } from "../../db/schema/purchaseItems.js";
import { purchasePayments } from "../../db/schema/purchasePayments.js";
import { purchaseReturns } from "../../db/schema/purchaseReturns.js";
import { purchases } from "../../db/schema/purchases.js";
import { salePayments } from "../../db/schema/salePayments.js";
import { saleRefunds } from "../../db/schema/saleRefunds.js";
import { sales } from "../../db/schema/sales.js";
import { suppliers } from "../../db/schema/suppliers.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { recordDueCollectionInTx } from "../cashRegisters/cashRegisters.service.js";
import {
  calculatePayments,
  calculatePaymentStatus,
  getAllPurchaseItems,
} from "../purchases/receive/receive.service.js";
import type {
  CustomerPaymentInput,
  DueRowQuery,
  DueSummaryQuery,
  LedgerQuery,
  SupplierPaymentInput,
} from "./dueManagement.schema.js";

const toNumber = (value: number | string | null | undefined) =>
  Number(value ?? 0);

// Tolerate sub-poisha floating point noise when classifying balances.
const EPSILON = 0.004;

export type ComputedStatus = "unpaid" | "partial" | "paid" | "credit";

function computedStatus(outstanding: number, paid: number): ComputedStatus {
  if (outstanding < -EPSILON) return "credit";
  if (outstanding <= EPSILON) return "paid";
  return paid > EPSILON ? "partial" : "unpaid";
}

function paymentStatusFromRemaining(
  remaining: number,
  total: number,
): "paid" | "partial" | "unpaid" {
  if (total <= 0 || remaining <= EPSILON) return "paid";
  if (remaining < total - EPSILON) return "partial";
  return "unpaid";
}

function endOfDay(dateString: string): Date {
  return new Date(`${dateString}T23:59:59.999`);
}

function startOfDay(dateString: string): Date {
  return new Date(`${dateString}T00:00:00.000`);
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

/**
 * Outstanding balances are always computed from transaction history
 * (invoice totals - payments - refunds/returns), never from amounts
 * submitted by the frontend. `sales.due_amount` / `purchases.due_amount`
 * are maintained as denormalized copies for the POS flows.
 *
 * Note: the `sales` table stores the sale date in a column named
 * `purchase_date` (legacy naming), so raw SQL below uses that name.
 */
export async function getDueManagementSummary(
  businessId: number,
  query: DueSummaryQuery,
) {
  const overdueDays = query.overdueDays ?? 30;

  const [customerResult, supplierResult, collectedToday, paidToday] =
    await Promise.all([
      db.execute(sql`
        WITH sale_balance AS (
          SELECT
            s.id,
            s.customer_id,
            s.purchase_date AS invoice_date,
            ROUND(
              COALESCE(s.final_total, 0)
              - COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.sale_id = s.id), 0)
              - COALESCE((SELECT SUM(sr.refund_total) FROM sale_refunds sr WHERE sr.sale_id = s.id), 0),
              2
            )::float8 AS outstanding
          FROM sales s
          WHERE s.status IN ('completed', 'refunded')
            AND s.business_id = ${businessId}
        ),
        customer_balance AS (
          SELECT
            customer_id,
            SUM(outstanding) AS balance,
            SUM(CASE WHEN outstanding > 0 AND invoice_date < NOW() - (${overdueDays} * INTERVAL '1 day')
                     THEN outstanding ELSE 0 END) AS overdue
          FROM sale_balance
          GROUP BY customer_id
        )
        SELECT
          COALESCE(SUM(GREATEST(balance, 0)), 0)::float8 AS total_outstanding,
          COALESCE(SUM(GREATEST(overdue, 0)), 0)::float8 AS total_overdue,
          COUNT(*) FILTER (WHERE balance > 0)::int AS parties_with_due
        FROM customer_balance
      `),
      db.execute(sql`
        WITH purchase_balance AS (
          SELECT
            p.id,
            p.supplier_id,
            p.purchase_date,
            ROUND(
              COALESCE(p.total_amount, 0)
              - COALESCE((SELECT SUM(pp.amount) FROM purchase_payments pp WHERE pp.purchase_id = p.id), 0)
              - COALESCE((SELECT SUM(pr.total_amount) FROM purchase_returns pr WHERE pr.purchase_id = p.id), 0),
              2
            )::float8 AS outstanding
          FROM purchases p
          WHERE p.business_id = ${businessId}
        ),
        supplier_balance AS (
          SELECT
            supplier_id,
            SUM(outstanding) AS balance,
            SUM(CASE WHEN outstanding > 0 AND purchase_date < NOW() - (${overdueDays} * INTERVAL '1 day')
                     THEN outstanding ELSE 0 END) AS overdue
          FROM purchase_balance
          GROUP BY supplier_id
        )
        SELECT
          COALESCE(SUM(GREATEST(balance, 0)), 0)::float8 AS total_outstanding,
          COALESCE(SUM(GREATEST(overdue, 0)), 0)::float8 AS total_overdue,
          COUNT(*) FILTER (WHERE balance > 0)::int AS parties_with_due
        FROM supplier_balance
      `),
      db.execute(sql`
        SELECT COALESCE(SUM(amount), 0)::float8 AS total
        FROM sale_payments
        WHERE payment_date >= CURRENT_DATE
          AND business_id = ${businessId}
      `),
      db.execute(sql`
        SELECT COALESCE(SUM(amount), 0)::float8 AS total
        FROM purchase_payments
        WHERE payment_date >= CURRENT_DATE
          AND business_id = ${businessId}
      `),
    ]);

  const customerRow = (
    customerResult.rows as Array<{
      total_outstanding: number;
      total_overdue: number;
      parties_with_due: number;
    }>
  )[0];
  const supplierRow = (
    supplierResult.rows as Array<{
      total_outstanding: number;
      total_overdue: number;
      parties_with_due: number;
    }>
  )[0];

  return {
    // Receivables: money customers owe the shop.
    customerOutstanding: toNumber(customerRow?.total_outstanding),
    customerOverdue: toNumber(customerRow?.total_overdue),
    customersWithDue: toNumber(customerRow?.parties_with_due),
    // Payables: money the shop owes suppliers. Kept separate on purpose —
    // receivables and payables must never be merged into one figure.
    supplierOutstanding: toNumber(supplierRow?.total_outstanding),
    supplierOverdue: toNumber(supplierRow?.total_overdue),
    suppliersWithPayable: toNumber(supplierRow?.parties_with_due),
    amountCollectedToday: toNumber(
      (collectedToday.rows as Array<{ total: number }>)[0]?.total,
    ),
    amountPaidToSuppliersToday: toNumber(
      (paidToday.rows as Array<{ total: number }>)[0]?.total,
    ),
    overdueDays,
  };
}

/* ------------------------------------------------------------------ */
/* Customer-level balances (filter dropdown / customer totals)         */
/* ------------------------------------------------------------------ */

export async function getCustomerDueBalances(businessId: number) {
  const result = await db.execute(sql`
    WITH sale_balance AS (
      SELECT
        s.id,
        s.customer_id,
        s.purchase_date AS invoice_date,
        ROUND(
          COALESCE(s.final_total, 0)
          - COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.sale_id = s.id), 0)
          - COALESCE((SELECT SUM(sr.refund_total) FROM sale_refunds sr WHERE sr.sale_id = s.id), 0),
          2
        )::float8 AS outstanding
      FROM sales s
      WHERE s.status IN ('completed', 'refunded')
        AND s.business_id = ${businessId}
    )
    SELECT
      c.id AS customer_id,
      c.name,
      c.phone,
      SUM(sb.outstanding)::float8 AS balance,
      COUNT(*) FILTER (WHERE sb.outstanding > 0)::int AS open_invoices,
      MAX(sb.invoice_date) AS latest_invoice_date
    FROM sale_balance sb
    INNER JOIN customers c ON c.id = sb.customer_id
    GROUP BY c.id, c.name, c.phone
    HAVING SUM(sb.outstanding) > 0
    ORDER BY SUM(sb.outstanding) DESC
  `);

  return (
    result.rows as Array<{
      customer_id: number;
      name: string;
      phone: string | null;
      balance: number;
      open_invoices: number;
      latest_invoice_date: string | null;
    }>
  ).map((row) => ({
    customerId: row.customer_id,
    name: row.name,
    phone: row.phone,
    balance: roundMoney(toNumber(row.balance)),
    openInvoices: Number(row.open_invoices ?? 0),
    latestInvoiceDate: row.latest_invoice_date
      ? new Date(row.latest_invoice_date).toISOString()
      : null,
  }));
}

/* ------------------------------------------------------------------ */
/* Invoice-level due rows                                              */
/* ------------------------------------------------------------------ */

export async function getCustomerDueRows(
  businessId: number,
  query: DueRowQuery,
) {
  const search = query.search?.trim();
  const overdueDays = query.overdueDays ?? 30;
  const status = query.status ?? "all";

  // Operands must stay numeric: ROUND(x, 2) does not exist for float8.
  const paidAmountSql = sql<number>`COALESCE((SELECT SUM(${salePayments.amount}) FROM ${salePayments} WHERE ${salePayments.saleId} = ${sales.id}), 0)::numeric`;
  const refundAmountSql = sql<number>`COALESCE((SELECT SUM(${saleRefunds.refundTotal}) FROM ${saleRefunds} WHERE ${saleRefunds.saleId} = ${sales.id}), 0)::numeric`;
  const outstandingSql = sql<number>`ROUND(COALESCE(${sales.finalTotal}, 0) - ${paidAmountSql} - ${refundAmountSql}, 2)::float8`;

  const conditions = [
    eq(sales.businessId, businessId),
    inArray(sales.status, ["completed", "refunded"]),
    // Narrow the scan: open dues come from non-paid sales; the settled
    // filter explicitly asks for paid invoices. Computed values below
    // remain the source of truth for what is returned.
    status === "paid"
      ? and(eq(sales.paymentStatus, "paid"), eq(sales.dueAmount, 0))!
      : or(ne(sales.paymentStatus, "paid"), sql`${sales.dueAmount} > 0`)!,
  ];

  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(customers.name, pattern),
        ilike(customers.phone, pattern),
        ilike(sales.invoiceNumber, pattern),
      )!,
    );
  }
  if (query.customerId !== undefined) {
    conditions.push(eq(sales.customerId, query.customerId));
  }
  if (query.from !== undefined) {
    conditions.push(gte(sales.saleDate, startOfDay(query.from)));
  }
  if (query.to !== undefined) {
    conditions.push(lte(sales.saleDate, endOfDay(query.to)));
  }

  const rows = await db
    .select({
      saleId: sales.id,
      customerId: customers.id,
      customerName: customers.name,
      phone: customers.phone,
      invoiceNumber: sales.invoiceNumber,
      invoiceDate: sales.saleDate,
      totalAmount: sales.finalTotal,
      paidAmount: paidAmountSql,
      refundAmount: refundAmountSql,
      outstandingAmount: outstandingSql,
    })
    .from(sales)
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(and(...conditions))
    .orderBy(sales.saleDate)
    .limit(1000);

  const cutoff = Date.now() - overdueDays * 24 * 60 * 60 * 1000;

  return rows
    .map((row) => {
      const totalAmount = roundMoney(toNumber(row.totalAmount));
      const paidAmount = roundMoney(toNumber(row.paidAmount));
      const refundAmount = roundMoney(toNumber(row.refundAmount));
      const outstandingAmount = roundMoney(toNumber(row.outstandingAmount));
      const invoiceTime = row.invoiceDate
        ? new Date(row.invoiceDate).getTime()
        : null;
      return {
        saleId: row.saleId,
        customerId: row.customerId ?? null,
        customerName: row.customerName ?? null,
        phone: row.phone ?? null,
        isWalkIn: row.customerId === null,
        invoiceNumber: row.invoiceNumber,
        invoiceDate: row.invoiceDate
          ? new Date(row.invoiceDate).toISOString()
          : null,
        totalAmount,
        paidAmount,
        refundAmount,
        outstandingAmount,
        status: computedStatus(outstandingAmount, paidAmount),
        isOverdue:
          outstandingAmount > EPSILON &&
          invoiceTime !== null &&
          invoiceTime < cutoff,
      };
    })
    .filter((row) => {
      switch (status) {
        case "unpaid":
          return row.status === "unpaid";
        case "partial":
          return row.status === "partial";
        case "overdue":
          return row.isOverdue;
        case "paid":
          return row.status === "paid" || row.status === "credit";
        default:
          return row.outstandingAmount > EPSILON;
      }
    });
}

export async function getSupplierDueRows(
  businessId: number,
  query: DueRowQuery,
) {
  const search = query.search?.trim();
  const overdueDays = query.overdueDays ?? 30;
  const status = query.status ?? "all";

  // Operands must stay numeric: ROUND(x, 2) does not exist for float8.
  const paidAmountSql = sql<number>`COALESCE((SELECT SUM(${purchasePayments.amount}) FROM ${purchasePayments} WHERE ${purchasePayments.purchaseId} = ${purchases.id}), 0)::numeric`;
  const returnAmountSql = sql<number>`COALESCE((SELECT SUM(${purchaseReturns.totalAmount}) FROM ${purchaseReturns} WHERE ${purchaseReturns.purchaseId} = ${purchases.id}), 0)::numeric`;
  const outstandingSql = sql<number>`ROUND(COALESCE(${purchases.totalAmount}, 0) - ${paidAmountSql} - ${returnAmountSql}, 2)::float8`;

  const conditions = [
    eq(purchases.businessId, businessId),
    status === "paid"
      ? and(eq(purchases.paymentStatus, "paid"), eq(purchases.dueAmount, 0))!
      : or(ne(purchases.paymentStatus, "paid"), sql`${purchases.dueAmount} > 0`)!,
  ];

  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(suppliers.name, pattern),
        ilike(suppliers.phone, pattern),
        ilike(purchases.purchaseOrderNumber, pattern),
      )!,
    );
  }
  if (query.supplierId !== undefined) {
    conditions.push(eq(purchases.supplierId, query.supplierId));
  }
  if (query.from !== undefined) {
    conditions.push(gte(purchases.purchaseDate, startOfDay(query.from)));
  }
  if (query.to !== undefined) {
    conditions.push(lte(purchases.purchaseDate, endOfDay(query.to)));
  }

  const rows = await db
    .select({
      purchaseId: purchases.id,
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      phone: suppliers.phone,
      purchaseInvoice: purchases.purchaseOrderNumber,
      purchaseDate: purchases.purchaseDate,
      purchaseStatus: purchases.status,
      totalAmount: purchases.totalAmount,
      paidAmount: paidAmountSql,
      returnAmount: returnAmountSql,
      outstandingAmount: outstandingSql,
    })
    .from(purchases)
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(and(...conditions))
    .orderBy(purchases.purchaseDate)
    .limit(1000);

  const cutoff = Date.now() - overdueDays * 24 * 60 * 60 * 1000;

  return rows
    .map((row) => {
      const totalAmount = roundMoney(toNumber(row.totalAmount));
      const paidAmount = roundMoney(toNumber(row.paidAmount));
      const returnAmount = roundMoney(toNumber(row.returnAmount));
      const outstandingAmount = roundMoney(toNumber(row.outstandingAmount));
      const purchaseTime = row.purchaseDate
        ? new Date(row.purchaseDate).getTime()
        : null;
      return {
        purchaseId: row.purchaseId,
        supplierId: row.supplierId ?? null,
        supplierName: row.supplierName ?? null,
        phone: row.phone ?? null,
        purchaseInvoice: row.purchaseInvoice,
        purchaseDate: row.purchaseDate
          ? new Date(row.purchaseDate).toISOString()
          : null,
        purchaseStatus: row.purchaseStatus,
        totalAmount,
        paidAmount,
        returnAmount,
        outstandingAmount,
        status: computedStatus(outstandingAmount, paidAmount),
        isOverdue:
          outstandingAmount > EPSILON &&
          purchaseTime !== null &&
          purchaseTime < cutoff,
      };
    })
    .filter((row) => {
      switch (status) {
        case "unpaid":
          return row.status === "unpaid";
        case "partial":
          return row.status === "partial";
        case "overdue":
          return row.isOverdue;
        case "paid":
          return row.status === "paid" || row.status === "credit";
        default:
          return row.outstandingAmount > EPSILON;
      }
    });
}

/* ------------------------------------------------------------------ */
/* Recording payments                                                  */
/* ------------------------------------------------------------------ */

export async function recordCustomerPayment(
  businessId: number,
  payload: CustomerPaymentInput,
  actorUserId: number | null = null,
) {
  const { saleId, amount, paymentMethod } = payload;

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestError("Payment amount must be greater than zero.");
  }

  return db.transaction(async (tx) => {
    // Lock the invoice row so two concurrent payments on the same
    // invoice are serialized and can never over-collect. Scoping by
    // businessId here is also the ownership check: another business's
    // invoice is indistinguishable from a missing one.
    const [sale] = await tx
      .select({
        id: sales.id,
        customerId: sales.customerId,
        finalTotal: sales.finalTotal,
        invoiceNumber: sales.invoiceNumber,
        status: sales.status,
        locationId: sales.locationId,
      })
      .from(sales)
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
      .for("update");

    if (!sale) {
      throw new NotFoundError("Sale not found.");
    }
    if (sale.status === "held" || sale.status === "cancelled") {
      throw new BadRequestError(
        "Payments cannot be recorded against a held or cancelled sale.",
      );
    }

    const [paidRows, refundRows] = await Promise.all([
      tx
        .select({
          paidTotal: sql<number>`COALESCE(SUM(${salePayments.amount}), 0)::float8`,
        })
        .from(salePayments)
        .where(
          and(
            eq(salePayments.saleId, saleId),
            eq(salePayments.businessId, businessId),
          ),
        ),
      tx
        .select({
          refundTotal: sql<number>`COALESCE(SUM(${saleRefunds.refundTotal}), 0)::float8`,
        })
        .from(saleRefunds)
        .where(
          and(
            eq(saleRefunds.saleId, saleId),
            eq(saleRefunds.businessId, businessId),
          ),
        ),
    ]);

    const finalTotal = roundMoney(toNumber(sale.finalTotal));
    const paid = roundMoney(toNumber(paidRows[0]?.paidTotal));
    const refunded = roundMoney(toNumber(refundRows[0]?.refundTotal));
    const outstanding = roundMoney(finalTotal - paid - refunded);

    if (outstanding <= EPSILON) {
      throw new BadRequestError(
        `Invoice ${sale.invoiceNumber} is already settled. No further payments can be recorded.`,
      );
    }
    if (roundMoney(amount) > outstanding) {
      throw new BadRequestError(
        `Payment of ${roundMoney(amount).toFixed(2)} exceeds the outstanding balance of ${outstanding.toFixed(2)} on invoice ${sale.invoiceNumber}.`,
      );
    }

    const reference =
      paymentMethod === "cash" ? null : (payload.reference?.trim() || null);
    if (
      (paymentMethod === "card" || paymentMethod === "bangla_qr") &&
      (reference ?? "").length < 6
    ) {
      throw new BadRequestError(
        "Card and QR payments require a transaction reference of at least 6 characters.",
      );
    }

    let inserted: { id: number } | undefined;
    try {
      [inserted] = await tx
        .insert(salePayments)
        .values({
          businessId,
          saleId,
          customerId: sale.customerId,
          amount: roundMoney(amount),
          paymentMethod,
          reference,
          tendered:
            paymentMethod === "cash" ? (payload.tendered ?? null) : null,
          paymentDate: payload.paymentDate
            ? `${payload.paymentDate}T${new Date().toTimeString().slice(0, 8)}`
            : new Date().toISOString(),
          notes: payload.notes?.trim() || null,
        })
        .returning({ id: salePayments.id });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictError(
          "A payment with this transaction reference already exists.",
        );
      }
      throw err;
    }

    const nextOutstanding = roundMoney(outstanding - roundMoney(amount));
    const nextStatus = paymentStatusFromRemaining(nextOutstanding, finalTotal);

    await tx
      .update(sales)
      .set({
        dueAmount: Math.max(0, nextOutstanding),
        paymentStatus: nextStatus,
      })
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)));

    // Cash collected at the counter enters the collector's open drawer
    // transactionally (same source record — idempotent via the movement
    // reference unique). Non-cash methods never touch drawer cash.
    if (paymentMethod === "cash" && inserted) {
      await recordDueCollectionInTx(
        tx,
        businessId,
        actorUserId,
        sale.locationId,
        roundMoney(amount),
        inserted.id,
      );
    }

    return {
      saleId,
      invoiceNumber: sale.invoiceNumber,
      paymentId: inserted?.id ?? 0,
      amount: roundMoney(amount),
      outstandingAfter: nextOutstanding,
      paymentStatus: nextStatus,
    };
  });
}

export async function recordSupplierPayment(
  businessId: number,
  payload: SupplierPaymentInput,
) {
  const { purchaseId, amount, method } = payload;

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestError("Payment amount must be greater than zero.");
  }

  return db.transaction(async (tx) => {
    // Lock the purchase row to serialize concurrent supplier payments.
    // Scoped by businessId — the ownership check.
    const [purchase] = await tx
      .select({
        id: purchases.id,
        supplierId: purchases.supplierId,
        totalAmount: purchases.totalAmount,
        paidAmount: purchases.paidAmount,
        purchaseOrderNumber: purchases.purchaseOrderNumber,
      })
      .from(purchases)
      .where(
        and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)),
      )
      .for("update");

    if (!purchase) {
      throw new NotFoundError("Purchase not found.");
    }

    const allPurchaseItems = await getAllPurchaseItems(
      tx,
      businessId,
      purchaseId,
    );

    // Reuse the receive-flow rules: you can only pay for goods that have
    // actually been received, never beyond the invoice total.
    let paymentMath: ReturnType<typeof calculatePayments>;
    try {
      paymentMath = calculatePayments(
        allPurchaseItems,
        purchase.paidAmount,
        roundMoney(amount),
        purchase.totalAmount,
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new BadRequestError(err.message);
      }
      throw err;
    }

    let inserted: { id: number } | undefined;
    try {
      [inserted] = await tx
        .insert(purchasePayments)
        .values({
          businessId,
          purchaseId,
          amount: roundMoney(amount),
          method,
          notes: payload.notes?.trim() || null,
          paymentDate: payload.paymentDate
            ? new Date(`${payload.paymentDate}T00:00:00`)
            : new Date(),
        })
        .returning({ id: purchasePayments.id });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictError(
          "A payment with these details already exists.",
        );
      }
      throw err;
    }

    const receivedAmount = roundMoney(toNumber(paymentMath.receivedAmount));
    const nextStatus = calculatePaymentStatus(
      paymentMath.updatedPaidAmount,
      purchase.totalAmount,
      receivedAmount,
    );

    await tx
      .update(purchases)
      .set({
        paidAmount: paymentMath.updatedPaidAmount,
        dueAmount: paymentMath.updatedDueAmount,
        paymentStatus: nextStatus,
        updatedAt: new Date(),
      })
      .where(
        and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)),
      );

    return {
      purchaseId,
      purchaseOrderNumber: purchase.purchaseOrderNumber,
      paymentId: inserted?.id ?? 0,
      amount: roundMoney(amount),
      outstandingAfter: roundMoney(paymentMath.updatedDueAmount),
      paymentStatus: nextStatus,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Daily trend (collections vs supplier payments)                      */
/* ------------------------------------------------------------------ */

export async function getDueManagementTrend(businessId: number, days: number) {
  const safeDays = Math.min(Math.max(1, Math.floor(days) || 14), 90);

  const [collections, supplierPayments] = await Promise.all([
    db.execute(sql`
      SELECT
        to_char(payment_date::date, 'YYYY-MM-DD') AS day,
        COALESCE(SUM(amount), 0)::float8 AS total
      FROM sale_payments
      WHERE payment_date >= CURRENT_DATE - (${safeDays - 1} * INTERVAL '1 day')
        AND business_id = ${businessId}
      GROUP BY 1
    `),
    db.execute(sql`
      SELECT
        to_char(payment_date::date, 'YYYY-MM-DD') AS day,
        COALESCE(SUM(amount), 0)::float8 AS total
      FROM purchase_payments
      WHERE payment_date >= CURRENT_DATE - (${safeDays - 1} * INTERVAL '1 day')
        AND business_id = ${businessId}
      GROUP BY 1
    `),
  ]);

  const collectedByDay = new Map<string, number>();
  for (const row of collections.rows as Array<{ day: string; total: number }>) {
    collectedByDay.set(row.day, toNumber(row.total));
  }
  const paidByDay = new Map<string, number>();
  for (const row of supplierPayments.rows as Array<{ day: string; total: number }>) {
    paidByDay.set(row.day, toNumber(row.total));
  }

  const points: Array<{ date: string; collected: number; paidToSuppliers: number }> = [];
  const today = new Date();
  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(day.getDate() - offset);
    const key = day.toISOString().slice(0, 10);
    points.push({
      date: key,
      collected: roundMoney(collectedByDay.get(key) ?? 0),
      paidToSuppliers: roundMoney(paidByDay.get(key) ?? 0),
    });
  }

  return { days: safeDays, points };
}

/* ------------------------------------------------------------------ */
/* Payment history                                                     */
/* ------------------------------------------------------------------ */

export async function getSalePayments(businessId: number, saleId: number) {
  const [sale] = await db
    .select({ id: sales.id, invoiceNumber: sales.invoiceNumber })
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .limit(1);
  if (!sale) {
    throw new NotFoundError("Sale not found.");
  }

  const payments = await db
    .select({
      id: salePayments.id,
      amount: salePayments.amount,
      paymentMethod: salePayments.paymentMethod,
      reference: salePayments.reference,
      tendered: salePayments.tendered,
      paymentDate: salePayments.paymentDate,
      notes: salePayments.notes,
    })
    .from(salePayments)
    .where(
      and(
        eq(salePayments.saleId, saleId),
        eq(salePayments.businessId, businessId),
      ),
    )
    .orderBy(desc(salePayments.paymentDate), desc(salePayments.id));

  return {
    invoiceNumber: sale.invoiceNumber,
    payments: payments.map((payment) => ({
      ...payment,
      amount: roundMoney(toNumber(payment.amount)),
      tendered:
        payment.tendered === null ? null : roundMoney(toNumber(payment.tendered)),
      paymentDate: payment.paymentDate,
    })),
  };
}

export async function getPurchasePayments(
  businessId: number,
  purchaseId: number,
) {
  const [purchase] = await db
    .select({
      id: purchases.id,
      purchaseOrderNumber: purchases.purchaseOrderNumber,
    })
    .from(purchases)
    .where(and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)))
    .limit(1);
  if (!purchase) {
    throw new NotFoundError("Purchase not found.");
  }

  const payments = await db
    .select({
      id: purchasePayments.id,
      amount: purchasePayments.amount,
      method: purchasePayments.method,
      notes: purchasePayments.notes,
      paymentDate: purchasePayments.paymentDate,
    })
    .from(purchasePayments)
    .where(
      and(
        eq(purchasePayments.purchaseId, purchaseId),
        eq(purchasePayments.businessId, businessId),
      ),
    )
    .orderBy(desc(purchasePayments.paymentDate), desc(purchasePayments.id));

  return {
    purchaseOrderNumber: purchase.purchaseOrderNumber,
    payments: payments.map((payment) => ({
      ...payment,
      amount: roundMoney(toNumber(payment.amount)),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Ledgers                                                             */
/* ------------------------------------------------------------------ */

type LedgerTransactionRow = {
  type: "invoice" | "payment" | "refund" | "purchase" | "return";
  transactionDate: Date | string | null;
  reference: string;
  description: string | null;
  debit: number;
  credit: number;
  relatedId: number | null;
};

function buildLedger(
  openingBalance: number,
  rows: LedgerTransactionRow[],
): {
  openingBalance: number;
  transactions: Array<LedgerTransactionRow & { runningBalance: number }>;
  totals: { debit: number; credit: number; closing: number };
} {
  const sorted = [...rows].sort((a, b) => {
    const aTime = a.transactionDate ? new Date(a.transactionDate).getTime() : 0;
    const bTime = b.transactionDate ? new Date(b.transactionDate).getTime() : 0;
    if (aTime !== bTime) return aTime - bTime;
    return (a.relatedId ?? 0) - (b.relatedId ?? 0);
  });

  let runningBalance = roundMoney(openingBalance);
  let totalDebit = 0;
  let totalCredit = 0;

  const transactions = sorted.map((row) => {
    const debit = roundMoney(toNumber(row.debit));
    const credit = roundMoney(toNumber(row.credit));
    runningBalance = roundMoney(runningBalance + debit - credit);
    totalDebit = roundMoney(totalDebit + debit);
    totalCredit = roundMoney(totalCredit + credit);
    return {
      ...row,
      debit,
      credit,
      transactionDate: row.transactionDate
        ? new Date(row.transactionDate).toISOString()
        : null,
      runningBalance,
    };
  });

  return {
    openingBalance: roundMoney(openingBalance),
    transactions,
    totals: {
      debit: totalDebit,
      credit: totalCredit,
      closing: roundMoney(openingBalance + totalDebit - totalCredit),
    },
  };
}

export async function getCustomerLedger(
  businessId: number,
  customerId: number,
  query: LedgerQuery,
) {
  const [customer] = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      address: customers.address,
    })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.businessId, businessId)))
    .limit(1);

  if (!customer) {
    throw new NotFoundError("Customer not found.");
  }

  // Customer ledger direction: invoices/refunds-adjustments are charges
  // (debit), payments received reduce what the customer owes (credit).
  const saleRows = await db
    .select({
      type: sql<"invoice">`'invoice'`,
      transactionDate: sales.saleDate,
      reference: sales.invoiceNumber,
      description: sql<string>`'Sale invoice'`,
      debit: sql<number>`COALESCE(${sales.finalTotal}, 0)`,
      credit: sql<number>`0`,
      relatedId: sales.id,
    })
    .from(sales)
    .where(
      and(
        eq(sales.customerId, customerId),
        eq(sales.businessId, businessId),
        inArray(sales.status, ["completed", "refunded"]),
      ),
    );

  const paymentRows = await db
    .select({
      type: sql<"payment">`'payment'`,
      transactionDate: salePayments.paymentDate,
      reference: sql<string>`COALESCE(${salePayments.reference}, 'PAY-' || ${salePayments.id})`,
      description: sql<string>`'Payment received (' || ${salePayments.paymentMethod} || ')'`,
      debit: sql<number>`0`,
      credit: salePayments.amount,
      relatedId: salePayments.id,
    })
    .from(salePayments)
    .innerJoin(sales, eq(salePayments.saleId, sales.id))
    .where(
      and(
        eq(sales.customerId, customerId),
        eq(sales.businessId, businessId),
      ),
    );

  const refundRows = await db
    .select({
      type: sql<"refund">`'refund'`,
      transactionDate: saleRefunds.createdAt,
      reference: sql<string>`'REF-' || ${saleRefunds.id}`,
      description: sql<string>`'Refund / credit adjustment'`,
      debit: sql<number>`0`,
      credit: sql<number>`COALESCE(${saleRefunds.refundTotal}, 0)`,
      relatedId: saleRefunds.id,
    })
    .from(saleRefunds)
    .innerJoin(sales, eq(saleRefunds.saleId, sales.id))
    .where(
      and(
        eq(sales.customerId, customerId),
        eq(sales.businessId, businessId),
      ),
    );

  const allRows: LedgerTransactionRow[] = [
    ...saleRows,
    ...paymentRows,
    ...refundRows,
  ];

  // Opening balance = net movement strictly before the start date, so no
  // transaction is ever counted twice.
  const hasFrom = query.from !== undefined;
  const fromDate = hasFrom ? startOfDay(query.from!).getTime() : 0;
  const toDate = query.to !== undefined ? endOfDay(query.to!).getTime() : Infinity;

  const previousRows = hasFrom
    ? allRows.filter(
        (row) =>
          row.transactionDate &&
          new Date(row.transactionDate).getTime() < fromDate,
      )
    : [];

  const openingBalance = previousRows.reduce(
    (balance, row) => balance + toNumber(row.debit) - toNumber(row.credit),
    0,
  );

  const inRangeRows = allRows.filter((row) => {
    if (!row.transactionDate) return false;
    const time = new Date(row.transactionDate).getTime();
    return time >= fromDate && time <= toDate;
  });

  return {
    party: {
      kind: "customer" as const,
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
    },
    from: query.from ?? null,
    to: query.to ?? null,
    ...buildLedger(openingBalance, inRangeRows),
  };
}

export async function getSupplierLedger(
  businessId: number,
  supplierId: number,
  query: LedgerQuery,
) {
  const [supplier] = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      phone: suppliers.phone,
      address: suppliers.address,
    })
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)))
    .limit(1);

  if (!supplier) {
    throw new NotFoundError("Supplier not found.");
  }

  // Supplier ledger direction: purchases increase what the shop owes
  // (debit); payments made and purchase returns reduce it (credit).
  // Built from the source tables — the supplier_ledger table only holds
  // purchase-return rows today, so reading it here would double count.
  const purchaseRows = await db
    .select({
      type: sql<"purchase">`'purchase'`,
      transactionDate: purchases.purchaseDate,
      reference: purchases.purchaseOrderNumber,
      description: sql<string>`'Purchase invoice'`,
      debit: purchases.totalAmount,
      credit: sql<number>`0`,
      relatedId: purchases.id,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.supplierId, supplierId),
        eq(purchases.businessId, businessId),
      ),
    );

  const paymentRows = await db
    .select({
      type: sql<"payment">`'payment'`,
      transactionDate: purchasePayments.paymentDate,
      reference: sql<string>`'PAY-' || ${purchasePayments.id}`,
      description: sql<string>`'Payment made (' || ${purchasePayments.method} || ')'`,
      debit: sql<number>`0`,
      credit: purchasePayments.amount,
      relatedId: purchasePayments.id,
    })
    .from(purchasePayments)
    .innerJoin(purchases, eq(purchasePayments.purchaseId, purchases.id))
    .where(
      and(
        eq(purchases.supplierId, supplierId),
        eq(purchases.businessId, businessId),
      ),
    );

  const returnRows = await db
    .select({
      type: sql<"return">`'return'`,
      transactionDate: purchaseReturns.returnDate,
      reference: sql<string>`'RET-' || ${purchaseReturns.id}`,
      description: sql<string>`'Purchase return'`,
      debit: sql<number>`0`,
      credit: purchaseReturns.totalAmount,
      relatedId: purchaseReturns.id,
    })
    .from(purchaseReturns)
    .where(
      and(
        eq(purchaseReturns.supplierId, supplierId),
        eq(purchaseReturns.businessId, businessId),
      ),
    );

  const allRows: LedgerTransactionRow[] = [
    ...purchaseRows,
    ...paymentRows,
    ...returnRows,
  ];

  const hasFrom = query.from !== undefined;
  const fromDate = hasFrom ? startOfDay(query.from!).getTime() : 0;
  const toDate = query.to !== undefined ? endOfDay(query.to!).getTime() : Infinity;

  const previousRows = hasFrom
    ? allRows.filter(
        (row) =>
          row.transactionDate &&
          new Date(row.transactionDate).getTime() < fromDate,
      )
    : [];

  const openingBalance = previousRows.reduce(
    (balance, row) => balance + toNumber(row.debit) - toNumber(row.credit),
    0,
  );

  const inRangeRows = allRows.filter((row) => {
    if (!row.transactionDate) return false;
    const time = new Date(row.transactionDate).getTime();
    return time >= fromDate && time <= toDate;
  });

  return {
    party: {
      kind: "supplier" as const,
      id: supplier.id,
      name: supplier.name,
      phone: supplier.phone,
      address: supplier.address,
    },
    from: query.from ?? null,
    to: query.to ?? null,
    ...buildLedger(openingBalance, inRangeRows),
  };
}
