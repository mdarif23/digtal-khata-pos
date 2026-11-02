"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/auth-provider";
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

export interface UnifiedOrder {
  id: number;
  invoiceNumber: string;
  channel: "pos" | "woocommerce" | "custom_storefront";
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  finalTotal: number | null;
  externalOrderNumber: string | null;
  customerName: string | null;
  locationName: string | null;
  createdAt: string | null;
}

export interface OrderDetail {
  id: number;
  invoiceNumber: string;
  channel: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  subtotal: number | null;
  discount: number | null;
  vat: number | null;
  finalTotal: number | null;
  dueAmount: number | null;
  note: string | null;
  externalOrderNumber: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  locationName: string | null;
  createdAt: string | null;
  items: {
    id: number;
    sku: string;
    productName: string;
    quantity: number;
    sellingPrice: number;
    lineTotal: number;
  }[];
}

export async function fetchOrders(
  businessId: number,
  filters: { channel?: string; status?: string; page?: number },
): Promise<ApiResult<{ orders: UnifiedOrder[]; total: number }>> {
  const params = new URLSearchParams();
  if (filters.channel) params.set("channel", filters.channel);
  if (filters.status) params.set("status", filters.status);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  return request(`/api/businesses/${businessId}/orders?${params}`, {
    method: "GET",
    businessId,
  });
}

export async function fetchOrderDetail(
  businessId: number,
  orderId: number,
): Promise<ApiResult<OrderDetail>> {
  return request(`/api/businesses/${businessId}/orders/${orderId}`, {
    method: "GET",
    businessId,
  });
}

export async function setFulfillmentStatus(
  businessId: number,
  orderId: number,
  status: "processing" | "shipped" | "delivered",
): Promise<ApiResult<unknown>> {
  return request(
    `/api/businesses/${businessId}/orders/${orderId}/fulfillment`,
    { method: "POST", businessId, body: JSON.stringify({ status }) },
  );
}

export async function markOrderPaid(
  businessId: number,
  orderId: number,
): Promise<ApiResult<unknown>> {
  return request(`/api/businesses/${businessId}/orders/${orderId}/mark-paid`, {
    method: "POST",
    businessId,
  });
}
