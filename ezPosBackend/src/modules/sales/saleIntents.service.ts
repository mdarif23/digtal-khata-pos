import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { sales } from "../../db/schema/sales.js";
import { salePayments } from "../../db/schema/salePayments.js";
import { salePaymentIntents } from "../../db/schema/salePaymentIntents.js";
import { customers } from "../../db/schema/customers.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { env } from "../../config/env.js";
import { recordAuditInTx } from "../../services/audit.js";
import {
  resolveIntentProvider,
  type SalePaymentProviderName,
} from "../../services/payments/saleProviders.js";
import type { VerificationResult } from "../../services/payments/provider.js";

/**
 * Electronic sale-payment intents: create → (customer pays on the
 * provider's surface) → server-side verify → sale_payments row + sale due
 * update, all in one transaction. Manual cashier payment rows are a
 * separate, unchanged flow — this layer adds VERIFIED electronic payments.
 */

const EPSILON = 0.01;

export interface CreateIntentInput {
  provider: string;
  /** Method recorded on the captured payment row. */
  method: "bangla_qr" | "card";
  amount: number;
  /** Client-generated; also sent to the gateway as tran_id. */
  idempotencyKey: string;
  /** Where the customer's browser lands after the gateway. */
  redirectUrls: { success: string; fail: string; cancel: string };
}

export interface IntentResult {
  intentId: number;
  saleId: number;
  status: string;
  amount: number;
  provider: string;
  gatewayUrl: string | null;
  /** True when an existing intent was returned for the same key. */
  replayed: boolean;
}

function salePaymentStatus(paid: number, due: number) {
  if (due <= EPSILON) return "paid" as const;
  if (paid > EPSILON) return "partial" as const;
  return "unpaid" as const;
}

export async function createSalePaymentIntent(
  businessId: number,
  saleId: number,
  actorUserId: number | null,
  input: CreateIntentInput,
): Promise<IntentResult> {
  const amount = roundMoney(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestError("The payment amount must be positive.");
  }

  // 1. Validate the sale and record the pending intent atomically. The
  // unique (business_id, idempotency_key) makes duplicate submissions
  // return the same intent instead of creating a second charge.
  const intentId = await db.transaction(async (tx) => {
    const [sale] = await tx
      .select({
        id: sales.id,
        dueAmount: sales.dueAmount,
        paymentStatus: sales.paymentStatus,
      })
      .from(sales)
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
      .for("update");
    if (!sale) throw new NotFoundError("Sale not found.");
    if (sale.paymentStatus === "paid") {
      throw new ConflictError("This sale is already fully paid.");
    }
    const due = Number(sale.dueAmount);
    if (amount > due + EPSILON) {
      throw new BadRequestError(
        `The payment amount exceeds the outstanding due (${due.toFixed(2)}).`,
      );
    }

    const [existing] = await tx
      .select({ id: salePaymentIntents.id })
      .from(salePaymentIntents)
      .where(
        and(
          eq(salePaymentIntents.businessId, businessId),
          eq(salePaymentIntents.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) return { id: existing.id, replayed: true };

    const [created] = await tx
      .insert(salePaymentIntents)
      .values({
        businessId,
        saleId,
        provider: input.provider,
        method: input.method,
        amount,
        idempotencyKey: input.idempotencyKey,
        status: "pending",
      })
      .onConflictDoNothing({
        target: [salePaymentIntents.businessId, salePaymentIntents.idempotencyKey],
      })
      .returning({ id: salePaymentIntents.id });
    if (created) {
      await recordAuditInTx(tx, {
        businessId,
        actorUserId,
        action: "sale.payment_intent.created",
        entityType: "sale_payment_intent",
        entityId: created.id,
        metadata: { saleId, amount, provider: input.provider, method: input.method },
      });
      return { id: created.id, replayed: false };
    }
    // Lost a create race with the same key — replay the winner.
    const [winner] = await tx
      .select({ id: salePaymentIntents.id })
      .from(salePaymentIntents)
      .where(
        and(
          eq(salePaymentIntents.businessId, businessId),
          eq(salePaymentIntents.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (!winner) throw new ConflictError("Could not create the payment intent.");
    return { id: winner.id, replayed: true };
  });

  // 2. Existing intent with a session? Replay it — never re-initiate a
  // gateway session for the same idempotency key.
  const [intent] = await db
    .select({
      id: salePaymentIntents.id,
      saleId: salePaymentIntents.saleId,
      status: salePaymentIntents.status,
      amount: salePaymentIntents.amount,
      provider: salePaymentIntents.provider,
      gatewayUrl: salePaymentIntents.gatewayUrl,
    })
    .from(salePaymentIntents)
    .where(eq(salePaymentIntents.id, intentId.id))
    .limit(1);
  if (!intent) throw new NotFoundError("Payment intent not found.");
  if (intent.status === "cancelled") {
    throw new ConflictError(
      "This payment was cancelled — start a new payment to retry.",
    );
  }
  if (intent.gatewayUrl) {
    return {
      intentId: intent.id,
      saleId: intent.saleId,
      status: intent.status,
      amount: Number(intent.amount),
      provider: intent.provider,
      gatewayUrl: intent.gatewayUrl,
      replayed: true,
    };
  }

  // 3. Initiate the gateway session OUTSIDE any transaction — network I/O
  // never holds row locks. The gateway tran_id is the idempotency key, so
  // IPN callbacks and provider retries always land on this row.
  const resolved = await resolveIntentProvider(businessId, intent.provider);
  if ("error" in resolved) throw new BadRequestError(resolved.error);
  const [saleCustomer] = await db
    .select({ name: customers.name, phone: customers.phone, email: customers.email })
    .from(sales)
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(and(eq(sales.id, intent.saleId), eq(sales.businessId, businessId)))
    .limit(1);

  try {
    const session = await resolved.provider.initiateSession({
      tranId: input.idempotencyKey,
      amount,
      currency: "BDT",
      customer: {
        name: saleCustomer?.name ?? "Customer",
        email: saleCustomer?.email ?? "pos@ezpos.local",
        phone: saleCustomer?.phone ?? null,
      },
      description: `Invoice payment (sale #${intent.saleId})`,
      urls: input.redirectUrls,
      ipnUrl: `${env.backendUrl}/api/sales/payment-intents/ipn`,
    });
    await db
      .update(salePaymentIntents)
      .set({
        gatewayUrl: session.gatewayUrl,
        providerSessionId: session.sessionId,
        // A retry after a failed session-init returns the intent to pending.
        status: "pending",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(salePaymentIntents.id, intent.id));
    return {
      intentId: intent.id,
      saleId: intent.saleId,
      status: intent.status,
      amount,
      provider: intent.provider,
      gatewayUrl: session.gatewayUrl,
      replayed: intentId.replayed,
    };
  } catch (err) {
    await db
      .update(salePaymentIntents)
      .set({
        status: "failed",
        lastError: err instanceof Error ? err.message : "Gateway session failed.",
        updatedAt: new Date(),
      })
      .where(eq(salePaymentIntents.id, intent.id));
    throw err;
  }
}

export interface VerifyOutcome {
  verified: boolean;
  alreadyCaptured: boolean;
  intentId: number;
  saleId: number;
  salePaymentId?: number;
  salePaymentStatus?: string;
  reason?: string;
}

/**
 * THE capture core: verify the payment SERVER-SIDE with the provider, then
 * record the sale_payment row and update the sale's due in one transaction.
 * Idempotent — a captured intent short-circuits; concurrent verifications
 * serialize on the intent row lock. Called from the redirect-verify
 * endpoint (with business context) and the gateway IPN (without).
 */
export async function verifySalePaymentIntent(
  input: { businessId: number | null; intentId?: number; tranId?: string },
  valId: string,
): Promise<VerifyOutcome> {
  const lookup = db
    .select({
      id: salePaymentIntents.id,
      businessId: salePaymentIntents.businessId,
      saleId: salePaymentIntents.saleId,
      provider: salePaymentIntents.provider,
      amount: salePaymentIntents.amount,
      method: salePaymentIntents.method,
      status: salePaymentIntents.status,
    })
    .from(salePaymentIntents);

  const [intent] = input.intentId
    ? await lookup
        .where(
          input.businessId !== null
            ? and(
                eq(salePaymentIntents.id, input.intentId),
                eq(salePaymentIntents.businessId, input.businessId),
              )
            : eq(salePaymentIntents.id, input.intentId),
        )
        .limit(1)
    : input.tranId
      ? await lookup
          .where(eq(salePaymentIntents.idempotencyKey, input.tranId))
          .limit(1)
      : [];
  if (!intent) throw new NotFoundError("Payment intent not found.");
  if (
    input.businessId !== null &&
    intent.businessId !== input.businessId
  ) {
    // Foreign intent — indistinguishable from missing.
    throw new NotFoundError("Payment intent not found.");
  }

  if (intent.status === "captured") {
    return {
      verified: true,
      alreadyCaptured: true,
      intentId: intent.id,
      saleId: intent.saleId,
    };
  }
  if (intent.status !== "pending") {
    return {
      verified: false,
      alreadyCaptured: false,
      intentId: intent.id,
      saleId: intent.saleId,
      reason: `This payment is ${intent.status}.`,
    };
  }

  const resolved = await resolveIntentProvider(
    intent.businessId,
    intent.provider,
  );
  if ("error" in resolved) {
    throw new BadRequestError(resolved.error);
  }
  let verification: VerificationResult;
  try {
    verification = await resolved.provider.verifyPayment({ valId });
  } catch (err) {
    await db
      .update(salePaymentIntents)
      .set({
        verifyAttempts: sql`${salePaymentIntents.verifyAttempts} + 1`,
        lastError: err instanceof Error ? err.message : "Verification failed.",
        updatedAt: new Date(),
      })
      .where(eq(salePaymentIntents.id, intent.id));
    throw err;
  }

  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(salePaymentIntents)
      .where(eq(salePaymentIntents.id, intent.id))
      .for("update");
    if (!locked) throw new NotFoundError("Payment intent not found.");
    if (locked.status === "captured") {
      return {
        verified: true,
        alreadyCaptured: true,
        intentId: locked.id,
        saleId: locked.saleId,
      } satisfies VerifyOutcome;
    }

    if (!verification.valid) {
      await tx
        .update(salePaymentIntents)
        .set({
          status: "failed",
          verifyAttempts: sql`${salePaymentIntents.verifyAttempts} + 1`,
          lastError: `Gateway status: ${verification.status}`,
          rawResponse: verification.raw,
          updatedAt: new Date(),
        })
        .where(eq(salePaymentIntents.id, locked.id));
      await recordAuditInTx(tx, {
        businessId: locked.businessId,
        actorUserId: null,
        action: "sale.payment_intent.failed",
        entityType: "sale_payment_intent",
        entityId: locked.id,
        metadata: {
          saleId: locked.saleId,
          providerStatus: verification.status,
        },
      });
      return {
        verified: false,
        alreadyCaptured: false,
        intentId: locked.id,
        saleId: locked.saleId,
        reason: `The gateway could not validate this payment (${verification.status}).`,
      } satisfies VerifyOutcome;
    }

    if (
      verification.amount !== null &&
      Math.abs(verification.amount - Number(locked.amount)) > EPSILON
    ) {
      await tx
        .update(salePaymentIntents)
        .set({
          status: "failed",
          verifyAttempts: sql`${salePaymentIntents.verifyAttempts} + 1`,
          lastError: `Amount mismatch: gateway reported ${verification.amount}, intent ${locked.amount}`,
          rawResponse: verification.raw,
          updatedAt: new Date(),
        })
        .where(eq(salePaymentIntents.id, locked.id));
      await recordAuditInTx(tx, {
        businessId: locked.businessId,
        actorUserId: null,
        action: "sale.payment_intent.failed",
        entityType: "sale_payment_intent",
        entityId: locked.id,
        metadata: {
          saleId: locked.saleId,
          providerStatus: verification.status,
          reason: "amount_mismatch",
        },
      });
      return {
        verified: false,
        alreadyCaptured: false,
        intentId: locked.id,
        saleId: locked.saleId,
        reason: "The gateway-reported amount does not match the payment.",
      } satisfies VerifyOutcome;
    }

    // Lock the sale and reduce its due by the verified amount.
    const [sale] = await tx
      .select({
        id: sales.id,
        dueAmount: sales.dueAmount,
        paymentStatus: sales.paymentStatus,
        finalTotal: sales.finalTotal,
      })
      .from(sales)
      .where(
        and(
          eq(sales.id, locked.saleId),
          eq(sales.businessId, locked.businessId),
        ),
      )
      .for("update");
    if (!sale) throw new NotFoundError("Sale not found.");

    const newDue = roundMoney(
      Math.max(0, Number(sale.dueAmount) - Number(locked.amount)),
    );
    const paid = roundMoney(Number(sale.finalTotal) - newDue);
    const nextStatus = salePaymentStatus(paid, newDue);

    const [paymentRow] = await tx
      .insert(salePayments)
      .values({
        businessId: locked.businessId,
        saleId: locked.saleId,
        amount: roundMoney(Number(locked.amount)),
        paymentMethod: locked.method,
        reference: verification.transactionId,
      })
      .returning({ id: salePayments.id });
    if (!paymentRow) {
      throw new Error("Sale payment insert returned no row.");
    }

    await tx
      .update(sales)
      .set({ dueAmount: newDue, paymentStatus: nextStatus })
      .where(
        and(
          eq(sales.id, locked.saleId),
          eq(sales.businessId, locked.businessId),
        ),
      );

    await tx
      .update(salePaymentIntents)
      .set({
        status: "captured",
        providerTxnId: verification.transactionId,
        capturedSalePaymentId: paymentRow.id,
        rawResponse: verification.raw,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(salePaymentIntents.id, locked.id));

    await recordAuditInTx(tx, {
      businessId: locked.businessId,
      actorUserId: null,
      action: "sale.payment.captured",
      entityType: "sale_payment_intent",
      entityId: locked.id,
      metadata: {
        saleId: locked.saleId,
        salePaymentId: paymentRow.id,
        amount: Number(locked.amount),
        provider: locked.provider,
        method: locked.method,
        source: input.businessId === null ? "ipn" : "verify",
      },
    });

    return {
      verified: true,
      alreadyCaptured: false,
      intentId: locked.id,
      saleId: locked.saleId,
      salePaymentId: paymentRow.id,
      salePaymentStatus: nextStatus,
    } satisfies VerifyOutcome;
  });

  return outcome;
}

export async function cancelSalePaymentIntent(
  businessId: number,
  intentId: number,
  actorUserId: number | null,
): Promise<{ cancelled: boolean }> {
  return db.transaction(async (tx) => {
    const [intent] = await tx
      .select({ id: salePaymentIntents.id, status: salePaymentIntents.status })
      .from(salePaymentIntents)
      .where(
        and(
          eq(salePaymentIntents.id, intentId),
          eq(salePaymentIntents.businessId, businessId),
        ),
      )
      .for("update");
    if (!intent) throw new NotFoundError("Payment intent not found.");
    if (intent.status === "captured") {
      throw new ConflictError("A captured payment cannot be cancelled.");
    }
    if (intent.status !== "pending") {
      return { cancelled: false };
    }
    await tx
      .update(salePaymentIntents)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(salePaymentIntents.id, intent.id));
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "sale.payment_intent.cancelled",
      entityType: "sale_payment_intent",
      entityId: intent.id,
      metadata: {},
    });
    return { cancelled: true };
  });
}

/** Type re-export for the controller. */
export type { SalePaymentProviderName };
