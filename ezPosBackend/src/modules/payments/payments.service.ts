import { and, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { saasInvoices } from "../../db/schema/saasInvoices.js";
import { subscriptionPayments } from "../../db/schema/subscriptionPayments.js";
import { subscriptions } from "../../db/schema/subscriptions.js";
import { businesses } from "../../db/schema/businesses.js";
import { users } from "../../db/schema/users.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { getPaymentProvider } from "../../services/payments/index.js";
import { recordEvent } from "../subscriptions/subscription.service.js";
import { notifyPaymentSucceeded, notifySubscriptionActivated } from "../../services/email/email.hooks.js";
import { env } from "../../config/env.js";

/**
 * Payment initiation and verification. THE rule: a subscription is never
 * activated because a browser landed on a success page — activation happens
 * only inside `verifyAndActivate`, after the provider's SERVER-SIDE
 * validation succeeds and the gateway-reported amount matches our stored
 * invoice amount. Both the IPN callback and the post-redirect verify
 * endpoint funnel into that one core, which is transactional and
 * idempotent (double IPNs, concurrent callbacks, and retry clicks are all
 * safe).
 *
 * One payment row per invoice (idempotency_key = `inv-<invoiceId>`): a
 * retry after failure resets the SAME row, so the gateway always sees one
 * stable tran_id per invoice.
 */

export interface InitiatedPayment {
  paymentId: number;
  idempotencyKey: string;
  amount: number;
  currency: string;
  gatewayUrl: string;
}

export async function initiatePayment(
  businessId: number,
  invoiceId: number,
  actor: { type: "customer" | "admin" | "system"; userId?: number | null },
): Promise<InitiatedPayment> {
  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select({
        id: saasInvoices.id,
        invoiceNumber: saasInvoices.invoiceNumber,
        status: saasInvoices.status,
        total: saasInvoices.total,
        currency: saasInvoices.currency,
        subscriptionId: saasInvoices.subscriptionId,
      })
      .from(saasInvoices)
      .where(
        and(
          eq(saasInvoices.id, invoiceId),
          eq(saasInvoices.businessId, businessId),
        ),
      )
      .for("update");
    if (!invoice) {
      throw new NotFoundError("Invoice not found.");
    }
    if (invoice.status === "paid") {
      throw new ConflictError("This invoice is already paid.");
    }
    if (invoice.status !== "pending") {
      throw new BadRequestError(
        "This invoice can no longer be paid (it was voided).",
      );
    }
    if (!invoice.subscriptionId) {
      throw new BadRequestError("This invoice is not linked to a subscription.");
    }

    const [customer] = await tx
      .select({
        name: users.fullName,
        email: users.email,
        phone: users.phone,
      })
      .from(businesses)
      .innerJoin(users, eq(users.id, businesses.createdByUserId))
      .where(eq(businesses.id, businessId));
    if (!customer) {
      throw new NotFoundError("Business not found.");
    }

    const provider = getPaymentProvider();
    const idempotencyKey = `inv-${invoice.id}`;

    // One payment row per invoice: reuse it if a previous attempt failed,
    // otherwise block a duplicate (the unique idempotency_key enforces it).
    const [existing] = await tx
      .select({
        id: subscriptionPayments.id,
        status: subscriptionPayments.status,
      })
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.idempotencyKey, idempotencyKey))
      .for("update");

    if (existing && existing.status === "succeeded") {
      throw new ConflictError("This invoice is already paid.");
    }

    const gatewayInput = (paymentId: number) => ({
      tranId: idempotencyKey,
      amount: invoice.total,
      currency: invoice.currency,
      customer: {
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
      },
      description: `ezPos subscription — invoice ${invoice.invoiceNumber}`,
      urls: {
        success: `${env.appUrl}/payment/success?paymentId=${paymentId}&businessId=${businessId}`,
        fail: `${env.appUrl}/payment/failed?businessId=${businessId}`,
        cancel: `${env.appUrl}/payment/canceled?businessId=${businessId}`,
      },
      ipnUrl: `${env.backendUrl}/api/payments/ipn`,
    });

    let paymentId: number;
    if (existing) {
      // Retry: reset the row; the session below is refreshed for it.
      paymentId = existing.id;
      await tx
        .update(subscriptionPayments)
        .set({
          status: "initiated",
          failureReason: null,
          provider: provider.name,
        })
        .where(eq(subscriptionPayments.id, existing.id));
    } else {
      const [created] = await tx
        .insert(subscriptionPayments)
        .values({
          subscriptionId: invoice.subscriptionId,
          invoiceId: invoice.id,
          amount: invoice.total,
          currency: invoice.currency,
          status: "initiated",
          provider: provider.name,
          idempotencyKey,
        })
        .returning({ id: subscriptionPayments.id });
      if (!created) {
        throw new Error("Payment insert returned no row.");
      }
      paymentId = created.id;
    }

    // Gateway session (server-side, credentials never reach the browser).
    const session = await provider.initiateSession(gatewayInput(paymentId));
    await tx
      .update(subscriptionPayments)
      .set({ gatewaySessionId: session.sessionId })
      .where(eq(subscriptionPayments.id, paymentId));

    return {
      paymentId,
      idempotencyKey,
      amount: invoice.total,
      currency: invoice.currency,
      gatewayUrl: session.gatewayUrl,
    };
  });
}

export interface PaymentVerificationOutcome {
  verified: boolean;
  alreadyVerified: boolean;
  paymentId: number;
  invoiceId: number | null;
  invoiceStatus: string | null;
  subscriptionStatus: string | null;
  reason?: string;
}

/**
 * THE activation core. Server-side verification → amount check → payment +
 * invoice + subscription update in one transaction. Idempotent: a payment
 * already succeeded short-circuits with alreadyVerified (double IPNs and
 * concurrent callbacks never double-activate or double-charge records).
 */
export async function verifyAndActivate(
  valId: string,
  options: { businessId?: number | null; paymentId?: number | null; tranId?: string | null } = {},
): Promise<PaymentVerificationOutcome> {
  return db.transaction(async (tx) => {
    const paymentRow = tx
      .select({
        id: subscriptionPayments.id,
        subscriptionId: subscriptionPayments.subscriptionId,
        invoiceId: subscriptionPayments.invoiceId,
        amount: subscriptionPayments.amount,
        currency: subscriptionPayments.currency,
        status: subscriptionPayments.status,
        businessId: subscriptions.businessId,
      })
      .from(subscriptionPayments)
      .innerJoin(
        subscriptions,
        eq(subscriptions.id, subscriptionPayments.subscriptionId),
      );

    const [payment] = options.paymentId
      ? await paymentRow
          .where(eq(subscriptionPayments.id, options.paymentId))
          .for("update")
          .limit(1)
      : options.tranId
        ? await paymentRow
            .where(eq(subscriptionPayments.idempotencyKey, options.tranId))
            .for("update")
            .limit(1)
        : [];
    if (!payment) {
      throw new NotFoundError("Payment not found.");
    }
    if (
      options.businessId !== undefined &&
      options.businessId !== null &&
      payment.businessId !== options.businessId
    ) {
      // Foreign payment — same response as a missing one.
      throw new NotFoundError("Payment not found.");
    }

    if (payment.status === "succeeded") {
      return {
        verified: true,
        alreadyVerified: true,
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        invoiceStatus: "paid",
        subscriptionStatus: "active",
      };
    }

    const provider = getPaymentProvider();
    const verification = await provider.verifyPayment({ valId });
    if (!verification.valid) {
      await tx
        .update(subscriptionPayments)
        .set({
          status: "verification_failed",
          failureReason: `Gateway status: ${verification.status}`,
          providerReference: verification.transactionId,
        })
        .where(eq(subscriptionPayments.id, payment.id));
      return {
        verified: false,
        alreadyVerified: false,
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        invoiceStatus: null,
        subscriptionStatus: null,
        reason: `The gateway could not validate this payment (${verification.status}).`,
      };
    }

    if (
      verification.amount !== null &&
      Math.abs(verification.amount - payment.amount) > 0.001
    ) {
      await tx
        .update(subscriptionPayments)
        .set({
          status: "verification_failed",
          failureReason: `Amount mismatch: gateway reported ${verification.amount}, expected ${payment.amount}`,
          providerReference: verification.transactionId,
        })
        .where(eq(subscriptionPayments.id, payment.id));
      return {
        verified: false,
        alreadyVerified: false,
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        invoiceStatus: null,
        subscriptionStatus: null,
        reason: "The gateway-reported amount does not match the invoice.",
      };
    }

    // Mark the payment succeeded.
    await tx
      .update(subscriptionPayments)
      .set({
        status: "succeeded",
        providerReference: verification.transactionId,
        paidAt: new Date(),
        failureReason: null,
      })
      .where(eq(subscriptionPayments.id, payment.id));

    // Mark the invoice paid.
    if (payment.invoiceId) {
      await tx
        .update(saasInvoices)
        .set({ status: "paid", paidAt: new Date() })
        .where(eq(saasInvoices.id, payment.invoiceId));
    }

    // Activate the subscription when it is in a payable state.
    const [subscription] = await tx
      .select({ status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.id, payment.subscriptionId))
      .for("update");
    if (
      subscription &&
      // A suspended customer who pays is back in good standing.
      ["trialing", "past_due", "suspended"].includes(subscription.status)
    ) {
      await tx
        .update(subscriptions)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(subscriptions.id, payment.subscriptionId));
    }

    await recordEvent(tx, {
      subscriptionId: payment.subscriptionId,
      eventType: "invoice_paid",
      fromStatus: subscription?.status ?? null,
      toStatus: "active",
      actor: { type: "system" },
      metadata: {
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        amount: payment.amount,
        provider: provider.name,
      },
    });

    // Best-effort notifications.
    notifyPaymentSucceeded(
      payment.businessId,
      `${payment.currency} ${payment.amount.toLocaleString()}`,
      options.tranId ?? `payment-${payment.id}`,
    );
    if (subscription && subscription.status === "trialing") {
      notifySubscriptionActivated(payment.businessId, "your plan");
    }

    return {
      verified: true,
      alreadyVerified: false,
      paymentId: payment.id,
      invoiceId: payment.invoiceId,
      invoiceStatus: "paid",
      subscriptionStatus: "active",
    };
  });
}

/**
 * Marks a payment failed/canceled from a browser redirect. Never activates
 * anything; a failed payment is retried by initiating again (the row resets).
 */
export async function markPaymentAbandoned(
  businessId: number,
  paymentId: number,
  outcome: "failed" | "canceled",
): Promise<void> {
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select({ id: subscriptionPayments.id, status: subscriptionPayments.status })
      .from(subscriptionPayments)
      .innerJoin(
        subscriptions,
        eq(subscriptions.id, subscriptionPayments.subscriptionId),
      )
      .where(
        and(
          eq(subscriptionPayments.id, paymentId),
          eq(subscriptions.businessId, businessId),
        ),
      )
      .for("update");
    if (!payment || payment.status !== "initiated") return;
    await tx
      .update(subscriptionPayments)
      .set({
        status: outcome,
        failureReason:
          outcome === "failed"
            ? "Customer reported failure at the gateway."
            : "Customer canceled at the gateway.",
      })
      .where(eq(subscriptionPayments.id, paymentId));
  });
}
