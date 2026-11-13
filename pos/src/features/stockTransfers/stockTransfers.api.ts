import api from "../../api/axios.js";
import { buildVariantName } from "@/lib/variantDisplay";

export type TransferStatus =
  | "draft"
  | "shipped"
  | "partially_received"
  | "received"
  | "cancelled";

export interface TransferItem {
  id: number;
  variantId: number;
  sku: string | null;
  productName: string | null;
  variantOptions?: string | null | undefined;
  variantName?: string | null | undefined;
  quantity: number;
  quantityShipped: number;
  quantityReceived: number;
  unitCost: number;
}

export interface TransferDiscrepancyRow {
  id: number;
  itemId: number;
  shippedQty: number;
  receivedQty: number;
  difference: number;
  reason: string | null;
  createdAt: string;
}

export interface TransferDetail {
  id: number;
  transferNumber: string;
  fromLocationId: number;
  fromLocationName: string;
  toLocationId: number;
  toLocationName: string;
  status: TransferStatus;
  notes: string | null;
  shippedAt: string | null;
  receivedAt: string | null;
  /** Phase 4: authorization snapshot (ship auto-authorizes when skipped). */
  authorizedBy: number | null;
  authorizedAt: string | null;
  createdAt: string | null;
  items: TransferItem[];
  /** Phase 4: recorded receive-time shortfalls. */
  discrepancies?: TransferDiscrepancyRow[];
}

export interface TransferListItem {
  id: number;
  transferNumber: string;
  fromLocationId: number;
  fromLocationName: string;
  toLocationId: number;
  toLocationName: string;
  status: TransferStatus;
  itemCount: number;
  totalQuantity: number;
  createdAt: string | null;
  shippedAt: string | null;
  receivedAt: string | null;
}

export async function getTransfersApi(): Promise<TransferListItem[]> {
  const res = await api.get<{ success: boolean; data: TransferListItem[] }>(
    "/stock-transfers",
  );
  return res.data.data;
}

export async function getTransferApi(id: number): Promise<TransferDetail> {
  const res = await api.get<{ success: boolean; data: TransferDetail }>(
    `/stock-transfers/${id}`,
  );
  return res.data.data;
}

export async function createTransferApi(input: {
  fromLocationId: number;
  toLocationId: number;
  notes?: string | undefined;
  items: { variantId: number; quantity: number }[];
}): Promise<TransferDetail> {
  const res = await api.post<{ success: boolean; data: TransferDetail }>(
    "/stock-transfers",
    input,
  );
  return res.data.data;
}

export async function authorizeTransferApi(id: number): Promise<TransferDetail> {
  const res = await api.post<{ success: boolean; data: TransferDetail }>(
    `/stock-transfers/${id}/authorize`,
  );
  return res.data.data;
}

export async function shipTransferApi(id: number): Promise<TransferDetail> {
  const res = await api.post<{ success: boolean; data: TransferDetail }>(
    `/stock-transfers/${id}/ship`,
  );
  return res.data.data;
}

export async function receiveTransferApi(
  id: number,
  items?: { itemId: number; quantity: number }[],
  opts?: {
    reasons?: Record<string, string>;
    forceComplete?: boolean;
  },
): Promise<TransferDetail> {
  const res = await api.post<{ success: boolean; data: TransferDetail }>(
    `/stock-transfers/${id}/receive`,
    {
      ...(items === undefined ? {} : { items }),
      ...(opts?.reasons ? { reasons: opts.reasons } : {}),
      ...(opts?.forceComplete ? { forceComplete: true } : {}),
    },
  );
  return res.data.data;
}

export async function cancelTransferApi(id: number): Promise<TransferDetail> {
  const res = await api.post<{ success: boolean; data: TransferDetail }>(
    `/stock-transfers/${id}/cancel`,
  );
  return res.data.data;
}

/** Product variants for the item picker (catalog is business-wide). */
export interface VariantOption {
  variantId: number;
  label: string;
  sku: string | null;
}

export async function getVariantOptionsApi(): Promise<VariantOption[]> {
  const res = await api.get<
    {
      id: number;
      name: string;
      variants: {
        id: number;
        sku: string | null;
        options?: { typeName: string; value: string }[] | null;
      }[];
    }[]
  >("/products");
  const options: VariantOption[] = [];
  for (const product of res.data) {
    for (const variant of product.variants ?? []) {
      options.push({
        variantId: variant.id,
        label: buildVariantName(product.name, variant.options),
        sku: variant.sku,
      });
    }
  }
  return options;
}
