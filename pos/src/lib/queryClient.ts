import { QueryClient } from "@tanstack/react-query";

/**
 * App-wide TanStack Query client. Exported so non-React modules (Zustand
 * stores) can invalidate queries after their mutations succeed — e.g. the
 * sale store refreshing sell-unit stock after checkout.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
