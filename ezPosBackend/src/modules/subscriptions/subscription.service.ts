import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { saasInvoices } from "../../db/schema/saasInvoices.js";
import {
  subscriptionPlans,
  type PlanLimits,
} from "../../db/schema/subscriptionPlans.js";
import { subscriptionEvents } from "../../db/schema/subscriptionEvents.js";
import { subscriptions } from "../../db/schema/subscriptions.js";
import { subscriptionPayments } from "../../db/schema/subscriptionPayments.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { addDays, computeUpgradeCharge } from "../../utils/subscription.js";
import {
  notifySubscriptionActivated,
  notifySubscriptionCanceled,
  notifySubscriptionRenewed,
} from "../../services/email/email.hooks.js";

/**
 * THE centralized subscription service. Every lifecycle transition — plan
 * changes, cancellation, renewal, suspension — goes through here and writes
 * an audit row to subscription_events. Controllers and future background
 * jobs must never mutate subscription rows directly.
 *
 * Billing policy (documented, deliberate):
 * - Upgrade while trialing: plan switches immediately, no charge, trial
 *   period unchanged.
 * - Upgrade while active: takes effect immediately; a prorated invoice for
 *   the price difference over the REMAINING period is issued as `pending`
 *   (payment handling lands in the payments phase). The period end does not
 *   change.
 * - Downgrade (or same-price interval change): scheduled via
 *   subscriptions.pending_plan_id and applied at the next renewal.
 * - Cancellation: default keeps access until period end
 *   (cancel_at_period_end); immediate cancellation drops to read-only at
 *   once. Reactivation undoes a scheduled cancellation.
 * - Downgraded unused time is never credited; upgrades are never backdated.
 */

const OPEN_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Db = typeof db;

export type ActorType = "customer" | "admin" | "system";

export interface Actor {
  type: ActorType;
  userId?: number | null;
}

function addInterval(date: Date, interval: "monthly" | "yearly"): Date {
  const next = new Date(date.getTime());
  if (interval === "monthly") {
    next.setUTCMonth(next.getUTCMonth() + 1);
  } else {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
  }
  return next;
}

export async function recordEvent(
  tx: Tx | Db,
  input: {
    subscriptionId: number;
    eventType: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    actor: Actor;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(subscriptionEvents).values({
    subscriptionId: input.subscriptionId,
    eventType: input.eventType,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    actorType: input.actor.type,
    actorUserId: input.actor.userId ?? null,
    metadata: input.metadata ?? null,
  });
}

export interface OpenSubscription {
  id: number;
  businessId: number;
  planId: number;
  status: "trialing" | "active" | "past_due";
  startsAt: Date;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  pendingPlanId: number | null;
  planName: string;
  planSlug: string;
  planPrice: number;
  planInterval: "monthly" | "yearly";
  planLimits: PlanLimits | null;
}

export async function getOpenSubscription(
  businessId: number,
  tx: Tx | Db = db,
): Promise<OpenSubscription | null> {
  const [row] = await tx
    .select({
      id: subscriptions.id,
      businessId: subscriptions.businessId,
      planId: subscriptions.planId,
      status: subscriptions.status,
      startsAt: subscriptions.startsAt,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      pendingPlanId: subscriptions.pendingPlanId,
      planName: subscriptionPlans.name,
      planSlug: subscriptionPlans.slug,
      planPrice: subscriptionPlans.price,
      planInterval: subscriptionPlans.interval,
      planLimits: subscriptionPlans.limits,
    })
    .from(subscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
    .where(
      and(
        eq(subscriptions.businessId, businessId),
        inArray(subscriptions.status, [...OPEN_SUBSCRIPTION_STATUSES]),
      ),
    )
    .limit(1);
  // The WHERE clause restricts to open statuses; the column type carries the
  // full enum, so narrow it for callers.
  return row ? (row as OpenSubscription) : null;
}

async function requirePlan(planId: number) {
  const [plan] = await db
    .select({
      id: subscriptionPlans.id,
      name: subscriptionPlans.name,
      price: subscriptionPlans.price,
      interval: subscriptionPlans.interval,
      isActive: subscriptionPlans.isActive,
    })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, planId));
  if (!plan) {
    throw new NotFoundError("The selected plan does not exist.");
  }
  return plan;
}

async function issueInvoice(
  tx: Tx,
  input: {
    businessId: number;
    subscriptionId: number;
    total: number;
    currency: string;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    dueAt?: Date | null;
  },
) {
  const [invoice] = await tx
    .insert(saasInvoices)
    .values({
      businessId: input.businessId,
      subscriptionId: input.subscriptionId,
      status: "pending",
      subtotal: input.total,
      total: input.total,
      currency: input.currency,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      dueAt: input.dueAt ?? null,
    })
    .returning({
      id: saasInvoices.id,
      invoiceNumber: saasInvoices.invoiceNumber,
      total: saasInvoices.total,
      status: saasInvoices.status,
    });
  if (!invoice) {
    throw new Error("Invoice insert returned no row.");
  }
  return invoice;
}

export interface ChangePlanResult {
  outcome: "upgraded" | "scheduled" | "trial_plan_changed";
  subscription: OpenSubscription;
  invoice: { id: number; invoiceNumber: string; total: number } | null;
}

/**
 * Changes the business's plan. See the billing policy in the module docs.
 * The caller passes the verified businessId and actor — controllers supply
 * the actor from req.user; background jobs pass { type: "system" }.
 */
export async function changePlan(
  businessId: number,
  targetPlanId: number,
  actor: Actor,
): Promise<ChangePlanResult> {
  return db.transaction(async (tx) => {
    const current = await getOpenSubscription(businessId, tx);
    if (!current) {
      throw new NotFoundError(
        "This business has no open subscription to change.",
      );
    }
    if (targetPlanId === current.planId) {
      throw new BadRequestError("The subscription is already on this plan.");
    }
    const target = await requirePlan(targetPlanId);
    if (!target.isActive) {
      throw new BadRequestError("That plan is no longer available.");
    }

    // Trials switch plans freely — nothing is being paid yet.
    if (current.status === "trialing") {
      await tx
        .update(subscriptions)
        .set({ planId: target.id, updatedAt: new Date() })
        .where(eq(subscriptions.id, current.id));
      await recordEvent(tx, {
        subscriptionId: current.id,
        eventType: "trial_plan_changed",
        fromStatus: "trialing",
        toStatus: "trialing",
        actor,
        metadata: {
          fromPlanId: current.planId,
          toPlanId: target.id,
          toPlanName: target.name,
        },
      });
      const updated = await getOpenSubscription(businessId, tx);
      return {
        outcome: "trial_plan_changed" as const,
        subscription: updated!,
        invoice: null,
      };
    }

    const isUpgrade = target.price > current.planPrice;
    if (!isUpgrade) {
      // Downgrade or equal-price cycle change: apply at period end.
      await tx
        .update(subscriptions)
        .set({ pendingPlanId: target.id, updatedAt: new Date() })
        .where(eq(subscriptions.id, current.id));
      await recordEvent(tx, {
        subscriptionId: current.id,
        eventType: "plan_change_scheduled",
        fromStatus: current.status,
        toStatus: current.status,
        actor,
        metadata: {
          fromPlanId: current.planId,
          toPlanId: target.id,
          toPlanName: target.name,
          effectiveAt: current.currentPeriodEnd.toISOString(),
        },
      });
      const updated = await getOpenSubscription(businessId, tx);
      return {
        outcome: "scheduled" as const,
        subscription: updated!,
        invoice: null,
      };
    }

    // Immediate upgrade: prorated invoice for the remaining period.
    const charge = computeUpgradeCharge(
      current.planPrice,
      target.price,
      current.currentPeriodStart,
      current.currentPeriodEnd,
      new Date(),
    );
    const invoice =
      charge > 0
        ? await issueInvoice(tx, {
            businessId,
            subscriptionId: current.id,
            total: charge,
            currency: "BDT",
            periodStart: current.currentPeriodStart,
            periodEnd: current.currentPeriodEnd,
            dueAt: addDays(new Date(), 7),
          })
        : null;

    await tx
      .update(subscriptions)
      .set({
        planId: target.id,
        status: "active",
        pendingPlanId: null,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, current.id));
    await recordEvent(tx, {
      subscriptionId: current.id,
      eventType: "plan_upgraded",
      fromStatus: current.status,
      toStatus: "active",
      actor,
      metadata: {
        fromPlanId: current.planId,
        toPlanId: target.id,
        toPlanName: target.name,
        proratedCharge: charge,
        invoiceId: invoice?.id ?? null,
      },
    });

    const updated = await getOpenSubscription(businessId, tx);
    return {
      outcome: "upgraded" as const,
      subscription: updated!,
      invoice,
    };
  });
}

export interface CancelResult {
  outcome: "cancellation_scheduled" | "canceled";
}

export async function cancelSubscription(
  businessId: number,
  actor: Actor,
  options: { immediate?: boolean } = {},
): Promise<CancelResult> {
  return db.transaction(async (tx) => {
    const current = await getOpenSubscription(businessId, tx);
    if (!current) {
      throw new NotFoundError(
        "This business has no open subscription to cancel.",
      );
    }
    if (options.immediate) {
      await tx
        .update(subscriptions)
        .set({
          status: "canceled",
          canceledAt: new Date(),
          cancelAtPeriodEnd: false,
          pendingPlanId: null,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, current.id));
      await recordEvent(tx, {
        subscriptionId: current.id,
        eventType: "canceled",
        fromStatus: current.status,
        toStatus: "canceled",
        actor,
        metadata: { immediate: true },
      });
      notifySubscriptionCanceled(businessId, current.planName);
      return { outcome: "canceled" as const };
    }

    await tx
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(subscriptions.id, current.id));
    await recordEvent(tx, {
      subscriptionId: current.id,
      eventType: "cancellation_scheduled",
      fromStatus: current.status,
      toStatus: current.status,
      actor,
      metadata: { effectiveAt: current.currentPeriodEnd.toISOString() },
    });
    return { outcome: "cancellation_scheduled" as const };
  });
}

export async function reactivateSubscription(
  businessId: number,
  actor: Actor,
): Promise<void> {
  return db.transaction(async (tx) => {
    const current = await getOpenSubscription(businessId, tx);
    if (!current) {
      throw new NotFoundError(
        "This business has no open subscription to reactivate.",
      );
    }
    if (!current.cancelAtPeriodEnd) {
      throw new BadRequestError(
        "This subscription is not scheduled for cancellation.",
      );
    }
    await tx
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: false, updatedAt: new Date() })
      .where(eq(subscriptions.id, current.id));
    await recordEvent(tx, {
      subscriptionId: current.id,
      eventType: "reactivated",
      fromStatus: current.status,
      toStatus: current.status,
      actor,
    });
  });
}

/**
 * Starts a NEW paid subscription (no open one may exist — the partial unique
 * index `subscriptions_one_open_per_business` also enforces this). Used by
 * the payments phase after server-side payment verification and by SaaS
 * admins granting a plan.
 */
export async function activateSubscription(
  businessId: number,
  planId: number,
  actor: Actor,
  options: { issueInvoice?: boolean } = {},
): Promise<OpenSubscription> {
  return db.transaction(async (tx) => {
    const existing = await getOpenSubscription(businessId, tx);
    if (existing) {
      throw new ConflictError(
        "This business already has an open subscription.",
      );
    }
    const plan = await requirePlan(planId);
    if (!plan.isActive) {
      throw new BadRequestError("That plan is no longer available.");
    }
    const now = new Date();
    const [created] = await tx
      .insert(subscriptions)
      .values({
        businessId,
        planId: plan.id,
        status: "active",
        startsAt: now,
        currentPeriodStart: now,
        currentPeriodEnd: addInterval(now, plan.interval),
      })
      .returning({ id: subscriptions.id });
    if (!created) {
      throw new Error("Subscription insert returned no row.");
    }
    await recordEvent(tx, {
      subscriptionId: created.id,
      eventType: "activated",
      fromStatus: null,
      toStatus: "active",
      actor,
      metadata: { planId: plan.id, planName: plan.name },
    });
    if (options.issueInvoice !== false) {
      await issueInvoice(tx, {
        businessId,
        subscriptionId: created.id,
        total: plan.price,
        currency: "BDT",
        periodStart: now,
        periodEnd: addInterval(now, plan.interval),
        dueAt: addDays(now, 7),
      });
    }
    const subscription = await getOpenSubscription(businessId, tx);
    notifySubscriptionActivated(businessId, plan.name);
    return subscription!;
  });
}

/**
 * Manual/admin renewal: rolls the period forward one plan interval, applies
 * any scheduled (pending) plan, reactivates a past-due subscription, and
 * issues the new period's invoice. Payment recording happens in the
 * payments phase — the invoice stays `pending` until then.
 */
export async function renewSubscription(
  businessId: number,
  actor: Actor,
): Promise<OpenSubscription> {
  return db.transaction(async (tx) => {
    const current = await getOpenSubscription(businessId, tx);
    if (!current) {
      throw new NotFoundError(
        "This business has no open subscription to renew.",
      );
    }

    let planId = current.planId;
    let planInterval = current.planInterval;
    let planPrice = current.planPrice;
    let planName = current.planName;
    const pendingApplied = current.pendingPlanId !== null;
    if (current.pendingPlanId) {
      const pending = await requirePlan(current.pendingPlanId);
      planId = pending.id;
      planInterval = pending.interval;
      planPrice = pending.price;
      planName = pending.name;
    }

    const now = new Date();
    // Renewing an already-lapsed period anchors the new period at now.
    const periodStart =
      current.currentPeriodEnd.getTime() > now.getTime()
        ? current.currentPeriodEnd
        : now;
    const periodEnd = addInterval(periodStart, planInterval);

    await tx
      .update(subscriptions)
      .set({
        planId,
        pendingPlanId: null,
        status: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        updatedAt: now,
      })
      .where(eq(subscriptions.id, current.id));

    const invoice = await issueInvoice(tx, {
      businessId,
      subscriptionId: current.id,
      total: planPrice,
      currency: "BDT",
      periodStart,
      periodEnd,
      dueAt: addDays(now, 7),
    });

    await recordEvent(tx, {
      subscriptionId: current.id,
      eventType: pendingApplied ? "renewed_plan_applied" : "renewed",
      fromStatus: current.status,
      toStatus: "active",
      actor,
      metadata: {
        planId,
        planName,
        periodEnd: periodEnd.toISOString(),
        invoiceId: invoice.id,
        ...(pendingApplied ? { appliedPlanId: planId } : {}),
      },
    });

    const subscription = await getOpenSubscription(businessId, tx);
    notifySubscriptionRenewed(businessId, planName, periodEnd);
    return subscription!;
  });
}

export async function suspendSubscription(
  businessId: number,
  actor: Actor,
  reason?: string,
): Promise<void> {
  return db.transaction(async (tx) => {
    const current = await getOpenSubscription(businessId, tx);
    if (!current) {
      throw new NotFoundError(
        "This business has no open subscription to suspend.",
      );
    }
    await tx
      .update(subscriptions)
      .set({ status: "suspended", suspendedAt: new Date(), updatedAt: new Date() })
      .where(eq(subscriptions.id, current.id));
    await recordEvent(tx, {
      subscriptionId: current.id,
      eventType: "suspended",
      fromStatus: current.status,
      toStatus: "suspended",
      actor,
      ...(reason !== undefined ? { metadata: { reason } } : {}),
    });
  });
}

export async function unsuspendSubscription(
  businessId: number,
  actor: Actor,
): Promise<void> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: subscriptions.id,
        status: subscriptions.status,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, businessId),
          eq(subscriptions.status, "suspended"),
        ),
      )
      .limit(1);
    if (!current) {
      throw new NotFoundError(
        "This business has no suspended subscription to reactivate.",
      );
    }
    await tx
      .update(subscriptions)
      .set({ status: "active", suspendedAt: null, updatedAt: new Date() })
      .where(eq(subscriptions.id, current.id));
    await recordEvent(tx, {
      subscriptionId: current.id,
      eventType: "unsuspended",
      fromStatus: "suspended",
      toStatus: "active",
      actor,
    });
  });
}

export interface SubscriptionEventSummary {
  id: number;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorType: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export async function getSubscriptionHistory(
  businessId: number,
): Promise<SubscriptionEventSummary[]> {
  const rows = await db
    .select({
      id: subscriptionEvents.id,
      eventType: subscriptionEvents.eventType,
      fromStatus: subscriptionEvents.fromStatus,
      toStatus: subscriptionEvents.toStatus,
      actorType: subscriptionEvents.actorType,
      metadata: subscriptionEvents.metadata,
      createdAt: subscriptionEvents.createdAt,
    })
    .from(subscriptionEvents)
    .innerJoin(
      subscriptions,
      eq(subscriptions.id, subscriptionEvents.subscriptionId),
    )
    .where(eq(subscriptions.businessId, businessId))
    .orderBy(desc(subscriptionEvents.id))
    .limit(100);
  return rows;
}

export interface InvoiceSummary {
  id: number;
  invoiceNumber: string;
  status: string;
  total: number;
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  issuedAt: Date;
  dueAt: Date | null;
  paidAt: Date | null;
}

/** Invoices for the billing portal — visible even in read-only mode. */
export async function listInvoices(
  businessId: number,
  options: { page?: number | undefined; pageSize?: number | undefined } = {},
): Promise<InvoiceSummary[]> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 25));
  return db
    .select({
      id: saasInvoices.id,
      invoiceNumber: saasInvoices.invoiceNumber,
      status: saasInvoices.status,
      total: saasInvoices.total,
      currency: saasInvoices.currency,
      periodStart: saasInvoices.periodStart,
      periodEnd: saasInvoices.periodEnd,
      issuedAt: saasInvoices.issuedAt,
      dueAt: saasInvoices.dueAt,
      paidAt: saasInvoices.paidAt,
    })
    .from(saasInvoices)
    .where(eq(saasInvoices.businessId, businessId))
    .orderBy(desc(saasInvoices.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
}

export interface InvoiceDetail extends InvoiceSummary {
  subtotal: number;
  discount: number;
  vatAmount: number;
  planName: string | null;
  subscriptionStatus: string | null;
}

export async function getInvoice(
  businessId: number,
  invoiceId: number,
): Promise<InvoiceDetail | null> {
  const [row] = await db
    .select({
      id: saasInvoices.id,
      invoiceNumber: saasInvoices.invoiceNumber,
      status: saasInvoices.status,
      total: saasInvoices.total,
      currency: saasInvoices.currency,
      subtotal: saasInvoices.subtotal,
      discount: saasInvoices.discount,
      vatAmount: saasInvoices.vatAmount,
      periodStart: saasInvoices.periodStart,
      periodEnd: saasInvoices.periodEnd,
      issuedAt: saasInvoices.issuedAt,
      dueAt: saasInvoices.dueAt,
      paidAt: saasInvoices.paidAt,
      planName: subscriptionPlans.name,
      subscriptionStatus: subscriptions.status,
    })
    .from(saasInvoices)
    .leftJoin(
      subscriptions,
      eq(subscriptions.id, saasInvoices.subscriptionId),
    )
    .leftJoin(
      subscriptionPlans,
      eq(subscriptionPlans.id, subscriptions.planId),
    )
    .where(
      and(
        eq(saasInvoices.id, invoiceId),
        eq(saasInvoices.businessId, businessId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface PaymentSummary {
  id: number;
  amount: number;
  currency: string;
  status: string;
  provider: string | null;
  providerReference: string | null;
  failureReason: string | null;
  paidAt: Date | null;
  createdAt: Date | null;
  invoiceNumber: string | null;
}

export async function listPayments(
  businessId: number,
  options: { page?: number | undefined; pageSize?: number | undefined } = {},
): Promise<PaymentSummary[]> {
  // Real gateway payment records (populated from Phase 5 onward); invoices
  // remain the billing-portal source of truth until then.
  return db
    .select({
      id: subscriptionPayments.id,
      amount: subscriptionPayments.amount,
      currency: subscriptionPayments.currency,
      status: subscriptionPayments.status,
      provider: subscriptionPayments.provider,
      providerReference: subscriptionPayments.providerReference,
      failureReason: subscriptionPayments.failureReason,
      paidAt: subscriptionPayments.paidAt,
      createdAt: subscriptionPayments.createdAt,
      invoiceNumber: saasInvoices.invoiceNumber,
    })
    .from(subscriptionPayments)
    .innerJoin(
      subscriptions,
      eq(subscriptions.id, subscriptionPayments.subscriptionId),
    )
    .leftJoin(saasInvoices, eq(saasInvoices.id, subscriptionPayments.invoiceId))
    .where(eq(subscriptions.businessId, businessId))
    .orderBy(desc(subscriptionPayments.id))
    .limit(Math.min(100, Math.max(1, options.pageSize ?? 25)))
    .offset((Math.max(1, options.page ?? 1) - 1) * Math.min(100, Math.max(1, options.pageSize ?? 25)));
}

/**
 * Admin override: extend the current period by N days without touching the
 * plan or issuing an invoice (goodwill / support adjustments).
 */
export async function extendSubscription(
  subscriptionId: number,
  days: number,
  actor: Actor,
): Promise<Date> {
  return db.transaction(async (tx) => {
    const [subscription] = await tx
      .select({
        id: subscriptions.id,
        status: subscriptions.status,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
      })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .for("update");
    if (!subscription) {
      throw new NotFoundError("Subscription not found.");
    }
    if (subscription.status === "canceled") {
      throw new BadRequestError("Cannot extend a canceled subscription.");
    }
    const newEnd = addDays(subscription.currentPeriodEnd, days);
    await tx
      .update(subscriptions)
      .set({ currentPeriodEnd: newEnd, updatedAt: new Date() })
      .where(eq(subscriptions.id, subscriptionId));
    await recordEvent(tx, {
      subscriptionId,
      eventType: "extended",
      fromStatus: subscription.status,
      toStatus: subscription.status,
      actor,
      metadata: { days, newPeriodEnd: newEnd.toISOString() },
    });
    return newEnd;
  });
}

/**
 * Admin override: grant a fresh trial to a business with NO open
 * subscription (marketing / support goodwill).
 */
export async function grantTrial(
  businessId: number,
  days: number,
  actor: Actor,
): Promise<OpenSubscription> {
  return db.transaction(async (tx) => {
    const existing = await getOpenSubscription(businessId, tx);
    if (existing) {
      throw new ConflictError(
        "This business already has an open subscription.",
      );
    }
    const [trialPlan] = await tx
      .select({ id: subscriptionPlans.id })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.slug, "free-trial"));
    if (!trialPlan) {
      throw new NotFoundError(
        'No "free-trial" plan row exists — seed it before granting trials.',
      );
    }
    const now = new Date();
    const [created] = await tx
      .insert(subscriptions)
      .values({
        businessId,
        planId: trialPlan.id,
        status: "trialing",
        startsAt: now,
        currentPeriodStart: now,
        currentPeriodEnd: addDays(now, days),
      })
      .returning({ id: subscriptions.id });
    if (!created) {
      throw new Error("Subscription insert returned no row.");
    }
    await recordEvent(tx, {
      subscriptionId: created.id,
      eventType: "trial_granted",
      fromStatus: null,
      toStatus: "trialing",
      actor,
      metadata: { days },
    });
    const subscription = await getOpenSubscription(businessId, tx);
    return subscription!;
  });
}
