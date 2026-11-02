"use client";

/**
 * SaaS-admin API client. Every call requires a platform-admin token; the
 * backend re-verifies the role on every request.
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
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    return { ok: false, status: 0, message: SERVER_UNREACHABLE_MESSAGE };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // Unwrap `{ success, message?, data }` envelopes; field-style and raw-array
  // payloads pass through unchanged.
  let data: unknown = body;
  let message: string;
  if (body && typeof body === "object" && "success" in body && "data" in body) {
    data = body.data;
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
  revenue: { collected: number; pending: number; failedPayments: number };
  newBusinesses30d: number;
  trialConversionPct: number | null;
  churn30dPct: number | null;
  revenueByMonth: { month: string; total: number }[];
  revenueByPlan: { plan: string; total: number }[];
}

export interface AdminBusiness {
  id: number;
  name: string;
  slug: string;
  status: string;
  ownerName: string | null;
  ownerEmail: string | null;
  createdAt: string | null;
  subscriptionStatus: string | null;
  planName: string | null;
  userCount: number;
  locationCount: number;
}

export interface AdminSubscription {
  id: number;
  businessId: number;
  businessName: string;
  status: string;
  planName: string;
  planPrice: number;
  planInterval: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  pendingPlanId: number | null;
}

export interface AdminPayment {
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
  businessName: string;
}

export interface AdminInvoice {
  id: number;
  invoiceNumber: string;
  status: string;
  total: number;
  currency: string;
  issuedAt: string;
  paidAt: string | null;
  businessName: string;
}

export interface AdminTicket {
  id: number;
  subject: string;
  status: string;
  source: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface AdminTicketDetail {
  id: number;
  subject: string;
  status: string;
  name: string;
  email: string;
  source: string;
  createdAt: string;
  messages: { id: number; authorType: string; body: string; createdAt: string }[];
}

export async function fetchOverview(): Promise<ApiResult<SaasOverview>> {
  return request("/api/saas/overview", { method: "GET" });
}

export async function fetchBusinesses(params?: {
  search?: string;
}): Promise<ApiResult<AdminBusiness[]>> {
  const qs = params?.search ? `?search=${encodeURIComponent(params.search)}` : "";
  return request(`/api/saas/businesses${qs}`, { method: "GET" });
}

export async function setBusinessStatus(
  businessId: number,
  status: "active" | "suspended",
  reason?: string,
): Promise<ApiResult<unknown>> {
  return request(`/api/saas/businesses/${businessId}/status`, {
    method: "POST",
    body: JSON.stringify({ status, reason }),
  });
}

export async function fetchSubscriptions(params?: {
  status?: string;
}): Promise<ApiResult<AdminSubscription[]>> {
  const qs = params?.status ? `?status=${encodeURIComponent(params.status)}` : "";
  return request(`/api/saas/subscriptions${qs}`, { method: "GET" });
}

export async function adminChangePlan(
  subscriptionId: number,
  planId: number,
): Promise<ApiResult<unknown>> {
  return request(`/api/saas/subscriptions/${subscriptionId}/change-plan`, {
    method: "POST",
    body: JSON.stringify({ planId }),
  });
}

export async function adminExtend(
  subscriptionId: number,
  days: number,
): Promise<ApiResult<unknown>> {
  return request(`/api/saas/subscriptions/${subscriptionId}/extend`, {
    method: "POST",
    body: JSON.stringify({ days }),
  });
}

export async function adminGrantTrial(
  businessId: number,
  days: number,
): Promise<ApiResult<unknown>> {
  return request(`/api/saas/businesses/${businessId}/grant-trial`, {
    method: "POST",
    body: JSON.stringify({ days }),
  });
}

export async function adminSubscriptionAction(
  subscriptionId: number,
  action: "suspend" | "reactivate" | "cancel",
  reason?: string,
): Promise<ApiResult<unknown>> {
  return request(`/api/saas/subscriptions/${subscriptionId}/${action}`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export async function fetchAdminPayments(params?: {
  status?: string;
}): Promise<ApiResult<AdminPayment[]>> {
  const qs = params?.status ? `?status=${encodeURIComponent(params.status)}` : "";
  return request(`/api/saas/payments${qs}`, { method: "GET" });
}

export async function fetchAdminInvoices(): Promise<ApiResult<AdminInvoice[]>> {
  return request("/api/saas/invoices", { method: "GET" });
}

export async function fetchAdminTickets(params?: {
  status?: string;
}): Promise<ApiResult<AdminTicket[]>> {
  const qs = params?.status ? `?status=${encodeURIComponent(params.status)}` : "";
  return request(`/api/saas/support/tickets${qs}`, { method: "GET" });
}

export async function fetchAdminTicket(
  ticketId: number,
): Promise<ApiResult<AdminTicketDetail>> {
  return request(`/api/saas/support/tickets/${ticketId}`, { method: "GET" });
}

export async function adminReplyTicket(
  ticketId: number,
  body: string,
): Promise<ApiResult<unknown>> {
  return request(`/api/saas/support/tickets/${ticketId}/reply`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function adminSetTicketStatus(
  ticketId: number,
  status: "open" | "pending" | "resolved" | "closed",
): Promise<ApiResult<unknown>> {
  return request(`/api/saas/support/tickets/${ticketId}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

// Plan management reuses the Phase 2 endpoints.
export interface AdminPlan {
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
  isActive: boolean;
  sortOrder: number;
}

export async function fetchAllPlans(): Promise<ApiResult<AdminPlan[]>> {
  return request("/api/saas/plans", { method: "GET" });
}

export async function createPlan(input: {
  name: string;
  interval: "monthly" | "yearly";
  price: number;
  description?: string;
}): Promise<ApiResult<AdminPlan>> {
  return request("/api/saas/plans", { method: "POST", body: JSON.stringify(input) });
}

export interface PlanLimits {
  maxUsers?: number;
  maxLocations?: number;
  maxProducts?: number;
  maxConnectedStores?: number;
  maxWebhookEndpoints?: number;
}

export interface PlanFeatures {
  multiLocation?: boolean;
  advancedReports?: boolean;
  exports?: boolean;
  purchaseManagement?: boolean;
  storefrontApi?: boolean;
  woocommerceIntegration?: boolean;
  customStorefront?: boolean;
  multipleOnlineStores?: boolean;
  advancedWebhooks?: boolean;
}

export async function updatePlan(
  planId: number,
  input: {
    price?: number;
    isActive?: boolean;
    isPopular?: boolean;
    description?: string;
    limits?: PlanLimits;
    features?: PlanFeatures;
  },
): Promise<ApiResult<AdminPlan>> {
  return request(`/api/saas/plans/${planId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
