import {
  keepPreviousData,
  useQuery,
} from "@tanstack/react-query";
import {
  getWarrantiesApi,
  getWarrantyCertificateApi,
  getWarrantyDetailApi,
  getWarrantyOverviewApi,
  lookupWarrantiesApi,
} from "../api/warranty.api";
import type {
  WarrantyListFilters,
  WarrantyLookupType,
} from "../types/warranty.types";

/** Query-key factory — follows the Expense/online-orders convention. */
export const warrantyKeys = {
  all: ["warranties"] as const,
  list: (filters: WarrantyListFilters) =>
    [...warrantyKeys.all, "list", filters] as const,
  detail: (id: number) => [...warrantyKeys.all, "detail", id] as const,
  certificate: (id: number) => [...warrantyKeys.all, "certificate", id] as const,
  overview: () => [...warrantyKeys.all, "overview"] as const,
  lookup: (type: WarrantyLookupType, query: string) =>
    [...warrantyKeys.all, "lookup", type, query] as const,
};

export function useWarrantiesList(filters: WarrantyListFilters) {
  return useQuery({
    queryKey: warrantyKeys.list(filters),
    queryFn: () => getWarrantiesApi(filters),
    placeholderData: keepPreviousData,
  });
}

export function useWarrantyDetail(id: number) {
  return useQuery({
    queryKey: warrantyKeys.detail(id),
    queryFn: () => getWarrantyDetailApi(id),
    enabled: id > 0,
  });
}

/** Enabled only while the certificate dialog is open. */
export function useWarrantyCertificate(id: number, enabled: boolean) {
  return useQuery({
    queryKey: warrantyKeys.certificate(id),
    queryFn: () => getWarrantyCertificateApi(id),
    enabled: enabled && id > 0,
  });
}

export function useWarrantyOverview() {
  return useQuery({
    queryKey: warrantyKeys.overview(),
    queryFn: () => getWarrantyOverviewApi(),
  });
}

/** Lightweight lookup (max 20 rows) for the claim-creation dialog. */
export function useWarrantyLookup(type: WarrantyLookupType, query: string, enabled: boolean) {
  return useQuery({
    queryKey: warrantyKeys.lookup(type, query),
    queryFn: () => lookupWarrantiesApi(type, query),
    enabled: enabled && query.trim().length >= 3,
  });
}

/** Claim creation mutates the warranty's claims — both subtrees refresh. */
export function useInvalidateWarrantyData() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: warrantyKeys.all });
  };
}
