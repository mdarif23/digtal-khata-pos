import api from "../../../api/axios.js";

export interface CfdDisplayRow {
  id: number;
  name: string;
  status: "active" | "revoked";
  lastSeenAt: string | null;
  payloadUpdatedAt: string | null;
  createdAt: string;
}

export interface CfdPushPayload {
  status: "idle" | "cart" | "paid";
  items: {
    name: string;
    variantName: string | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
  discountTotal: number;
  vatTotal: number;
  grandTotal: number;
  paidTotal: number;
  dueTotal: number;
}

export async function pairCfdApi(): Promise<{ code: string; expiresAt: string }> {
  const res = await api.post<{ success: boolean; data: { code: string; expiresAt: string } }>(
    "/cfd/pair",
  );
  return res.data.data;
}

export async function listDisplaysApi(): Promise<CfdDisplayRow[]> {
  const res = await api.get<{ success: boolean; data: CfdDisplayRow[] }>(
    "/cfd/displays",
  );
  return res.data.data;
}

export async function revokeDisplayApi(displayId: number): Promise<void> {
  await api.post(`/cfd/displays/${displayId}/revoke`);
}

export async function pushCfdPayloadApi(
  displayId: number,
  payload: CfdPushPayload,
): Promise<{ delivered: boolean }> {
  const res = await api.post<{ success: boolean; data: { delivered: boolean } }>(
    "/cfd/push",
    { displayId, ...payload },
  );
  return res.data.data;
}

/** Display-side (no auth): claim a pairing code → one-time token. */
export async function claimCfdApi(
  code: string,
  name: string,
): Promise<{ displayId: number; token: string; businessId: number }> {
  const res = await api.post<{
    success: boolean;
    data: { displayId: number; token: string; businessId: number };
  }>("/cfd/claim", { code, name });
  return res.data.data;
}
