import { useQuery } from "@tanstack/react-query";
import axios from "../../../api/axios.js";
import { useSessionStore } from "@/auth/sessionStore.js";
import type { SellUnitRef } from "../types/cart.types.js";

/**
 * Packaging-unit selling: what units a variant can be sold in
 * (GET /variant/:id/sell-units). The first option is ALWAYS the base unit
 * (uomConversionId null); package options carry floor(availableStock /
 * conversionFactor) as `availablePackages`.
 *
 * Fetched LAZILY — on first add-to-cart / cart-line render / popover open.
 * The product grid never prefetches these. A module-level promise cache
 * backs the imperative paths (add-to-cart, hold resume) that run outside
 * React, so both paths share one request per variant+location.
 */

export interface SellUnitOption extends SellUnitRef {
  unitId: number;
  /** Whole packages sellable right now (null when the server omits it). */
  availablePackages: number | null;
  /** The unit a plain product click adds (often the base unit). */
  isDefaultSale: boolean;
}

export interface VariantSellUnits {
  baseUnit: { id: number; name: string; abbreviation: string | null } | null;
  units: SellUnitOption[];
}

export async function getVariantSellUnitsApi(
  variantId: number,
): Promise<VariantSellUnits> {
  const { data } = await axios.get<{ data: VariantSellUnits }>(
    `/variant/${variantId}/sell-units`,
  );
  return data.data;
}

// --- shared promise cache (per location:variant) ----------------------------

const sellUnitsCache = new Map<string, Promise<VariantSellUnits>>();

function cacheKey(variantId: number, locationId: number | null): string {
  return `${locationId ?? "none"}:${variantId}`;
}

/** Deduplicated fetch — failures evict the entry so a retry can succeed. */
export function fetchSellUnits(
  variantId: number,
  locationId: number | null,
): Promise<VariantSellUnits> {
  const key = cacheKey(variantId, locationId);
  const cached = sellUnitsCache.get(key);
  if (cached) return cached;
  const promise = getVariantSellUnitsApi(variantId).catch((error) => {
    sellUnitsCache.delete(key);
    throw error;
  });
  sellUnitsCache.set(key, promise);
  return promise;
}

/** Test seam — the cache would otherwise leak between tests. */
export function clearSellUnitsCache(): void {
  sellUnitsCache.clear();
}

/**
 * The unit a plain product-grid click adds: the server's default sale unit
 * (frequently the base unit itself). Returns null when sell-units are
 * unavailable (offline, fetch failure) — callers then fall back to the
 * base-unit line, which is exactly the pre-packaging behavior.
 */
export async function resolveDefaultSaleUnit(
  variantId: number,
): Promise<SellUnitOption | null> {
  try {
    const locationId = useSessionStore.getState().activeLocationId;
    const data = await fetchSellUnits(variantId, locationId);
    return data.units.find((unit) => unit.isDefaultSale) ?? data.units[0] ?? null;
  } catch {
    return null;
  }
}

// --- TanStack Query hook (cart lines / popover) ------------------------------

export const sellUnitsKeys = {
  all: ["sell-units"] as const,
  variant: (variantId: number, locationId: number | null | undefined) =>
    [...sellUnitsKeys.all, variantId, locationId] as const,
};

/**
 * Sell-units for one cart line. Location id is part of the key so a
 * location switch refetches; results are cached (staleTime) and deduped
 * across rows by the shared promise cache.
 */
export function useSellUnits(variantId: number | null, enabled = true) {
  const activeLocationId = useSessionStore((s) => s.activeLocationId);
  return useQuery({
    queryKey: sellUnitsKeys.variant(variantId ?? 0, activeLocationId),
    queryFn: () => fetchSellUnits(variantId as number, activeLocationId ?? null),
    enabled: enabled && variantId != null,
    staleTime: 60_000,
    retry: 1,
  });
}
