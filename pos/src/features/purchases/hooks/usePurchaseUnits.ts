import { useQuery, useQueryClient, useQueries } from "@tanstack/react-query";
import axios from "@/api/axios.js";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Purchasing-unit picker data (UOM migration 0062).
 *
 * GET /api/variant/:variantId/purchase-units → the purchasable units of one
 * variant: the FIRST entry is always the product's BASE unit (factor 1,
 * uomConversionId null); package units follow with their configured default
 * purchase price and the isDefaultPurchase flag.
 *
 * The server resolves factors/prices authoritatively on every submission —
 * these figures drive UI defaults and display hints only.
 */

export interface PurchaseUnitOption {
  /** Null = the product's base unit (identity conversion, factor 1). */
  uomConversionId: number | null;
  unitId: number;
  unitName: string;
  unitAbbreviation: string | null;
  /** How many base units ONE of this unit contains. */
  conversionFactor: number;
  defaultPurchasePrice: number | null;
  isDefaultPurchase: boolean;
}

export interface PurchaseUnitsResponse {
  baseUnit: { id: number; name: string; abbreviation: string | null } | null;
  units: PurchaseUnitOption[];
}

export const purchaseUnitsKeys = {
  all: ["purchases", "purchase-units"] as const,
  variant: (variantId: number) =>
    ["purchases", "purchase-units", variantId] as const,
};

export async function fetchPurchaseUnitsApi(
  variantId: number,
): Promise<PurchaseUnitsResponse> {
  const { data } = await axios.get<{ data: PurchaseUnitsResponse }>(
    `/variant/${variantId}/purchase-units`,
  );
  return data.data;
}

/**
 * The unit a new purchase line starts in: the configured default purchase
 * unit, or the base unit when none is flagged / the fetch fails.
 */
export function pickDefaultPurchaseUnit(
  units: PurchaseUnitOption[] | undefined,
): PurchaseUnitOption | null {
  if (!units || units.length === 0) return null;
  return units.find((unit) => unit.isDefaultPurchase) ?? units[0]!;
}

/** Imperative fetch for flows outside render (add-to-cart, scan handlers). */
export async function fetchPurchaseUnits(
  queryClient: QueryClient,
  variantId: number,
): Promise<PurchaseUnitsResponse | null> {
  try {
    return await queryClient.fetchQuery({
      queryKey: purchaseUnitsKeys.variant(variantId),
      queryFn: () => fetchPurchaseUnitsApi(variantId),
      staleTime: 5 * 60_000,
    });
  } catch {
    // A failed unit fetch must never block adding the product — the line
    // stays in the base unit (identity conversion).
    return null;
  }
}

/** Per-variant purchase-unit options (render-time). */
export function usePurchaseUnits(variantId: number | null) {
  return useQuery({
    queryKey: purchaseUnitsKeys.variant(variantId ?? 0),
    queryFn: () => fetchPurchaseUnitsApi(variantId!),
    enabled: variantId !== null,
    staleTime: 5 * 60_000,
  });
}

/**
 * Options for SEVERAL variants at once (receiving/return tables). Only the
 * variants that actually need units are fetched — callers pass the distinct
 * variant ids of the lines that carry a UOM snapshot, so legacy documents
 * fire no request at all.
 */
export function usePurchaseUnitsForVariants(variantIds: number[]) {
  const queries = useQueries({
    queries: variantIds.map((variantId) => ({
      queryKey: purchaseUnitsKeys.variant(variantId),
      queryFn: () => fetchPurchaseUnitsApi(variantId),
      staleTime: 5 * 60_000,
    })),
  });
  const loading =
    variantIds.length > 0 && queries.some((query) => query.isPending);
  const byVariant = new Map<number, PurchaseUnitOption[]>();
  queries.forEach((query, index) => {
    const variantId = variantIds[index]!;
    if (query.data?.units) byVariant.set(variantId, query.data.units);
  });
  return { byVariant, loading };
}

/** Find a unit option by its conversion id (null = base). */
export function findUnitByConversionId(
  units: PurchaseUnitOption[] | undefined,
  uomConversionId: number | null | undefined,
): PurchaseUnitOption | null {
  if (!units || units.length === 0) return null;
  if (uomConversionId == null) return units[0]!;
  return units.find((unit) => unit.uomConversionId === uomConversionId) ?? null;
}
