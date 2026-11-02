"use client";

/**
 * Customer-portal client for WooCommerce integrations (Phase 9.3).
 * Credentials are write-only — no endpoint ever returns them.
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
        : res.ok
          ? "Done."
          : "Something went wrong.";
  }
  return {
    ok: res.ok,
    status: res.status,
    message,
    data: (data ?? undefined) as (T & { message?: string }) | undefined,
  };
}

export interface Integration {
  id: number;
  platform: string;
  name: string;
  storeUrl: string | null;
  status: string;
  lastSyncAt: string | null;
  createdAt: string;
}

export interface SyncLog {
  id: number;
  jobType: string;
  direction: string;
  entityType: string | null;
  entityId: number | null;
  status: string;
  message: string | null;
  createdAt: string;
}

export async function fetchIntegrations(
  businessId: number,
): Promise<ApiResult<Integration[]>> {
  return request(`/api/businesses/${businessId}/integrations`, {
    method: "GET",
    businessId,
  });
}

export async function connectWoocommerce(
  businessId: number,
  input: {
    name: string;
    storeUrl: string;
    consumerKey: string;
    consumerSecret: string;
  },
): Promise<ApiResult<{ integrationId: number }>> {
  return request(
    `/api/businesses/${businessId}/integrations/woocommerce/connect`,
    { method: "POST", businessId, body: JSON.stringify(input) },
  );
}

export async function disconnectIntegration(
  businessId: number,
  integrationId: number,
): Promise<ApiResult<unknown>> {
  return request(
    `/api/businesses/${businessId}/integrations/${integrationId}/disconnect`,
    { method: "POST", businessId },
  );
}

export async function syncProducts(
  businessId: number,
  integrationId: number,
): Promise<ApiResult<{ pushed: number }>> {
  return request(
    `/api/businesses/${businessId}/integrations/${integrationId}/sync-products`,
    { method: "POST", businessId },
  );
}

export async function syncStock(
  businessId: number,
  integrationId: number,
): Promise<ApiResult<{ pushed: number }>> {
  return request(
    `/api/businesses/${businessId}/integrations/${integrationId}/sync-stock`,
    { method: "POST", businessId },
  );
}

export async function fetchSyncLogs(
  businessId: number,
  integrationId: number,
): Promise<ApiResult<SyncLog[]>> {
  return request(
    `/api/businesses/${businessId}/integrations/${integrationId}/logs`,
    { method: "GET", businessId },
  );
}

// ---------------------------------------------------------------------------
// Storefront API keys (Phase 9.2 backend; UI added here)
// ---------------------------------------------------------------------------

export interface StorefrontKey {
  id: number;
  name: string;
  publishableKey: string;
  scopes: string[];
  environment: string;
  requestCount: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export async function fetchStorefrontKeys(
  businessId: number,
): Promise<ApiResult<StorefrontKey[]>> {
  return request(`/api/businesses/${businessId}/storefront/keys`, {
    method: "GET",
    businessId,
  });
}

export async function createStorefrontKey(
  businessId: number,
  input: { name: string; scopes: string[] },
): Promise<ApiResult<{ id: number; publishableKey: string; secretKey: string }>> {
  return request(`/api/businesses/${businessId}/storefront/keys`, {
    method: "POST",
    businessId,
    body: JSON.stringify(input),
  });
}

export async function revokeStorefrontKey(
  businessId: number,
  keyId: number,
): Promise<ApiResult<unknown>> {
  return request(
    `/api/businesses/${businessId}/storefront/keys/${keyId}/revoke`,
    { method: "POST", businessId },
  );
}
