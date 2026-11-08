import { and, eq } from "drizzle-orm";
import { sales } from "../../db/schema/sales.js";
import { salePayments } from "../../db/schema/salePayments.js";
import { saleItems as saleItemsForCost } from "../../db/schema/saleItems.js";
import type { Tx } from "../../services/audit.js";
import {
  isLedgerActivatedInTx,
  postJournalEntry,
  resolveCashAccountForMethod,
} from "../../services/ledger.js";
import { roundMoney } from "../../utils/roundMoney.js";

/**
 * Sales → GL posting hooks (Finance & Growth Stage 3).
 *
 * Treatment matrix (docs/finance-growth/phase-0-audit-and-architecture.md
 * §7.5 — formulas documented inline). All hooks are:
 *  - idempotent (one posted entry per source row via the gateway's
 *    (business, source_type, source_id) unique),
 *  - no-ops before Finance activation (legacy behavior preserved),
 *  - atomic with the business flow (called inside the same transaction).
 */

/** Payment methods that are liabilities rather than money. */
const INSTRUMENT_ACCOUNT_BY_METHOD: Record<string, string> = {
  store_credit: "2050",
  gift_card: "2040",
  loyalty_points: "2060",
};

const CASH_LIKE_METHODS = new Set(["cash", "bangla_qr", "card", "sslcommerz"]);

export interface SaleLedgerPayment {
  method: string;
  amount: number;
}

/**
 * Sale (POS / online / exchange replacement):
 *   DR  cash/bank/MFS accounts (by payment method, payment_account_id-aware)
 *   DR  instrument liabilities (store credit 2050 / gift card 2040 / loyalty 2060)
 *   DR  1040 Accounts Receivable for the residual (= due; for exchanges the
 *        return value netted against the replacement)
 *   CR  4010 Sales Revenue  = final_total − vat − delivery_fee
 *   CR  2020 VAT Payable    = sales.vat
 *   CR  4030 Delivery Income = sales.delivery_fee
 * Identity: Σ payments + due = final_total is enforced by payment
 * validation, so the entry balances by construction.
 */
export async function postSaleLedgerEntry(
  tx: Tx,
  params: {
    saleId: number;
    businessId: number;
    locationId: number | null;
    payments: SaleLedgerPayment[];
    actorUserId: number | null;
  },
): Promise<void> {
  if (!(await isLedgerActivatedInTx(tx, params.businessId))) return;

  const [sale] = await tx
    .select({
      id: sales.id,
      finalTotal: sales.finalTotal,
      vat: sales.vat,
      deliveryFee: sales.deliveryFee,
      dueAmount: sales.dueAmount,
    })
    .from(sales)
    .where(
      eq(sales.id, params.saleId),
    )
    .limit(1);
  if (!sale) {
    throw new Error(`Ledger hook: sale ${params.saleId} not found`);
  }

  const lines: Parameters<typeof postJournalEntry>[1]["lines"] = [];
  let paidPoisha = 0;
  for (const payment of params.payments) {
    const amount = roundMoney(Number(payment.amount ?? 0));
    if (amount <= 0) continue;
    paidPoisha += Math.round(amount * 100);
    const instrumentAccount = INSTRUMENT_ACCOUNT_BY_METHOD[payment.method];
    if (instrumentAccount) {
      lines.push({
        accountCode: instrumentAccount,
        debit: amount,
        locationId: params.locationId,
        description: `${payment.method.replace("_", " ")} redeemed`,
      });
    } else if (CASH_LIKE_METHODS.has(payment.method)) {
      const { account, paymentAccountId } = await resolveCashAccountForMethod(
        tx,
        params.businessId,
        payment.method,
      );
      lines.push({
        accountId: account.id,
        debit: amount,
        locationId: params.locationId,
        description: `Sale payment (${payment.method})`,
      });
      // Keep the operational row on the same payment account (nullable —
      // account resolution may fall back to a bare GL account).
      if (paymentAccountId != null) {
        await tx
          .update(salePayments)
          .set({ paymentAccountId })
          .where(
            and(
              eq(salePayments.saleId, params.saleId),
              eq(salePayments.businessId, params.businessId),
              eq(salePayments.paymentMethod, payment.method),
            ),
          );
      }
    } else {
      // Unknown future method — fail loudly rather than post an unbalanced
      // entry; the gateway would reject it anyway.
      throw new Error(
        `Ledger hook: unmapped sale payment method "${payment.method}"`,
      );
    }
  }

  // Residual = due (normal sales) or the netted return value (exchanges).
  const residual = roundMoney(Number(sale.finalTotal) - paidPoisha / 100);
  if (residual > 0.005) {
    lines.push({
      accountCode: "1040",
      debit: residual,
      locationId: params.locationId,
      description:
        Number(sale.dueAmount) > 0.005
          ? "Customer due"
          : "Return value applied",
    });
  }

  const finalTotal = roundMoney(Number(sale.finalTotal));
  const vat = Math.min(roundMoney(Number(sale.vat ?? 0)), finalTotal);
  const delivery = roundMoney(Number(sale.deliveryFee ?? 0));
  const revenue = roundMoney(finalTotal - vat - delivery);
  if (revenue > 0) {
    lines.push({
      accountCode: "4010",
      credit: revenue,
      locationId: params.locationId,
      description: "Sales revenue (net of discounts and VAT)",
    });
  }
  if (vat > 0) {
    lines.push({
      accountCode: "2020",
      credit: vat,
      locationId: params.locationId,
      description: "VAT collected",
    });
  }
  if (delivery > 0) {
    lines.push({
      accountCode: "4030",
      credit: delivery,
      locationId: params.locationId,
      description: "Delivery income",
    });
  }

  // Perpetual inventory: COGS at sale (blended cost_at_sale per line) with
  // the matching inventory reduction — keeps GL 1050 reconciled with the
  // batch valuation.
  const saleLines = await tx
    .select({
      quantity: saleItemsForCost.quantity,
      costAtSale: saleItemsForCost.costAtSale,
    })
    .from(saleItemsForCost)
    .where(eq(saleItemsForCost.saleId, params.saleId));
  const cogs = roundMoney(
    saleLines.reduce(
      (sum, line) => sum + Number(line.costAtSale) * line.quantity,
      0,
    ),
  );
  if (cogs > 0.005) {
    lines.push({
      accountCode: "5010",
      debit: cogs,
      locationId: params.locationId,
      description: "Cost of goods sold",
    });
    lines.push({
      accountCode: "1050",
      credit: cogs,
      locationId: params.locationId,
      description: "Inventory sold",
    });
  }

  await postJournalEntry(tx, {
    businessId: params.businessId,
    memo: `Sale ${params.saleId}`,
    sourceType: "sale",
    sourceId: params.saleId,
    cashFlowCategory: "operating",
    lines,
    actorUserId: params.actorUserId,
  });
}

export interface RefundLedgerParams {
  businessId: number;
  saleId: number;
  refundId: number;
  refundTotal: number;
  /** Money that physically left the drawer (cash refunds / exchange surplus payouts). */
  cashOut: number;
  /**
   * Where the NON-cash value went: 'store_credit' → 2050,
   * 'original_payment' → 1020, anything else (NULL) → 1040 customer credit
   * (reduces the receivable; for exchanges it is consumed by the
   * replacement sale's own 1040 line).
   */
  nonCashMethod: string | null;
  /** Value returned to inventory (disposition=restock) — reverses COGS. */
  restockedCost: number;
  locationId: number | null;
  actorUserId: number | null;
}

/**
 * Refund:
 *   DR  4020 Sales Returns  = refund_total − refund VAT share
 *   DR  2020 VAT Payable    = refund_total × (sale.vat / sale.final_total)
 *       (pro-rata — per-rate refund tax breakdown does not exist; documented
 *       approximation)
 *   CR  cash account        = cashOut (drawer/counter payouts)
 *   CR  2050 store credit   = remainder when settled as store credit
 *   CR  1020 bank            = remainder when refunded to the original
 *                              instrument (provider payout)
 *   CR  1040 receivable      = remainder otherwise (dues refunds / exchange
 *                              netting)
 *   Restock (disposition=restock): DR 1050 Inventory / CR 5010 COGS at
 *   cost_at_sale — matches the POS-005 profit convention.
 */
export async function postRefundLedgerEntry(
  tx: Tx,
  params: RefundLedgerParams,
): Promise<void> {
  if (!(await isLedgerActivatedInTx(tx, params.businessId))) return;

  const [sale] = await tx
    .select({ vat: sales.vat, finalTotal: sales.finalTotal })
    .from(sales)
    .where(eq(sales.id, params.saleId))
    .limit(1);

  const refundTotal = roundMoney(params.refundTotal);
  const lines: Parameters<typeof postJournalEntry>[1]["lines"] = [];

  let refundVat = 0;
  if (sale && Number(sale.finalTotal) > 0) {
    refundVat = Math.min(
      roundMoney(refundTotal * (Number(sale.vat ?? 0) / Number(sale.finalTotal))),
      refundTotal,
    );
  }
  const returnsNet = roundMoney(refundTotal - refundVat);
  if (returnsNet > 0) {
    lines.push({
      accountCode: "4020",
      debit: returnsNet,
      locationId: params.locationId,
      description: "Sales returns",
    });
  }
  if (refundVat > 0) {
    lines.push({
      accountCode: "2020",
      debit: refundVat,
      locationId: params.locationId,
      description: "VAT reversed on refund (pro-rata)",
    });
  }

  const cashOut = Math.min(roundMoney(params.cashOut), refundTotal);
  if (cashOut > 0) {
    const { account } = await resolveCashAccountForMethod(tx, params.businessId, "cash");
    lines.push({
      accountId: account.id,
      credit: cashOut,
      locationId: params.locationId,
      description: "Cash refunded",
    });
  }
  const remainder = roundMoney(refundTotal - cashOut);
  if (remainder > 0) {
    if (params.nonCashMethod === "store_credit") {
      lines.push({
        accountCode: "2050",
        credit: remainder,
        locationId: params.locationId,
        description: "Refund settled as store credit",
      });
    } else if (params.nonCashMethod === "original_payment") {
      const { account } = await resolveCashAccountForMethod(tx, params.businessId, "card");
      lines.push({
        accountId: account.id,
        credit: remainder,
        locationId: params.locationId,
        description: "Refund to original payment instrument",
      });
    } else {
      lines.push({
        accountCode: "1040",
        credit: remainder,
        locationId: params.locationId,
        description: "Refund against customer balance",
      });
    }
  }

  if (params.restockedCost > 0.005) {
    lines.push({
      accountCode: "1050",
      debit: roundMoney(params.restockedCost),
      locationId: params.locationId,
      description: "Returned goods restocked at cost",
    });
    lines.push({
      accountCode: "5010",
      credit: roundMoney(params.restockedCost),
      locationId: params.locationId,
      description: "COGS reversed for restocked returns",
    });
  }

  await postJournalEntry(tx, {
    businessId: params.businessId,
    memo: `Refund of sale ${params.saleId}`,
    sourceType: "sale_refund",
    sourceId: params.refundId,
    cashFlowCategory: "operating",
    lines,
    actorUserId: params.actorUserId,
  });
}

/**
 * Due collection (customer payment on an unpaid invoice):
 *   DR  cash/bank/MFS account   DR-side by method
 *   CR  1040 Accounts Receivable
 * Also stamps the payment row with the resolved payment_account_id so the
 * operational ledger carries the same account mapping.
 */
export async function postDueCollectionLedgerEntry(
  tx: Tx,
  params: {
    businessId: number;
    paymentId: number;
    amount: number;
    method: string;
    locationId: number | null;
    actorUserId: number | null;
  },
): Promise<void> {
  if (!(await isLedgerActivatedInTx(tx, params.businessId))) return;

  const amount = roundMoney(params.amount);
  const isCashLike = CASH_LIKE_METHODS.has(params.method);
  let accountId: number | null = null;
  if (isCashLike) {
    const { account, paymentAccountId } = await resolveCashAccountForMethod(
      tx,
      params.businessId,
      params.method,
    );
    accountId = account.id;
    // Keep the operational row and the GL line on the same payment account.
    if (paymentAccountId != null) {
      await tx
        .update(salePayments)
        .set({ paymentAccountId })
        .where(eq(salePayments.id, params.paymentId));
    }
  }

  const lines: Parameters<typeof postJournalEntry>[1]["lines"] = [];
  if (accountId) {
    lines.push({
      accountId,
      debit: amount,
      locationId: params.locationId,
      description: `Due collection (${params.method})`,
    });
  } else {
    const instrumentAccount = INSTRUMENT_ACCOUNT_BY_METHOD[params.method];
    if (!instrumentAccount) {
      throw new Error(
        `Ledger hook: unmapped due-collection method "${params.method}"`,
      );
    }
    lines.push({
      accountCode: instrumentAccount,
      debit: amount,
      locationId: params.locationId,
      description: `Due collection (${params.method})`,
    });
  }
  lines.push({
    accountCode: "1040",
    credit: amount,
    locationId: params.locationId,
    description: "Receivable settled",
  });

  await postJournalEntry(tx, {
    businessId: params.businessId,
    memo: `Due collection on sale payment ${params.paymentId}`,
    sourceType: "sale_due_collection",
    sourceId: params.paymentId,
    cashFlowCategory: "operating",
    lines,
    actorUserId: params.actorUserId,
  });
}
