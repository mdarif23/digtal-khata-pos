import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  landedCostApi,
  type LandedCostContext,
  type LandedCostDetail,
  type LandedCostPreview,
  type PreviewInput,
} from "../landedCost.api";

/** TanStack Query key factory — follows the procurement convention. */
export const landedCostKeys = {
  all: ["landed-cost"] as const,
  context: (purchaseId: number) =>
    [...landedCostKeys.all, "context", purchaseId] as const,
  preview: (purchaseId: number, input: PreviewInput | null) =>
    [...landedCostKeys.all, "preview", purchaseId, input] as const,
  document: (documentId: number) =>
    [...landedCostKeys.all, "document", documentId] as const,
};

export function useLandedCostContext(purchaseId: number) {
  return useQuery<LandedCostContext, Error>({
    queryKey: landedCostKeys.context(purchaseId),
    queryFn: () => landedCostApi.getContext(purchaseId),
    retry: false,
  });
}

export function useLandedCostPreview(
  purchaseId: number,
  input: PreviewInput | null,
) {
  return useQuery<LandedCostPreview, Error>({
    queryKey: landedCostKeys.preview(purchaseId, input),
    queryFn: () => landedCostApi.preview(purchaseId, input!),
    enabled: input !== null && input.expenses.length > 0,
    placeholderData: (previous) => previous,
    retry: false,
  });
}

export function useLandedCostDocument(documentId: number | null) {
  return useQuery<LandedCostDetail, Error>({
    queryKey: landedCostKeys.document(documentId ?? 0),
    queryFn: () => landedCostApi.getDocument(documentId!),
    // Purchases without a document have nothing to fetch — firing the query
    // would hit /landed-costs/0 and 404 on every page load.
    enabled: documentId !== null && documentId > 0,
    retry: false,
  });
}

function useInvalidateLandedCost() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: landedCostKeys.all });
}

export function useCreateLandedCost(purchaseId: number) {
  const invalidate = useInvalidateLandedCost();
  return useMutation({
    mutationFn: (input: PreviewInput) =>
      landedCostApi.createDocument(purchaseId, input),
    onSuccess: invalidate,
  });
}

export function useUpdateLandedCost(documentId: number) {
  const invalidate = useInvalidateLandedCost();
  return useMutation({
    mutationFn: (input: PreviewInput) =>
      landedCostApi.updateDocument(documentId, input),
    onSuccess: invalidate,
  });
}

export function usePostLandedCost() {
  const invalidate = useInvalidateLandedCost();
  return useMutation({
    mutationFn: (documentId: number) => landedCostApi.postDocument(documentId),
    onSuccess: invalidate,
  });
}
