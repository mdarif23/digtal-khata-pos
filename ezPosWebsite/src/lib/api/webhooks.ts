"use client";

/**
 * Customer-portal client for outbound webhook management (Phase 9.4).
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
  let data: unknown = body;
  let message: string;
  if (body && typeof body === "object" && "success" in body && "data" in body) {
    data = body.data;
    message =
      res.status === 0
        ? SERVER_UNREACHABLE_MESSAGE
        : ((body.message as string | undefined) ??
          (res.ok ? "Done." : "Something went wrong."));
  } else {
    message =
      res.status === 0
        ? SERVER_UNREACHABLE_MESSAGE
        : ((body?.message as string | undefined) ??
          (res.ok ? "Done." : "Something went wrong."));
  }
  return {
    ok: res.ok,
    status: res.status,
    message,
    // Never hand an error envelope back as data: gated endpoints (403) and
    // other failures omit the data key, so 'data' would otherwise be the
    // whole { success, message } object — which crashed .map() calls in the
    // UI. Failures carry NO data; the message above explains why.
    data: (res.ok ? (data ?? undefined) : undefined) as (T & { message?: string }) | undefined,
  };
}

export interface WebhookEndpoint {
  id: number;
  url: string;
  events: string[];
  status: string;
  createdAt: string;
}

export interface WebhookDelivery {
  id: number;
  event: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: string;
}

export async function fetchWebhookEndpoints(
  businessId: number,
): Promise<ApiResult<WebhookEndpoint[]>> {
  return request(`/api/businesses/${businessId}/webhooks`, {
    method: "GET",
    businessId,
  });
}

export async function createWebhookEndpoint(
  businessId: number,
  input: { url: string; events: string[] },
): Promise<ApiResult<{ id: number; secret: string }>> {
  return request(`/api/businesses/${businessId}/webhooks`, {
    method: "POST",
    businessId,
    body: JSON.stringify(input),
  });
}

export async function deleteWebhookEndpoint(
  businessId: number,
  endpointId: number,
): Promise<ApiResult<unknown>> {
  return request(`/api/businesses/${businessId}/webhooks/${endpointId}`, {
    method: "DELETE",
    businessId,
  });
}

export async function fetchWebhookDeliveries(
  businessId: number,
  endpointId: number,
): Promise<ApiResult<WebhookDelivery[]>> {
  return request(
    `/api/businesses/${businessId}/webhooks/${endpointId}/deliveries`,
    { method: "GET", businessId },
  );
}

export async function testWebhookEndpoint(
  businessId: number,
  endpointId: number,
): Promise<ApiResult<unknown>> {
  return request(`/api/businesses/${businessId}/webhooks/${endpointId}/test`, {
    method: "POST",
    businessId,
  });
}
