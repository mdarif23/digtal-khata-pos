import { useQuery } from "@tanstack/react-query";
import { useSessionStore } from "@/auth/sessionStore";
import { getCurrentBusinessSubscriptionApi } from "../subscriptions.api";

export const subscriptionKeys = {
  all: ["subscriptions"] as const,
  current: (businessId: number | null) =>
    [...subscriptionKeys.all, "business", businessId, "current"] as const,
};

export function useCurrentBusinessSubscription(enabled: boolean) {
  const businessId = useSessionStore((state) => state.businessId);

  return useQuery({
    queryKey: subscriptionKeys.current(businessId),
    queryFn: () => {
      if (businessId === null) {
        throw new Error("Cannot load a subscription without an active business.");
      }
      return getCurrentBusinessSubscriptionApi(businessId);
    },
    enabled: enabled && businessId !== null,
    staleTime: 5 * 60_000,
  });
}
