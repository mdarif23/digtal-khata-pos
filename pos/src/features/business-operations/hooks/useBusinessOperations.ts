import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSessionStore, type BusinessMode } from "@/auth/sessionStore";
import { changeBusinessMode, fetchBusinessOperations } from "../businessOperations.api";

export const businessOperationsKeys = {
  all: ["business-operations"] as const,
  current: (businessId: number | null) =>
    [...businessOperationsKeys.all, "business", businessId] as const,
};

export function useBusinessOperations() {
  const businessId = useSessionStore((state) => state.businessId);

  return useQuery({
    queryKey: businessOperationsKeys.current(businessId),
    queryFn: () => {
      if (businessId === null) {
        throw new Error(
          "Cannot load business operations without an active business.",
        );
      }
      return fetchBusinessOperations(businessId);
    },
    enabled: businessId !== null,
    staleTime: 60_000,
  });
}

/**
 * Mode switch mutation. On success the session context is reloaded (the
 * sidebar and route guards read the mode from /auth/me) and the operations
 * snapshot is invalidated.
 */
export function useChangeBusinessMode(onDone?: () => void) {
  const businessId = useSessionStore((state) => state.businessId);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (mode: BusinessMode) => {
      if (businessId === null) {
        throw new Error("No active business.");
      }
      await changeBusinessMode(businessId, mode);
      return mode;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: businessOperationsKeys.all,
      });
      onDone?.();
    },
  });
}
