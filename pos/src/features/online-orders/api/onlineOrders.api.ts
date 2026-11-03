import api from "@/api/axios";
import { useSessionStore } from "@/auth/sessionStore";
import type {
  DeliverInput,
  MarkPaidInput,
  OnlineOrdersFilters,
  OnlineOrdersList,
  OrdersSummary,
  OrderDetail,
  OrderFulfillmentSnapshot,
  OrderTimelineEvent,
  PackageInput,
  PackagingDefaults,
  ShipmentInput,
} from "../types/onlineOrders.types";

/** Online Order Management API (module one/two). Every endpoint is
 * business-scoped via the path; the auth/location headers are attached by
 * the axios interceptors. */

export type ApiEnvelope<T> = { success: boolean; message?: string; data: T };
type OrdersListEnvelope = { success: boolean; message?: string } & OnlineOrdersList;

function requireBusinessId(): number {
  const businessId = useSessionStore.getState().businessId;
  if (!businessId) {
    throw new Error("No active business — please select a business first.");
  }
  return businessId;
}

function toQuery(filters: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function listOrdersApi(
  filters: OnlineOrdersFilters,
): Promise<OnlineOrdersList> {
  const businessId = requireBusinessId();
  const { data } = await api.get<OrdersListEnvelope>(
    `/businesses/${businessId}/orders${toQuery({ ...filters })}`,
  );
  return {
    orders: data.orders,
    total: data.total,
    page: data.page,
    pageSize: data.pageSize,
  };
}

export async function getOrdersSummaryApi(
  filters: Pick<OnlineOrdersFilters, "channel" | "locationId" | "from" | "to">,
): Promise<OrdersSummary> {
  const businessId = requireBusinessId();
  const { data } = await api.get<ApiEnvelope<OrdersSummary>>(
    `/businesses/${businessId}/orders/summary${toQuery({ ...filters })}`,
  );
  return data.data;
}

export async function getOrderApi(orderId: number): Promise<OrderDetail> {
  const businessId = requireBusinessId();
  const { data } = await api.get<ApiEnvelope<OrderDetail>>(
    `/businesses/${businessId}/orders/${orderId}`,
  );
  return data.data;
}

export async function getOrderTimelineApi(
  orderId: number,
): Promise<OrderTimelineEvent[]> {
  const businessId = requireBusinessId();
  const { data } = await api.get<ApiEnvelope<OrderTimelineEvent[]>>(
    `/businesses/${businessId}/orders/${orderId}/timeline`,
  );
  return data.data;
}

export async function getOrderFulfillmentApi(
  orderId: number,
): Promise<OrderFulfillmentSnapshot> {
  const businessId = requireBusinessId();
  const { data } = await api.get<ApiEnvelope<OrderFulfillmentSnapshot>>(
    `/businesses/${businessId}/orders/${orderId}/fulfillment`,
  );
  return data.data;
}

export async function getPackagingDefaultsApi(
  orderId: number,
): Promise<PackagingDefaults> {
  const businessId = requireBusinessId();
  const { data } = await api.get<ApiEnvelope<PackagingDefaults>>(
    `/businesses/${businessId}/orders/${orderId}/packaging-defaults`,
  );
  return data.data;
}

async function postAction(
  orderId: number,
  action: string,
  body?: unknown,
): Promise<void> {
  const businessId = requireBusinessId();
  await api.post(
    `/businesses/${businessId}/orders/${orderId}/${action}`,
    body ?? {},
  );
}

export async function confirmOrderApi(orderId: number): Promise<void> {
  await postAction(orderId, "confirm");
}

export async function startProcessingApi(orderId: number): Promise<void> {
  await postAction(orderId, "start-processing");
}

export async function cancelOrderApi(
  orderId: number,
  reason?: string | undefined,
): Promise<void> {
  await postAction(orderId, "cancel", { reason: reason ?? null });
}

export async function readyToShipApi(orderId: number): Promise<void> {
  await postAction(orderId, "ready-to-ship");
}

export async function markOrderPaidApi(
  orderId: number,
  payload: MarkPaidInput,
): Promise<void> {
  await postAction(orderId, "mark-paid", payload);
}

export async function deliverOrderApi(
  orderId: number,
  payload: DeliverInput,
): Promise<void> {
  await postAction(orderId, "deliver", payload);
}

export async function shipOrderApi(
  orderId: number,
  payload: ShipmentInput,
): Promise<void> {
  await postAction(orderId, "ship", payload);
}

export async function updateShipmentApi(
  orderId: number,
  payload: ShipmentInput,
): Promise<void> {
  const businessId = requireBusinessId();
  await api.patch(
    `/businesses/${businessId}/orders/${orderId}/shipment`,
    payload,
  );
}

export async function addPackageApi(
  orderId: number,
  payload: PackageInput,
): Promise<void> {
  await postAction(orderId, "packages", payload);
}

export async function updatePackageApi(
  orderId: number,
  packageId: number,
  payload: PackageInput,
): Promise<void> {
  const businessId = requireBusinessId();
  await api.patch(
    `/businesses/${businessId}/orders/${orderId}/packages/${packageId}`,
    payload,
  );
}

export async function removePackageApi(
  orderId: number,
  packageId: number,
): Promise<void> {
  const businessId = requireBusinessId();
  await api.delete(
    `/businesses/${businessId}/orders/${orderId}/packages/${packageId}`,
  );
}
