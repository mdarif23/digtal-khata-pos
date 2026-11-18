import axios from "../../../api/axios.js";
import { getActiveBusinessId } from "../../../api/axios.js";
import { useQuery } from "@tanstack/react-query";

/**
 * Coupon list (Phase 6 Feature 1, domain 4) — previously raw axios in the
 * component. The hard-fail queryFn preserves the page's toast-on-error
 * contract; the page renders `data ?? null` (null → skeleton) and an empty
 * list after a failure, exactly like the old load() catch.
 */
export const couponKeys = {
  all: ["coupons"] as const,
  // R3-001: per-business data is keyed by the active business (same
  // convention as roleKeys/userKeys) so a future in-app switcher can't
  // serve one business's coupons to another.
  list: () => ["coupons", getActiveBusinessId(), "list"] as const,
};

export interface CouponRow {
  id: number;
  code: string;
  description: string | null;
  discountType: string;
  value: number;
  minOrderAmount: number;
  maxDiscountAmount: number | null;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  usedCount: number;
  isActive: boolean;
}

export function useCouponsQuery() {
  return useQuery({
    queryKey: couponKeys.list(),
    queryFn: async () => {
      const res = await axios.get<{ data: CouponRow[] }>("/coupons");
      return res.data.data;
    },
  });
}
