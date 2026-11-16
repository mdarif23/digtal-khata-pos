import { getErrorMessage } from "@/utils/getErrorMessage";
import { useState, useEffect, useCallback, useRef } from "react";
import type { AxiosResponse } from "axios";
import {
  extractEntitlementError,
  type EntitlementErrorInfo,
} from "@/hooks/usePlanUpgrade";

/** Shared plan-gate payload — defined once in hooks/usePlanUpgrade. */
export type { EntitlementErrorInfo };

interface UseReportDataResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Set when the failure was a 403 FEATURE_NOT_IN_PLAN gate, not a glitch. */
  entitlementError: EntitlementErrorInfo | null;
  refetch: () => void;
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
      setError(getErrorMessage(err));
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
