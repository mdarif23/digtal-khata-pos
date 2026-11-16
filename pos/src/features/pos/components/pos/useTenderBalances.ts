import { useEffect, useState } from "react";
import axios from "../../../../api/axios.js";
import {
  EMPTY_TENDER,
  type LoyaltyPosConfig,
  type TenderBalances,
} from "./paymentHelpers.js";

/** Balance-tender data for the selected customer (fetched while open). */
export function useTenderBalances(
  customerId: number | null,
  open: boolean,
): TenderBalances {
  const [tender, setTender] = useState<TenderBalances>(EMPTY_TENDER);

  useEffect(() => {
    if (!open || customerId == null || customerId <= 0) {
      setTender(EMPTY_TENDER);
      return;
    }
    let ignore = false;
    const apply = (patch: Partial<TenderBalances>) =>
      setTender((current) => ({ ...current, ...patch }));
    // Balance unknown while loading — the Confirm button stays disabled
    // until the real numbers arrive (never guess a balance).
    axios
      .get(`/customers/${customerId}/store-credit`)
      .then((res) => {
        if (!ignore)
          apply({ storeCredit: Number(res.data?.data?.balance ?? 0) });
      })
      .catch(() => {
        if (!ignore) apply({ storeCredit: null });
      });
    axios
      .get(`/customers/${customerId}/loyalty`)
      .then((res) => {
        if (!ignore)
          apply({ loyaltyBalance: Number(res.data?.data?.balance ?? 0) });
      })
      .catch(() => {
        if (!ignore) apply({ loyaltyBalance: null });
      });
    axios
      .get("/loyalty/config")
      .then((res) => {
        if (!ignore) apply({ loyaltyConfig: res.data?.data ?? null });
      })
      .catch(() => {
        if (!ignore) apply({ loyaltyConfig: null });
      });
    // P3 Phase 1 (F2): credit-limit context for the due tender (display only
    // — the backend re-checks authoritatively inside the sale transaction).
    axios
      .get(`/customers/${customerId}/credit-summary`)
      .then((res) => {
        if (!ignore)
          apply({
            creditLimit: res.data?.data?.creditLimit ?? null,
            creditAvailable: res.data?.data?.available ?? null,
          });
      })
      .catch(() => {
        if (!ignore) apply({ creditLimit: null, creditAvailable: null });
      });
    return () => {
      ignore = true;
    };
  }, [customerId, open]);

  return tender;
}

