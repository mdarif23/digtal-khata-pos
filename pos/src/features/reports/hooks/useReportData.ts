import { useState, useEffect, useCallback, useRef } from "react";
import type { AxiosResponse } from "axios";

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

interface UseReportDataResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Set when the failure was a 403 FEATURE_NOT_IN_PLAN gate, not a glitch. */
  entitlementError: EntitlementErrorInfo | null;
  refetch: () => void;
}

function extractEntitlementError(err: unknown): EntitlementErrorInfo | null {
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

export function useReportData<T>(
  fetcher: () => Promise<AxiosResponse<{ success: boolean; data: T }>>,
  deps: unknown[] = []
): UseReportDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entitlementError, setEntitlementError] =
    useState<EntitlementErrorInfo | null>(null);
  const requestId = useRef(0);

  const fetch = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setEntitlementError(null);
    try {
      const response = await fetcher();
      if (requestId.current !== id) return;
      setData(response.data.data);
    } catch (err: unknown) {
      if (requestId.current !== id) return;
      const gate = extractEntitlementError(err);
      if (gate) setEntitlementError(gate);
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load report data from server"
      );
    } finally {
      if (requestId.current === id) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { data, loading, error, entitlementError, refetch: fetch };
}
