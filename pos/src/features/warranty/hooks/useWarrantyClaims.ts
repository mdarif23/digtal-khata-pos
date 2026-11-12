import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  addWarrantyClaimNoteApi,
  approveWarrantyClaimApi,
  assignWarrantyClaimApi,
  cancelWarrantyClaimApi,
  closeWarrantyClaimApi,
  createWarrantyClaimApi,
  getStaffOptionsApi,
  getWarrantyClaimDetailApi,
  getWarrantyClaimsApi,
  inspectWarrantyClaimApi,
  pickupWarrantyClaimApi,
  readyWarrantyClaimApi,
  rejectWarrantyClaimApi,
  replaceWarrantyClaimApi,
  updateWarrantyRepairApi,
} from "../api/warranty.api";
import type {
  CreateWarrantyClaimInput,
  WarrantyClaimsFilters,
} from "../types/warranty.types";
import { warrantyKeys } from "./useWarranties";

export const warrantyClaimKeys = {
  all: ["warranty-claims"] as const,
  list: (filters: WarrantyClaimsFilters) =>
    [...warrantyClaimKeys.all, "list", filters] as const,
  detail: (id: number) => [...warrantyClaimKeys.all, "detail", id] as const,
  staff: () => [...warrantyClaimKeys.all, "staff-options"] as const,
};

export function useWarrantyClaimsList(filters: WarrantyClaimsFilters) {
  return useQuery({
    queryKey: warrantyClaimKeys.list(filters),
    queryFn: () => getWarrantyClaimsApi(filters),
    placeholderData: keepPreviousData,
  });
}

export function useWarrantyClaimDetail(id: number) {
  return useQuery({
    queryKey: warrantyClaimKeys.detail(id),
    queryFn: () => getWarrantyClaimDetailApi(id),
    enabled: id > 0,
  });
}

/** Staff options for technician assignment (empty without users.view). */
export function useStaffOptions() {
  return useQuery({
    queryKey: warrantyClaimKeys.staff(),
    queryFn: () => getStaffOptionsApi(),
    staleTime: 5 * 60_000,
  });
}

function useInvalidateClaims() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: warrantyClaimKeys.all });
  };
}

/** Every claim write also touches the warranty subtree (claims are embedded
 *  in the warranty detail and the overview counters). */
function useClaimMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
) {
  const invalidateClaims = useInvalidateClaims();
  const invalidateWarranties = useInvalidateWarranties();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      invalidateClaims();
      invalidateWarranties();
    },
  });
}

function useInvalidateWarranties() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: warrantyKeys.all });
  };
}

export function useCreateWarrantyClaim() {
  return useClaimMutation((input: CreateWarrantyClaimInput) =>
    createWarrantyClaimApi(input),
  );
}

export function useInspectWarrantyClaim() {
  return useClaimMutation(
    (input: {
      claimId: number;
      body: { inspectionNotes?: string; receivedDate?: string };
    }) => inspectWarrantyClaimApi(input.claimId, input.body),
  );
}

export function useApproveWarrantyClaim() {
  return useClaimMutation(
    (input: {
      claimId: number;
      body: {
        inspectionNotes?: string;
        assignedUserId?: number;
        note?: string;
      };
    }) => approveWarrantyClaimApi(input.claimId, input.body),
  );
}

export function useRejectWarrantyClaim() {
  return useClaimMutation(
    (input: { claimId: number; body: { resolutionNotes: string } }) =>
      rejectWarrantyClaimApi(input.claimId, input.body),
  );
}

export function useUpdateWarrantyRepair() {
  return useClaimMutation(
    (input: {
      claimId: number;
      body: {
        status: "repairing" | "waiting_parts";
        repairDescription?: string;
        partsUsed?: string;
        repairCost?: number;
        assignedUserId?: number;
        note?: string;
      };
    }) => updateWarrantyRepairApi(input.claimId, input.body),
  );
}

export function useAssignWarrantyClaim() {
  return useClaimMutation(
    (input: {
      claimId: number;
      body: { assignedUserId: number; note?: string };
    }) => assignWarrantyClaimApi(input.claimId, input.body),
  );
}

export function useReadyWarrantyClaim() {
  return useClaimMutation((input: { claimId: number }) =>
    readyWarrantyClaimApi(input.claimId),
  );
}

export function usePickupWarrantyClaim() {
  return useClaimMutation((input: { claimId: number }) =>
    pickupWarrantyClaimApi(input.claimId),
  );
}

export function useReplaceWarrantyClaim() {
  return useClaimMutation(
    (input: {
      claimId: number;
      body: {
        replacementVariantId: number;
        replacementSerialNumber?: string;
        note?: string;
      };
    }) => replaceWarrantyClaimApi(input.claimId, input.body),
  );
}

export function useCloseWarrantyClaim() {
  return useClaimMutation((input: { claimId: number }) =>
    closeWarrantyClaimApi(input.claimId),
  );
}

export function useCancelWarrantyClaim() {
  return useClaimMutation((input: { claimId: number }) =>
    cancelWarrantyClaimApi(input.claimId),
  );
}

export function useAddWarrantyClaimNote() {
  return useClaimMutation(
    (input: { claimId: number; body: { note: string } }) =>
      addWarrantyClaimNoteApi(input.claimId, input.body),
  );
}
