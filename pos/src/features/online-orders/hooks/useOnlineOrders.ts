import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  addPackageApi,
  cancelOrderApi,
  confirmOrderApi,
  deliverOrderApi,
  getOrderApi,
  getOrderFulfillmentApi,
  getOrderTimelineApi,
  getOrdersSummaryApi,
  getPackagingDefaultsApi,
  listOrdersApi,
  markOrderPaidApi,
  readyToShipApi,
  removePackageApi,
  shipOrderApi,
  startProcessingApi,
  updatePackageApi,
  updateShipmentApi,
} from "../api/onlineOrders.api";
import type {
  DeliverInput,
  MarkPaidInput,
  OnlineOrdersFilters,
  PackageInput,
  ShipmentInput,
} from "../types/onlineOrders.types";

/** Query-key factory — follows the due-management/procurement convention. */
export const onlineOrderKeys = {
  all: ["online-orders"] as const,
  list: (filters: OnlineOrdersFilters) =>
    [...onlineOrderKeys.all, "list", filters] as const,
  summary: (
    filters: Pick<
      OnlineOrdersFilters,
      "channel" | "locationId" | "from" | "to"
    >,
  ) => [...onlineOrderKeys.all, "summary", filters] as const,
  detail: (orderId: number) =>
    [...onlineOrderKeys.all, "detail", orderId] as const,
  timeline: (orderId: number) =>
    [...onlineOrderKeys.all, "timeline", orderId] as const,
  fulfillment: (orderId: number) =>
    [...onlineOrderKeys.all, "fulfillment", orderId] as const,
  packagingDefaults: (orderId: number) =>
    [...onlineOrderKeys.all, "packaging-defaults", orderId] as const,
};

export function useOnlineOrders(filters: OnlineOrdersFilters) {
  return useQuery({
    queryKey: onlineOrderKeys.list(filters),
    queryFn: () => listOrdersApi(filters),
    placeholderData: keepPreviousData,
    // New storefront/Woo orders arrive server-side — poll lightly so the
    // list stays fresh without any manual refresh.
    refetchInterval: 30_000,
  });
}

export function useOrdersSummary(
  filters: Pick<OnlineOrdersFilters, "channel" | "locationId" | "from" | "to">,
) {
  return useQuery({
    queryKey: onlineOrderKeys.summary(filters),
    queryFn: () => getOrdersSummaryApi(filters),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}

export function useOnlineOrder(orderId: number) {
  return useQuery({
    queryKey: onlineOrderKeys.detail(orderId),
    queryFn: () => getOrderApi(orderId),
    enabled: orderId > 0,
  });
}

export function useOrderTimeline(orderId: number) {
  return useQuery({
    queryKey: onlineOrderKeys.timeline(orderId),
    queryFn: () => getOrderTimelineApi(orderId),
    enabled: orderId > 0,
  });
}

export function useOrderFulfillment(orderId: number) {
  return useQuery({
    queryKey: onlineOrderKeys.fulfillment(orderId),
    queryFn: () => getOrderFulfillmentApi(orderId),
    enabled: orderId > 0,
  });
}

export function usePackagingDefaults(orderId: number, enabled: boolean) {
  return useQuery({
    queryKey: onlineOrderKeys.packagingDefaults(orderId),
    queryFn: () => getPackagingDefaultsApi(orderId),
    enabled: enabled && orderId > 0,
  });
}

function useInvalidateOnlineOrders() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: onlineOrderKeys.all });
  };
}

/** Every mutation invalidates the whole online-orders subtree — the list,
 * summary and any open order detail all refresh together. */
export function useOrderMutation<TInput>(
  mutationFn: (input: TInput) => Promise<void>,
) {
  const invalidate = useInvalidateOnlineOrders();
  return useMutation({
    mutationFn: async (input: TInput) => {
      await mutationFn(input);
    },
    onSuccess: invalidate,
  });
}

export function useConfirmOrder() {
  return useOrderMutation((orderId: number) => confirmOrderApi(orderId));
}

export function useStartProcessing() {
  return useOrderMutation((orderId: number) => startProcessingApi(orderId));
}

export function useCancelOrder() {
  return useOrderMutation(
    ({
      orderId,
      reason,
    }: {
      orderId: number;
      reason?: string | undefined;
    }) => cancelOrderApi(orderId, reason),
  );
}

export function useReadyToShip() {
  return useOrderMutation((orderId: number) => readyToShipApi(orderId));
}

export function useShipOrder() {
  return useOrderMutation(
    ({ orderId, payload }: { orderId: number; payload: ShipmentInput }) =>
      shipOrderApi(orderId, payload),
  );
}

export function useUpdateShipment() {
  return useOrderMutation(
    ({ orderId, payload }: { orderId: number; payload: ShipmentInput }) =>
      updateShipmentApi(orderId, payload),
  );
}

export function useDeliverOrder() {
  return useOrderMutation(
    ({ orderId, payload }: { orderId: number; payload: DeliverInput }) =>
      deliverOrderApi(orderId, payload),
  );
}

export function useMarkOrderPaid() {
  return useOrderMutation(
    ({ orderId, payload }: { orderId: number; payload: MarkPaidInput }) =>
      markOrderPaidApi(orderId, payload),
  );
}

export function useAddPackage() {
  return useOrderMutation(
    ({ orderId, payload }: { orderId: number; payload: PackageInput }) =>
      addPackageApi(orderId, payload),
  );
}

export function useUpdatePackage() {
  return useOrderMutation(
    ({
      orderId,
      packageId,
      payload,
    }: {
      orderId: number;
      packageId: number;
      payload: PackageInput;
    }) => updatePackageApi(orderId, packageId, payload),
  );
}

export function useRemovePackage() {
  return useOrderMutation(
    ({ orderId, packageId }: { orderId: number; packageId: number }) =>
      removePackageApi(orderId, packageId),
  );
}
