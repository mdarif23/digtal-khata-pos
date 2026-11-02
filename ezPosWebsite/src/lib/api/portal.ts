"use client";

/**
 * Customer-portal API client: subscription management, billing, account
 * settings, and support tickets. Business-scoped calls carry the verified
 * membership via X-Business-Id; the backend re-checks ownership on every
 * request. Billing endpoints stay reachable in read-only mode by design.
 */
import { API_BASE, getAccessToken, SERVER_UNREACHABLE_MESSAGE } from "@/lib/api/auth";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  message: string;
  data?: T;
}

async function request<T>(
  path: string,
  init: RequestInit & { businessId?: number } = {},
): Promise<ApiResult<T>> {
  const { businessId, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Content-Type", "application/json");
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (businessId !== undefined) {
    headers.set("X-Business-Id", String(businessId));
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...rest, headers });
  } catch {
    return { ok: false, status: 0, message: SERVER_UNREACHABLE_MESSAGE };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // Three response shapes exist: `{ success, message?, data }` (most
  // endpoints), field-style payloads (`{ success, subscription, plan, ... }`
  // without a data key), and raw arrays (the public plan catalog).
  // Failure envelopes without `data` still surface the server's message.
  let data: unknown = body;
  let message: string;
  if (body && typeof body === "object" && "success" in body) {
    if ("data" in body) data = body.data;
    message =
      res.status === 0
        ? SERVER_UNREACHABLE_MESSAGE
        : ((body.message as string | undefined) ??
          (res.ok ? "Done." : "Something went wrong. Please try again."));
  } else {
    message =
      res.status === 0
        ? SERVER_UNREACHABLE_MESSAGE
        : res.ok
          ? "Done."
          : "Something went wrong. Please try again.";
  }
  return {
    ok: res.ok,
    status: res.status,
    message,
    data: (data ?? undefined) as (T & { message?: string }) | undefined,
  };
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

export interface OpenSubscription {
  id: number;
  planId: number;
  status: "trialing" | "active" | "past_due";
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  pendingPlanId: number | null;
  planName: string;
  planSlug: string;
  planPrice: number;
  planInterval: "monthly" | "yearly";
}

export interface ChangePlanOutcome {
  outcome: "upgraded" | "scheduled" | "trial_plan_changed";
  subscription: OpenSubscription;
  invoice: { id: number; invoiceNumber: string; total: number } | null;
}

export async function fetchOpenSubscription(
  businessId: number,
): Promise<ApiResult<OpenSubscription | null>> {
  return request("/api/businesses/" + businessId + "/subscription/open", {
    method: "GET",
    businessId,
  });
}

export async function changePlan(
  businessId: number,
  planId: number,
): Promise<ApiResult<ChangePlanOutcome>> {
  return request("/api/businesses/" + businessId + "/subscription/change-plan", {
    method: "POST",
    businessId,
    body: JSON.stringify({ planId }),
  });
}

export async function cancelSubscription(
  businessId: number,
  immediate = false,
): Promise<ApiResult<{ outcome: "canceled" | "cancellation_scheduled" }>> {
  return request("/api/businesses/" + businessId + "/subscription/cancel", {
    method: "POST",
    businessId,
    body: JSON.stringify({ immediate }),
  });
}

export async function reactivateSubscription(
  businessId: number,
): Promise<ApiResult<unknown>> {
  return request("/api/businesses/" + businessId + "/subscription/reactivate", {
    method: "POST",
    businessId,
  });
}

export async function renewSubscription(
  businessId: number,
): Promise<ApiResult<OpenSubscription>> {
  return request("/api/businesses/" + businessId + "/subscription/renew", {
    method: "POST",
    businessId,
  });
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export interface InvoiceSummary {
  id: number;
  invoiceNumber: string;
  status: string;
  total: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string;
  dueAt: string | null;
  paidAt: string | null;
}

export interface InvoiceDetail extends InvoiceSummary {
  subtotal: number;
  discount: number;
  vatAmount: number;
  planName: string | null;
  subscriptionStatus: string | null;
}

export interface PaymentSummary {
  id: number;
  amount: number;
  currency: string;
  status: string;
  provider: string | null;
  providerReference: string | null;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string | null;
  invoiceNumber: string | null;
}

export async function fetchInvoices(
  businessId: number,
  page = 1,
): Promise<ApiResult<InvoiceSummary[]>> {
  return request(`/api/businesses/${businessId}/invoices?page=${page}`, {
    method: "GET",
    businessId,
  });
}

export async function fetchInvoice(
  businessId: number,
  invoiceId: number,
): Promise<ApiResult<InvoiceDetail>> {
  return request(`/api/businesses/${businessId}/invoices/${invoiceId}`, {
    method: "GET",
    businessId,
  });
}

export async function fetchPayments(
  businessId: number,
  page = 1,
): Promise<ApiResult<PaymentSummary[]>> {
  return request(`/api/businesses/${businessId}/payments?page=${page}`, {
    method: "GET",
    businessId,
  });
}

// ---------------------------------------------------------------------------
// Payments (Phase 5)
// ---------------------------------------------------------------------------

export interface InitiatedPayment {
  paymentId: number;
  idempotencyKey: string;
  amount: number;
  currency: string;
  gatewayUrl: string;
}

/** Creates a gateway checkout session for a pending invoice. */
export async function initiatePayment(
  businessId: number,
  invoiceId: number,
): Promise<ApiResult<InitiatedPayment>> {
  return request("/api/businesses/" + businessId + "/payments/initiate", {
    method: "POST",
    businessId,
    body: JSON.stringify({ invoiceId }),
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
 * Server-side verification after the gateway success redirect — the
 * backend validates val_id against the gateway; the redirect itself
 * proves nothing.
 */
export async function verifyPayment(
  businessId: number,
  paymentId: number,
  valId: string,
): Promise<ApiResult<PaymentVerificationOutcome>> {
  return request(
    `/api/businesses/${businessId}/payments/${paymentId}/verify`,
    { method: "POST", businessId, body: JSON.stringify({ valId }) },
  );
}

export async function reportPaymentOutcome(
  businessId: number,
  paymentId: number,
  outcome: "failed" | "canceled",
): Promise<ApiResult<unknown>> {
  return request(
    `/api/businesses/${businessId}/payments/${paymentId}/outcome`,
    { method: "POST", businessId, body: JSON.stringify({ outcome }) },
  );
}

// ---------------------------------------------------------------------------
// Public plan catalog (for the change-plan grid)
// ---------------------------------------------------------------------------

export interface PublicPlan {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  interval: "monthly" | "yearly";
  price: number;
  currency: string;
  limits: Record<string, number> | null;
  features: Record<string, boolean> | null;
  isPopular: boolean;
  supportLevel: string | null;
}

export async function fetchPublicPlans(): Promise<ApiResult<PublicPlan[]>> {
  return request("/api/subscription-plans", { method: "GET" });
}

// ---------------------------------------------------------------------------
// Account settings
// ---------------------------------------------------------------------------

export async function updateProfile(
  input: { fullName?: string; phone?: string },
): Promise<ApiResult<unknown>> {
  return request("/api/auth/me", { method: "PATCH", body: JSON.stringify(input) });
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<ApiResult<unknown>> {
  return request("/api/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

// ---------------------------------------------------------------------------
// Support tickets
// ---------------------------------------------------------------------------

export interface TicketSummary {
  id: number;
  subject: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface TicketMessage {
  id: number;
  authorType: string;
  body: string;
  createdAt: string;
}

export interface TicketDetail {
  id: number;
  subject: string;
  status: string;
  createdAt: string;
  messages: TicketMessage[];
}

export async function fetchTickets(): Promise<ApiResult<TicketSummary[]>> {
  return request("/api/support/tickets", { method: "GET" });
}

export async function createTicket(input: {
  subject: string;
  message: string;
  businessId?: number | null;
}): Promise<ApiResult<TicketSummary>> {
  return request("/api/support/tickets", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchTicket(
  ticketId: number,
): Promise<ApiResult<TicketDetail>> {
  return request(`/api/support/tickets/${ticketId}`, { method: "GET" });
}

export async function replyToTicket(
  ticketId: number,
  body: string,
): Promise<ApiResult<TicketMessage>> {
  return request(`/api/support/tickets/${ticketId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}
