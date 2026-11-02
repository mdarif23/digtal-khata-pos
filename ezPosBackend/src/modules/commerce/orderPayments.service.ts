import { and, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { onlineOrderPayments } from "../../db/schema/onlineOrderPayments.js";
import { salePayments } from "../../db/schema/salePayments.js";
import { sales } from "../../db/schema/sales.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { getPaymentProvider } from "../../services/payments/index.js";
import { env } from "../../config/env.js";
import {
  confirmOnlineOrderInTx,
  type CreateOnlineOrderInput,
  createOnlineOrder,
} from "./orders.service.js";

/**
 * Online-order gateway payments (stage 5). Mirrors the subscription
 * payment core's rules:
 *
 * - One payment row per order (idempotency_key = `ord-<saleId>`); retries
 *   reset the SAME row so the gateway sees one stable tran_id.
 * - THE rule: an order is never marked paid because a browser landed on a
 *   success page. Success happens only inside `verifyOrderPayment` after
 *   SERVER-side gateway validation AND an amount match. Both the IPN
 *   callback and the post-redirect verify funnel into that one
 *   transactional, idempotent core.
 * - On success: sale_payments ledger row + payment_status=paid + order
 *   confirmation (FIFO stock consumption) — one transaction.
 *
 * Unpaid orders stay `pending` with active reservations; the existing
 * reservation-expiry sweep cancels abandoned ones and releases stock.
 */

export interface InitiatedOrderPayment {
  saleId: number;
  invoiceNumber: string;
  paymentId: number;
  amount: number;
  currency: string;
  gatewayUrl: string;
}

function orderTranId(saleId: number): string {
  return `ord-${saleId}`;
}

export async function initiateOrderPayment(
  input: CreateOnlineOrderInput & { storefrontId: number; returnOrigin: string },
): Promise<InitiatedOrderPayment> {
  const order = await createOnlineOrder(input);

  const provider = getPaymentProvider();
  const idempotencyKey = orderTranId(order.saleId);

  return db.transaction(async (tx) => {
    const [sale] = await tx
      .select({
        id: sales.id,
        invoiceNumber: sales.invoiceNumber,
        finalTotal: sales.finalTotal,
        paymentStatus: sales.paymentStatus,
        status: sales.status,
      })
      .from(sales)
      .where(
        and(eq(sales.id, order.saleId), eq(sales.businessId, input.businessId)),
      )
      .for("update");
    if (!sale) throw new NotFoundError("Order not found.");
    if (sale.paymentStatus === "paid") {
      throw new ConflictError("This order is already paid.");
    }
    if (sale.status !== "pending") {
      throw new BadRequestError("This order can no longer be paid online.");
    }

    // One payment row per order: reuse on retry (reset a failure), block
    // after success (handled above via the sale's paid status).
    const [existing] = await tx
      .select({
        id: onlineOrderPayments.id,
        status: onlineOrderPayments.status,
      })
      .from(onlineOrderPayments)
      .where(eq(onlineOrderPayments.idempotencyKey, idempotencyKey))
      .for("update");

    const amount = Number(sale.finalTotal ?? 0);
    const gatewayInput = {
      tranId: idempotencyKey,
      amount,
      currency: "BDT",
      customer: input.customer,
      description: `Order ${sale.invoiceNumber} — ${input.channel === "woocommerce" ? "WooCommerce" : "storefront"}`,
      // Post-payment the shopper lands back on THEIR storefront; the
      // renderer then triggers the server-side verification. The redirect
      // itself never marks anything paid.
      urls: {
        success: `${input.returnOrigin}/orders/pay/return?sale=${sale.id}`,
        fail: `${input.returnOrigin}/orders/pay/return?sale=${sale.id}&outcome=fail`,
        cancel: `${input.returnOrigin}/orders/pay/return?sale=${sale.id}&outcome=cancel`,
      },
      ipnUrl: `${env.backendUrl}/api/payments/ipn`,
    };

    let paymentId: number;
    if (existing && existing.status === "succeeded") {
      throw new ConflictError("This order is already paid.");
    }
    if (existing) {
      await tx
        .update(onlineOrderPayments)
        .set({
          status: "pending",
          provider: provider.name,
          amount,
          sessionId: null,
          valId: null,
          gatewayReference: null,
          verifiedAt: null,
        })
        .where(eq(onlineOrderPayments.id, existing.id));
      paymentId = existing.id;
    } else {
      const [created] = await tx
        .insert(onlineOrderPayments)
        .values({
          businessId: input.businessId,
          storefrontId: input.storefrontId,
          saleId: sale.id,
          idempotencyKey,
          provider: provider.name,
          amount,
          status: "pending",
        })
        .returning({ id: onlineOrderPayments.id });
      if (!created) throw new Error("Payment insert returned no row.");
      paymentId = created.id;
    }

    const session = await provider.initiateSession({
      ...gatewayInput,
      customer: {
        name: input.customer.name,
        email: input.customer.email ?? "shopper@ezpos.store",
        phone: input.customer.phone ?? null,
      },
    });

    await tx
      .update(onlineOrderPayments)
      .set({ sessionId: session.sessionId })
      .where(eq(onlineOrderPayments.id, paymentId));

    return {
      saleId: sale.id,
      invoiceNumber: sale.invoiceNumber,
      paymentId,
      amount,
      currency: "BDT",
      gatewayUrl: session.gatewayUrl,
    };
  });
}

export interface OrderPaymentVerification {
  paid: boolean;
  saleId: number;
  invoiceNumber: string;
  amount: number;
  status: string;
  message: string;
}

/**
 * THE verify core. `valId` comes from the gateway's redirect query or IPN —
 * always validated server-side. Idempotent: repeated/concurrent calls with
 * the same val_id return the already-paid result.
 */
export async function verifyOrderPayment(options: {
  tranId: string;
  valId: string;
}): Promise<OrderPaymentVerification> {
  const provider = getPaymentProvider();
  const outcome = await provider.verifyPayment({ valId: options.valId });

  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(onlineOrderPayments)
      .where(eq(onlineOrderPayments.idempotencyKey, options.tranId))
      .for("update");
    if (!payment) {
      throw new NotFoundError("No payment session matches this order.");
    }

    const [sale] = await tx
      .select({
        id: sales.id,
        invoiceNumber: sales.invoiceNumber,
        status: sales.status,
        paymentStatus: sales.paymentStatus,
        finalTotal: sales.finalTotal,
        dueAmount: sales.dueAmount,
        customerId: sales.customerId,
      })
      .from(sales)
      .where(
        and(
          eq(sales.id, payment.saleId),
          eq(sales.businessId, payment.businessId),
        ),
      )
      .for("update");

    if (!sale) {
      throw new NotFoundError("Order not found for this payment.");
    }

    if (payment.status === "succeeded" && sale.paymentStatus === "paid") {
      return {
        paid: true,
        saleId: sale.id,
        invoiceNumber: sale.invoiceNumber,
        amount: Number(sale.finalTotal ?? 0),
        status: sale.status,
        message: "This order is already paid.",
      };
    }

    if (!outcome.valid) {
      await tx
        .update(onlineOrderPayments)
        .set({ status: "failed" })
        .where(eq(onlineOrderPayments.id, payment.id));
      return {
        paid: false,
        saleId: sale.id,
        invoiceNumber: sale.invoiceNumber,
        amount: Number(sale.finalTotal ?? 0),
        status: sale.status,
        message: "The payment could not be verified with the gateway.",
      };
    }

    // Amount match: the gateway-reported amount (when the provider returns
    // one) must equal our stored amount.
    if (
      outcome.amount !== null &&
      Math.abs(outcome.amount - Number(payment.amount)) > 0.001
    ) {
      await tx
        .update(onlineOrderPayments)
        .set({ status: "failed" })
        .where(eq(onlineOrderPayments.id, payment.id));
      throw new BadRequestError(
        "The gateway-reported amount does not match this order.",
      );
    }

    // Ledger + order in ONE transaction: sale_payments row (per-business
    // reference uniqueness applies), sale paid, then FIFO stock consumption
    // via the shared confirm workflow.
    await tx.insert(salePayments).values({
      businessId: payment.businessId,
      saleId: sale.id,
      customerId: sale.customerId,
      amount: Number(payment.amount),
      paymentMethod: "sslcommerz",
      reference: outcome.transactionId ?? options.valId,
      notes: `Online payment via ${payment.provider} (val_id ${options.valId})`,
    });

    await tx
      .update(sales)
      .set({ paymentStatus: "paid", dueAmount: 0 })
      .where(eq(sales.id, sale.id));

    await tx
      .update(onlineOrderPayments)
      .set({
        status: "succeeded",
        valId: options.valId,
        gatewayReference: outcome.transactionId,
        verifiedAt: new Date(),
      })
      .where(eq(onlineOrderPayments.id, payment.id));

    // Consume stock + complete the order INSIDE this transaction (the tx
    // variant — the public one would deadlock on the sale row lock we hold).
    if (sale.status === "pending") {
      await confirmOnlineOrderInTx(tx, payment.businessId, sale.id);
    }

    return {
      paid: true,
      saleId: sale.id,
      invoiceNumber: sale.invoiceNumber,
      amount: Number(payment.amount),
      status: "completed",
      message: "Payment verified. The order is confirmed.",
    };
  });
}

/**
 * Gateway IPN entry point for ORDER payments (tran_id `ord-…`). The IPN
 * payload is form-urlencoded; every field is verified server-side — the
 * IPN's own status field is never trusted.
 */
export async function handleOrderPaymentIpn(payload: {
  tranId: string;
  valId: string;
}): Promise<{ handled: boolean; paid: boolean }> {
  try {
    const result = await verifyOrderPayment({
      tranId: payload.tranId,
      valId: payload.valId,
    });
    return { handled: true, paid: result.paid };
  } catch (err) {
    // Unknown tran ids and invalid val_ids must not crash the IPN endpoint —
    // the gateway retries otherwise.
    console.error("Order payment IPN handling failed:", err);
    return { handled: false, paid: false };
  }
}
