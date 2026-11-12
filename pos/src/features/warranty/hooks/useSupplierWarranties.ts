import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  cancelSupplierClaimApi,
  closeSupplierClaimApi,
  createSupplierWarrantyApi,
  createSupplierWarrantyClaimApi,
  getSupplierWarrantyClaimDetailApi,
  getSupplierWarrantyClaimsApi,
  getSupplierWarrantiesApi,
  noteSupplierClaimApi,
  recoverSupplierClaimApi,
  replaceSupplierClaimApi,
  respondSupplierClaimApi,
} from "../api/warranty.api";
import type {
  CreateSupplierClaimInput,
  CreateSupplierWarrantyInput,
  SupplierClaimFilters,
  SupplierWarrantyFilters,
} from "../types/warranty.types";

export const supplierWarrantyKeys = {
  all: ["supplier-warranties"] as const,
  list: (filters: SupplierWarrantyFilters) =>
    [...supplierWarrantyKeys.all, "list", filters] as const,
};

export const supplierClaimKeys = {
  all: ["supplier-warranty-claims"] as const,
  list: (filters: SupplierClaimFilters) =>
    [...supplierClaimKeys.all, "list", filters] as const,
  detail: (id: number) => [...supplierClaimKeys.all, "detail", id] as const,
};

export function useSupplierWarrantiesList(filters: SupplierWarrantyFilters) {
  return useQuery({
    queryKey: supplierWarrantyKeys.list(filters),
    queryFn: () => getSupplierWarrantiesApi(filters),
    placeholderData: keepPreviousData,
  });
}

export function useSupplierClaimsList(filters: SupplierClaimFilters) {
  return useQuery({
    queryKey: supplierClaimKeys.list(filters),
    queryFn: () => getSupplierWarrantyClaimsApi(filters),
    placeholderData: keepPreviousData,
  });
}

export function useSupplierClaimDetail(id: number) {
  return useQuery({
    queryKey: supplierClaimKeys.detail(id),
    queryFn: () => getSupplierWarrantyClaimDetailApi(id),
    enabled: id > 0,
  });
}

function useInvalidateSupplierWarrantyData() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: supplierWarrantyKeys.all });
    void queryClient.invalidateQueries({ queryKey: supplierClaimKeys.all });
  };
}

function useSupplierMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
) {
  const invalidate = useInvalidateSupplierWarrantyData();
  return useMutation({
    mutationFn,
    onSuccess: invalidate,
  });
}

export function useCreateSupplierWarranty() {
  return useSupplierMutation((input: CreateSupplierWarrantyInput) =>
    createSupplierWarrantyApi(input),
  );
}

export function useCreateSupplierClaim() {
  return useSupplierMutation((input: CreateSupplierClaimInput) =>
    createSupplierWarrantyClaimApi(input),
  );
}

export function useRespondSupplierClaim() {
  return useSupplierMutation(
    (input: {
      claimId: number;
      body: {
        status: "sent_to_supplier" | "under_repair" | "rejected";
        note?: string;
      };
    }) => respondSupplierClaimApi(input.claimId, input.body),
  );
}

export function useReplaceSupplierClaim() {
  return useSupplierMutation(
    (input: {
      claimId: number;
      body: {
        replacementQuantity: number;
        replacementSerialNumbers?: string;
        intake: "none" | "adjust";
        note?: string;
      };
    }) => replaceSupplierClaimApi(input.claimId, input.body),
  );
}

export function useRecoverSupplierClaim() {
  return useSupplierMutation(
    (input: {
      claimId: number;
      body: {
        recoveryAmount: number;
        recoveryMethod: "credit_note" | "replacement" | "cash";
        recoveryReferenceId?: string;
        note?: string;
      };
    }) => recoverSupplierClaimApi(input.claimId, input.body),
  );
}

export function useCloseSupplierClaim() {
  return useSupplierMutation((input: { claimId: number }) =>
    closeSupplierClaimApi(input.claimId),
  );
}

export function useCancelSupplierClaim() {
  return useSupplierMutation((input: { claimId: number }) =>
    cancelSupplierClaimApi(input.claimId),
  );
}

export function useNoteSupplierClaim() {
  return useSupplierMutation(
    (input: { claimId: number; body: { note: string } }) =>
      noteSupplierClaimApi(input.claimId, input.body),
  );
}
