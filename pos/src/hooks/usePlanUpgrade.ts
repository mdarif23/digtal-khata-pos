import { useMemo } from "react";

/**
 * Entitlement payload from a 403 FEATURE_NOT_IN_PLAN response: the backend
 * names the plans that include the gated feature so the UI can point the
 * user at the right upgrade instead of a generic error.
 */
export interface EntitlementErrorInfo {
  code: string;
  message: string;
  upgradePlans: string[];
}

/**
 * Extracts a plan gate from any caught error (axios or raw). Returns null
 * unless the failure was a 403 FEATURE_NOT_IN_PLAN — a plan gate, not a
 * glitch, so the UI shows an upgrade card instead of an error state.
 */
export function extractEntitlementError(err: unknown): EntitlementErrorInfo | null {
  if (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    typeof (err as { response?: { status?: number } }).response?.status ===
      "number" &&
    (err as { response: { status: number } }).response.status === 403
  ) {
    const body = (
      err as {
        response: { data?: { code?: string; message?: string; upgradePlans?: string[] } };
      }
    ).response.data;
    if (body?.code === "FEATURE_NOT_IN_PLAN") {
      return {
        code: body.code,
        message:
          body.message ??
          "This feature is not part of your current plan. Upgrade to unlock it.",
        upgradePlans: Array.isArray(body.upgradePlans) ? body.upgradePlans : [],
      };
    }
  }
  return null;
}

/**
 * Shared plan-gate detector for any TanStack Query error. Generalized in the
 * Flexible Operating Model work beyond the four reports that pioneered it —
 * any feature gated by requireFeature (reports, stock transfers, storefront
 * tooling…) renders <PlanUpgradeCard gate={...}> instead of a raw 403.
 */
export function usePlanUpgradeError(error: unknown): EntitlementErrorInfo | null {
  return useMemo(() => extractEntitlementError(error), [error]);
}
