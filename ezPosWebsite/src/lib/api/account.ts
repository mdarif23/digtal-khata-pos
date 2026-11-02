"use client";

/**
 * Account- and business-scoped API calls for the customer portal and
 * onboarding. Business-scoped requests carry the X-Business-Id header —
 * the backend treats it as a selector and verifies membership server-side.
 */
import { API_BASE, getAccessToken, SERVER_UNREACHABLE_MESSAGE } from "@/lib/api/auth";

interface ApiResult<T> {
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
    return {
      ok: false,
      status: 0,
      message: SERVER_UNREACHABLE_MESSAGE,
    };
  }
  const body = (await res.json().catch(() => null)) as
    | (T & { success?: boolean; message?: string })
    | null;
  const message =
    res.status === 0
      ? SERVER_UNREACHABLE_MESSAGE
      : (body?.message ??
        (res.ok ? "Done." : "Something went wrong. Please try again."));
  return { ok: res.ok, status: res.status, message, data: body ?? undefined };
}

export interface UpdateBusinessInput {
  name?: string;
  phone?: string;
  address?: string;
  businessType?: string;
  country?: string;
  currency?: string;
  timezone?: string;
}

export async function updateBusiness(
  businessId: number,
  input: UpdateBusinessInput,
): Promise<ApiResult<unknown>> {
  return request(`/api/businesses/${businessId}`, {
    method: "PUT",
    businessId,
    body: JSON.stringify(input),
  });
}

export async function createLocation(
  businessId: number,
  input: { name: string; address?: string },
): Promise<ApiResult<{ id: number }>> {
  return request("/api/locations", {
    method: "POST",
    businessId,
    body: JSON.stringify(input),
  });
}

export interface SubscriptionPayload {
  subscription: {
    status: string;
    accessMode: "full" | "read_only";
    trial: boolean;
    currentPeriodEnd: string | null;
    graceEndsAt?: string | null;
  };
  plan: {
    id: number;
    name: string;
    slug: string;
    limits: Record<string, number> | null;
    features: Record<string, boolean> | null;
  } | null;
  usage: { users: number; locations: number; products: number };
  events?: {
    id: number;
    eventType: string;
    fromStatus: string | null;
    toStatus: string | null;
    actorType: string;
    createdAt: string;
  }[];
}

export async function fetchSubscription(
  businessId: number,
): Promise<ApiResult<SubscriptionPayload>> {
  return request<SubscriptionPayload>(
    `/api/businesses/${businessId}/subscription`,
    { method: "GET", businessId },
  );
}

export async function resendVerificationEmail(): Promise<ApiResult<unknown>> {
  return request("/api/auth/resend-verification", { method: "POST" });
}

export async function verifyEmailToken(
  token: string,
): Promise<ApiResult<unknown>> {
  return request(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, {
    method: "GET",
  });
}

export async function forgotPassword(
  email: string,
): Promise<ApiResult<unknown>> {
  return request("/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function resetPassword(
  token: string,
  password: string,
): Promise<ApiResult<unknown>> {
  return request("/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}
