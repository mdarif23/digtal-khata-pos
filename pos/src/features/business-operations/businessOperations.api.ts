import axios from "axios";
import api from "@/api/axios";
import type { BusinessMode } from "@/auth/sessionStore";

export interface BusinessOperationsSummary {
  mode: BusinessMode;
  subscription: {
    status: string;
    accessMode: string;
    trial: boolean;
  };
  counts: {
    activeLocations: number;
    activeRegisters: number;
    connectedChannels: number;
    hostedStorefronts: number;
    activeStaff: number;
    products: number;
  };
  readiness: {
    stockSourceReady: boolean;
    registerReady: boolean;
    onlineChannelConnected: boolean;
    hostedStorefrontCreated: boolean;
    catalogReady: boolean;
  };
}

/** Best-effort human-readable message from an axios error. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { message?: string } | undefined;
    if (data?.message) return data.message;
  }
  return fallback;
}

export async function fetchBusinessOperations(
  businessId: number,
): Promise<BusinessOperationsSummary> {
  const { data } = await api.get<{
    success: boolean;
    operations: BusinessOperationsSummary;
  }>(`/businesses/${businessId}/operations`);
  return data.operations;
}

/**
 * Switches the operating model. Deliberately works even in read-only
 * subscription mode (the backend route omits requireFullAccess) — the mode
 * is configuration, not data.
 */
export async function changeBusinessMode(
  businessId: number,
  mode: BusinessMode,
): Promise<void> {
  await api.patch(`/businesses/${businessId}/mode`, { mode });
}
