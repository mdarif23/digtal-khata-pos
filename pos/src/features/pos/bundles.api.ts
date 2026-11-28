import { useQuery } from "@tanstack/react-query";
import axios from "../../api/axios.js";
import { useSessionStore } from "../../auth/sessionStore.js";
import type { PosBundle } from "./bundleCart.js";

/**
 * Bundle & Combo Phase 2 — POS-facing active bundles (bundle-kind
 * promotions that could apply right now, with components). Server-side the
 * feed mirrors the engine's window/location/usage filters; cart-dependent
 * conditions stay the quote's job. Offline the strip simply hides.
 */
export async function fetchActiveBundlesApi(
  locationId: number | null,
): Promise<PosBundle[]> {
  const res = await axios.get<{ data: PosBundle[] }>("/promotions/active-bundles", {
    params: locationId != null ? { locationId } : {},
  });
  return Array.isArray(res.data.data) ? res.data.data : [];
}

const bundlesKeys = {
  all: ["pos", "active-bundles"] as const,
  location: (locationId: number | null) => [...bundlesKeys.all, locationId] as const,
};

export function useActiveBundles(enabled = true) {
  const activeLocationId = useSessionStore((s) => s.activeLocationId);
  return useQuery({
    queryKey: bundlesKeys.location(activeLocationId ?? null),
    queryFn: () => fetchActiveBundlesApi(activeLocationId ?? null),
    enabled: enabled && navigator.onLine,
    staleTime: 60_000,
    retry: 1,
  });
}
