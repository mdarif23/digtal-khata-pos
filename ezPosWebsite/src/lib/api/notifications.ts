"use client";

/**
 * Portal notifications client (in-app bell).
 */
import { API_BASE, getAccessToken, SERVER_UNREACHABLE_MESSAGE } from "@/lib/api/auth";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  message: string;
  data?: T;
}

export interface PortalNotification {
  id: number;
  type: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
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
  if (body && typeof body === "object" && "success" in body) {
    if ("data" in body) data = body.data;
    message = res.ok
      ? "Done."
      : ((body.message as string | undefined) ?? "Something went wrong.");
  } else {
    message = res.ok ? "Done." : "Something went wrong.";
  }
  return {
    ok: res.ok,
    status: res.status,
    message,
    data: (data ?? undefined) as (T & { message?: string }) | undefined,
  };
}

export async function fetchNotifications(
  businessId: number,
): Promise<
  ApiResult<{
    notifications: PortalNotification[];
    unreadCount: number;
  }>
> {
  return request(`/api/businesses/${businessId}/notifications`, {
    method: "GET",
    businessId,
  });
}

export async function markAllNotificationsRead(
  businessId: number,
): Promise<ApiResult<unknown>> {
  return request(
    `/api/businesses/${businessId}/notifications/read-all`,
    { method: "POST", businessId },
  );
}

export async function markNotificationRead(
  businessId: number,
  notificationId: number,
): Promise<ApiResult<unknown>> {
  return request(
    `/api/businesses/${businessId}/notifications/${notificationId}/read`,
    { method: "POST", businessId },
  );
}
