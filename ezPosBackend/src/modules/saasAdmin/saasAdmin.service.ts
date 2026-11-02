import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { businesses } from "../../db/schema/businesses.js";
import { locations } from "../../db/schema/locations.js";
import { saasAdminAudit } from "../../db/schema/saasAdminAudit.js";
import { saasInvoices } from "../../db/schema/saasInvoices.js";
import { subscriptionPayments } from "../../db/schema/subscriptionPayments.js";
import { subscriptionPlans } from "../../db/schema/subscriptionPlans.js";
import { subscriptions } from "../../db/schema/subscriptions.js";
import { subscriptionEvents } from "../../db/schema/subscriptionEvents.js";
import { supportTickets } from "../../db/schema/supportTickets.js";
import { supportTicketMessages } from "../../db/schema/supportTickets.js";
import { users } from "../../db/schema/users.js";
import { NotFoundError } from "../../utils/handleError.js";
import {
  cancelSubscription,
  changePlan,
  extendSubscription,
  grantTrial,
  suspendSubscription,
  unsuspendSubscription,
} from "../subscriptions/subscription.service.js";

/**
 * SaaS-owner admin queries and actions. Every route here sits behind
 * requireAuth + requirePlatformAdmin; every mutation writes an audit row.
 *
 * Metric definitions (documented, consistent):
 * - MRR: sum over ACTIVE subscriptions of the plan price normalized to
 *   monthly (yearly/12). Trialing (free) and canceled/expired subscriptions
 *   contribute nothing. Unpaid invoices contribute nothing.
 * - ARR: MRR × 12.
 * - Collected revenue: sum of PAID subscription invoices (paid_at date).
 * - Pending revenue: sum of PENDING invoices — billed, not collected.
 * - Failed payments: count of payments in failed/verification_failed.
 * - Trial conversion: businesses with a paid invoice ÷ businesses whose
 *   trial ever started (subscription_events trial_started).
 * - Churn (30d): subscriptions canceled in the last 30 days ÷
 *   (currently active + those cancellations).
 */

type AdminActor = { adminUserId: number };

export async function audit(
  actor: AdminActor,
  action: string,
  entityType: string,
  entityId: number | null,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db.insert(saasAdminAudit).values({
    adminUserId: actor.adminUserId,
    action,
    entityType,
    entityId,
    metadata: metadata ?? null,
  });
}

// ---------------------------------------------------------------------------
// Overview metrics
// ---------------------------------------------------------------------------

export interface SaasOverview {
  businesses: number;
  customers: number;
  subscriptions: {
    active: number;
    trialing: number;
    pastDue: number;
    suspended: number;
    canceled: number;
    expired: number;
  };
  mrr: number;
  arr: number;
  revenue: {
    collected: number;
    pending: number;
    failedPayments: number;
  };
  newBusinesses30d: number;
  trialConversionPct: number | null;
  churn30dPct: number | null;
  revenueByMonth: { month: string; total: number }[];
  revenueByPlan: { plan: string; total: number }[];
}

export async function getOverview(): Promise<SaasOverview> {
  const countRows = async (query: ReturnType<typeof sql>): Promise<number> => {
    const result = await db.execute(query);
    const row = (result.rows as { n?: number }[])[0];
    return Number(row?.n ?? 0);
  };

  const [businessCount, customerCount] = await Promise.all([
    countRows(sql`SELECT count(*)::int AS n FROM businesses`),
    countRows(sql`SELECT count(*)::int AS n FROM users WHERE platform_role = 'none'`),
  ]);

  const statusRows = await db
    .select({ status: subscriptions.status, n: sql<number>`count(*)::int` })
    .from(subscriptions)
    .groupBy(subscriptions.status);
  const byStatus = (status: string): number =>
    statusRows.find((r) => r.status === status)?.n ?? 0;

  // Trialing subscriptions past their period count as expired (lazy status).
  const [expiredTrials] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "trialing"),
        sql`${subscriptions.currentPeriodEnd} < now()`,
      ),
    );

  const [mrrRow] = await db
    .select({
      mrr: sql<number>`coalesce(sum(CASE WHEN ${subscriptionPlans.interval} = 'yearly' THEN ${subscriptionPlans.price} / 12 ELSE ${subscriptionPlans.price} END), 0)::float`,
    })
    .from(subscriptions)
    .innerJoin(
      subscriptionPlans,
      eq(subscriptionPlans.id, subscriptions.planId),
    )
    .where(
      and(
        eq(subscriptions.status, "active"),
        sql`${subscriptionPlans.price} > 0`,
      ),
    );

  const [collected] = await db
    .select({ total: sql<number>`coalesce(sum(${saasInvoices.total}), 0)::float` })
    .from(saasInvoices)
    .where(eq(saasInvoices.status, "paid"));
  const [pending] = await db
    .select({
      total: sql<number>`coalesce(sum(${saasInvoices.total}), 0)::float`,
    })
    .from(saasInvoices)
    .where(eq(saasInvoices.status, "pending"));
  const [failed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(subscriptionPayments)
    .where(
      inArray(subscriptionPayments.status, ["failed", "verification_failed"]),
    );

  const [newBusinesses] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(businesses)
    .where(sql`${businesses.createdAt} > now() - interval '30 days'`);

  const [trials] = await db
    .select({ n: sql<number>`count(DISTINCT ${subscriptions.businessId})::int` })
    .from(subscriptionEvents)
    .innerJoin(
      subscriptions,
      eq(subscriptions.id, subscriptionEvents.subscriptionId),
    )
    .where(eq(subscriptionEvents.eventType, "trial_started"));
  const [converted] = await db
    .select({
      n: sql<number>`count(DISTINCT ${subscriptions.businessId})::int`,
    })
    .from(subscriptions)
    .where(
      inArray(subscriptions.status, ["active", "past_due", "canceled"]),
    );
  const trialConversionPct =
    (trials?.n ?? 0) > 0
      ? Math.round(((converted?.n ?? 0) / (trials?.n ?? 1)) * 100)
      : null;

  const [canceled30] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "canceled"),
        sql`${subscriptions.canceledAt} > now() - interval '30 days'`,
      ),
    );
  const churn30dPct =
    byStatus("active") + (canceled30?.n ?? 0) > 0
      ? Math.round(
          ((canceled30?.n ?? 0) / (byStatus("active") + (canceled30?.n ?? 0))) *
            100,
        )
      : null;

  const revenueByMonth = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${saasInvoices.paidAt}), 'YYYY-MM')`,
      total: sql<number>`sum(${saasInvoices.total})::float`,
    })
    .from(saasInvoices)
    .where(eq(saasInvoices.status, "paid"))
    .groupBy(sql`date_trunc('month', ${saasInvoices.paidAt})`)
    .orderBy(sql`date_trunc('month', ${saasInvoices.paidAt}) DESC`)
    .limit(12);

  const revenueByPlan = await db
    .select({
      plan: subscriptionPlans.name,
      total: sql<number>`sum(${saasInvoices.total})::float`,
    })
    .from(saasInvoices)
    .innerJoin(
      subscriptions,
      eq(subscriptions.id, saasInvoices.subscriptionId),
    )
    .innerJoin(
      subscriptionPlans,
      eq(subscriptionPlans.id, subscriptions.planId),
    )
    .where(eq(saasInvoices.status, "paid"))
    .groupBy(subscriptionPlans.name)
    .orderBy(sql`sum(${saasInvoices.total}) DESC`);

  return {
    businesses: businessCount,
    customers: customerCount,
    subscriptions: {
      active: byStatus("active"),
      trialing: byStatus("trialing") - (expiredTrials?.n ?? 0),
      pastDue: byStatus("past_due"),
      suspended: byStatus("suspended"),
      canceled: byStatus("canceled"),
      expired: (expiredTrials?.n ?? 0) + byStatus("expired"),
    },
    mrr: mrrRow?.mrr ?? 0,
    arr: (mrrRow?.mrr ?? 0) * 12,
    revenue: {
      collected: collected?.total ?? 0,
      pending: pending?.total ?? 0,
      failedPayments: failed?.n ?? 0,
    },
    newBusinesses30d: newBusinesses?.n ?? 0,
    trialConversionPct,
    churn30dPct,
    revenueByMonth,
    revenueByPlan,
  };
}

// ---------------------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------------------

export interface AdminBusinessSummary {
  id: number;
  name: string;
  slug: string;
  status: string;
  ownerName: string | null;
  ownerEmail: string | null;
  createdAt: Date | null;
  subscriptionStatus: string | null;
  planName: string | null;
  userCount: number;
  locationCount: number;
}

export async function listBusinesses(
  options: { search?: string | undefined; status?: string | undefined } = {},
): Promise<AdminBusinessSummary[]> {
  const search = options.search?.trim();
  const rows = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      slug: businesses.slug,
      status: businesses.status,
      createdAt: businesses.createdAt,
      ownerName: users.fullName,
      ownerEmail: users.email,
      subscriptionStatus: subscriptions.status,
      planName: subscriptionPlans.name,
      userCount: sql<number>`(SELECT count(*)::int FROM business_memberships m WHERE m.business_id = ${businesses.id})`,
      locationCount: sql<number>`(SELECT count(*)::int FROM locations l WHERE l.business_id = ${businesses.id})`,
    })
    .from(businesses)
    .leftJoin(
      users,
      eq(users.id, businesses.createdByUserId),
    )
    .leftJoin(
      subscriptions,
      and(
        eq(subscriptions.businessId, businesses.id),
        inArray(subscriptions.status, [
          "trialing",
          "active",
          "past_due",
          "suspended",
        ]),
      ),
    )
    .leftJoin(
      subscriptionPlans,
      eq(subscriptionPlans.id, subscriptions.planId),
    )
    .where(
      and(
        search
          ? or(
              ilike(businesses.name, `%${search}%`),
              ilike(users.email, `%${search}%`),
            )
          : undefined,
        options.status
          ? eq(
              businesses.status,
              options.status as "active" | "inactive" | "suspended",
            )
          : undefined,
      ),
    )
    .orderBy(desc(businesses.id))
    .limit(200);
  return rows;
}

export async function setBusinessStatus(
  businessId: number,
  status: "active" | "suspended",
  actor: AdminActor,
  reason?: string,
): Promise<void> {
  const [business] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  if (!business) {
    throw new NotFoundError("Business not found.");
  }
  await db
    .update(businesses)
    .set({ status, updatedAt: new Date() })
    .where(eq(businesses.id, businessId));
  await audit(
    actor,
    status === "suspended" ? "business_suspended" : "business_reactivated",
    "business",
    businessId,
    reason !== undefined ? { reason } : undefined,
  );
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface AdminSubscriptionSummary {
  id: number;
  businessId: number;
  businessName: string;
  status: string;
  planName: string;
  planPrice: number;
  planInterval: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  pendingPlanId: number | null;
}

export async function listSubscriptions(
  options: { status?: string | undefined } = {},
): Promise<AdminSubscriptionSummary[]> {
  return db
    .select({
      id: subscriptions.id,
      businessId: subscriptions.businessId,
      businessName: businesses.name,
      status: subscriptions.status,
      planName: subscriptionPlans.name,
      planPrice: subscriptionPlans.price,
      planInterval: subscriptionPlans.interval,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      pendingPlanId: subscriptions.pendingPlanId,
    })
    .from(subscriptions)
    .innerJoin(businesses, eq(businesses.id, subscriptions.businessId))
    .innerJoin(
      subscriptionPlans,
      eq(subscriptionPlans.id, subscriptions.planId),
    )
    .where(
      options.status
        ? eq(
            subscriptions.status,
            options.status as
              | "trialing"
              | "active"
              | "past_due"
              | "suspended"
              | "canceled"
              | "expired",
          )
        : undefined,
    )
    .orderBy(desc(subscriptions.id))
    .limit(200);
}

async function requireSubscription(subscriptionId: number) {
  const [subscription] = await db
    .select({
      id: subscriptions.id,
      businessId: subscriptions.businessId,
      status: subscriptions.status,
    })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  if (!subscription) {
    throw new NotFoundError("Subscription not found.");
  }
  return subscription;
}

export async function adminChangePlan(
  subscriptionId: number,
  planId: number,
  adminUserId: number,
) {
  const subscription = await requireSubscription(subscriptionId);
  const result = await changePlan(
    subscription.businessId,
    planId,
    { type: "admin", userId: adminUserId },
  );
  await audit(
    { adminUserId },
    "subscription_plan_changed",
    "subscription",
    subscriptionId,
    { toPlanId: planId, outcome: result.outcome },
  );
  return result;
}

export async function adminExtend(
  subscriptionId: number,
  days: number,
  adminUserId: number,
) {
  const subscription = await requireSubscription(subscriptionId);
  const newEnd = await extendSubscription(subscriptionId, days, {
    type: "admin",
    userId: adminUserId,
  });
  await audit(
    { adminUserId },
    "subscription_extended",
    "subscription",
    subscriptionId,
    { days, newPeriodEnd: newEnd.toISOString() },
  );
  return newEnd;
}

export async function adminGrantTrial(
  businessId: number,
  days: number,
  adminUserId: number,
) {
  const subscription = await grantTrial(businessId, days, {
    type: "admin",
    userId: adminUserId,
  });
  await audit(
    { adminUserId },
    "trial_granted",
    "business",
    businessId,
    { days, subscriptionId: subscription.id },
  );
  return subscription;
}

export async function adminSuspendSubscription(
  subscriptionId: number,
  adminUserId: number,
  reason?: string,
) {
  const subscription = await requireSubscription(subscriptionId);
  await suspendSubscription(subscription.businessId, {
    type: "admin",
    userId: adminUserId,
  }, reason);
  await audit(
    { adminUserId },
    "subscription_suspended",
    "subscription",
    subscriptionId,
    reason !== undefined ? { reason } : undefined,
  );
}

export async function adminUnsuspendSubscription(
  subscriptionId: number,
  adminUserId: number,
) {
  const subscription = await requireSubscription(subscriptionId);
  await unsuspendSubscription(subscription.businessId, {
    type: "admin",
    userId: adminUserId,
  });
  await audit(
    { adminUserId },
    "subscription_unsuspended",
    "subscription",
    subscriptionId,
  );
}

export async function adminCancelSubscription(
  subscriptionId: number,
  adminUserId: number,
) {
  const subscription = await requireSubscription(subscriptionId);
  await cancelSubscription(subscription.businessId, {
    type: "admin",
    userId: adminUserId,
  }, { immediate: true });
  await audit(
    { adminUserId },
    "subscription_canceled",
    "subscription",
    subscriptionId,
  );
}

// ---------------------------------------------------------------------------
// Payments & invoices
// ---------------------------------------------------------------------------

export async function listAllPayments(
  options: { status?: string | undefined; provider?: string | undefined } = {},
) {
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
      businessName: businesses.name,
    })
    .from(subscriptionPayments)
    .innerJoin(
      subscriptions,
      eq(subscriptions.id, subscriptionPayments.subscriptionId),
    )
    .innerJoin(businesses, eq(businesses.id, subscriptions.businessId))
    .leftJoin(saasInvoices, eq(saasInvoices.id, subscriptionPayments.invoiceId))
    .where(
      and(
        options.status
          ? eq(subscriptionPayments.status, options.status)
          : undefined,
        options.provider
          ? eq(subscriptionPayments.provider, options.provider)
          : undefined,
      ),
    )
    .orderBy(desc(subscriptionPayments.id))
    .limit(200);
}

export async function listAllInvoices() {
  return db
    .select({
      id: saasInvoices.id,
      invoiceNumber: saasInvoices.invoiceNumber,
      status: saasInvoices.status,
      total: saasInvoices.total,
      currency: saasInvoices.currency,
      issuedAt: saasInvoices.issuedAt,
      paidAt: saasInvoices.paidAt,
      businessName: businesses.name,
    })
    .from(saasInvoices)
    .innerJoin(businesses, eq(businesses.id, saasInvoices.businessId))
    .orderBy(desc(saasInvoices.id))
    .limit(200);
}

// ---------------------------------------------------------------------------
// Support (admin side)
// ---------------------------------------------------------------------------

export async function listAllTickets(options: { status?: string | undefined } = {}) {
  return db
    .select({
      id: supportTickets.id,
      subject: supportTickets.subject,
      status: supportTickets.status,
      source: supportTickets.source,
      name: supportTickets.name,
      email: supportTickets.email,
      createdAt: supportTickets.createdAt,
      updatedAt: supportTickets.updatedAt,
      messageCount: sql<number>`(SELECT count(*)::int FROM support_ticket_messages m WHERE m.ticket_id = ${supportTickets.id})`,
    })
    .from(supportTickets)
    .where(
      options.status
        ? eq(
            supportTickets.status,
            options.status as "open" | "pending" | "resolved" | "closed",
          )
        : undefined,
    )
    .orderBy(desc(supportTickets.updatedAt))
    .limit(200);
}

export async function getTicketAdmin(ticketId: number) {
  const [ticket] = await db
    .select({
      id: supportTickets.id,
      subject: supportTickets.subject,
      status: supportTickets.status,
      name: supportTickets.name,
      email: supportTickets.email,
      source: supportTickets.source,
      createdAt: supportTickets.createdAt,
    })
    .from(supportTickets)
    .where(eq(supportTickets.id, ticketId));
  if (!ticket) {
    throw new NotFoundError("Ticket not found.");
  }
  const messages = await db
    .select({
      id: supportTicketMessages.id,
      authorType: supportTicketMessages.authorType,
      body: supportTicketMessages.body,
      createdAt: supportTicketMessages.createdAt,
    })
    .from(supportTicketMessages)
    .where(eq(supportTicketMessages.ticketId, ticketId))
    .orderBy(supportTicketMessages.id);
  return { ...ticket, messages };
}

export async function adminReplyToTicket(
  ticketId: number,
  adminUserId: number,
  body: string,
) {
  const [ticket] = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(eq(supportTickets.id, ticketId));
  if (!ticket) {
    throw new NotFoundError("Ticket not found.");
  }
  const [message] = await db
    .insert(supportTicketMessages)
    .values({
      ticketId,
      authorType: "admin",
      authorUserId: adminUserId,
      body,
    })
    .returning({
      id: supportTicketMessages.id,
      authorType: supportTicketMessages.authorType,
      body: supportTicketMessages.body,
      createdAt: supportTicketMessages.createdAt,
    });
  if (!message) {
    throw new Error("Ticket message insert returned no row.");
  }
  await db
    .update(supportTickets)
    .set({ status: "pending", updatedAt: new Date() })
    .where(eq(supportTickets.id, ticketId));
  await audit({ adminUserId }, "support_ticket_replied", "ticket", ticketId);
  return message;
}

export async function setTicketStatus(
  ticketId: number,
  status: "open" | "pending" | "resolved" | "closed",
  adminUserId: number,
) {
  const [ticket] = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(eq(supportTickets.id, ticketId));
  if (!ticket) {
    throw new NotFoundError("Ticket not found.");
  }
  await db
    .update(supportTickets)
    .set({ status, updatedAt: new Date() })
    .where(eq(supportTickets.id, ticketId));
  await audit(
    { adminUserId },
    "support_ticket_status_changed",
    "ticket",
    ticketId,
    { status },
  );
}
