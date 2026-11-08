import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, PackageMinus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { PurchaseReturnSummary } from "@/features/purchases/components/return/PurchaseReturnSummary";
import { ReturnItemsTable } from "@/features/purchases/components/return/ReturnItemsTable";
import { SupplierCreditSummary } from "@/features/purchases/components/return/SupplierCreditSummary";
import { formatCurrency } from "@/features/purchases/utils/formatCurrency";
import {
  allocateScannedUnit,
  estimateReturnUnitPrice,
  maxReturnableForItem,
} from "@/features/purchases/utils/returnCalculations";
import type {
  PaymentsInfoCard,
  PurchaseDetailItem,
  PurchaseReturnPreview,
} from "@/features/purchases/purchase.types";
import {
  purchaseDetailKeys,
  usePurchaseDetail,
} from "@/features/purchases/hooks/usePurchaseDetail";
import { usePurchaseReturn } from "@/features/purchases/hooks/usePurchaseReturn";
import { usePurchaseReturnPreview } from "@/features/purchases/hooks/usePurchaseReturnPreview";
import { useReturnableSerials } from "@/features/purchases/hooks/useReturnableSerials";
import { useScanFailureToast } from "@/features/barcodes/scanning/useScanFailureToast";
import type { LookupMatch } from "@/features/barcodes/barcode.api";
import { useBarcodeScanner } from "@/features/barcodes/scanning/useBarcodeScanner";
import { BarcodeScannerInput } from "@/features/barcodes/scanning/BarcodeScannerInput";
import { BarcodeScanFeedback } from "@/features/barcodes/scanning/BarcodeScanFeedback";

/**
 * Purchase return page. Phase 1 (return module): all page data comes from
 * the purchase-specific detail endpoint, whose returnContext evaluates
 * availability at the purchase's RECEIVING location — the page no longer
 * loads business-wide stores and can never clamp against the caller's
 * active location. The server stays authoritative at submission.
 */
function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export const PurchaseViewItems = () => {
  const { id } = useParams();
  const purchaseId = Number(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [returnQuantities, setReturnQuantities] = useState<
    Record<number, number>
  >({});
  // Phase 5: explicit serial selections per serial-tracked line.
  const [serialSelections, setSerialSelections] = useState<
    Record<number, number[]>
  >({});

  const validPurchaseId =
    Number.isInteger(purchaseId) && purchaseId > 0 ? purchaseId : null;
  const detail = usePurchaseDetail(validPurchaseId);
  const returnMutation = usePurchaseReturn();
  const serialsQuery = useReturnableSerials(validPurchaseId);

  const purchaseOrder = detail.data?.purchase;
  const returnContext = detail.data?.returnContext;

  const orderItems = useMemo(
    () => detail.data?.items ?? [],
    [detail.data],
  );

  // Availability from the return context: previously-returned quantities
  // and on-hand stock at the RECEIVING location (per line's variant).
  const returnedByItem = useMemo(
    () =>
      new Map(
        (returnContext?.items ?? []).map((entry) => [
          entry.purchaseItemId,
          entry.returnedQuantity,
        ]),
      ),
    [returnContext],
  );
  const stockByItem = useMemo(
    () =>
      new Map(
        (returnContext?.items ?? []).map((entry) => [
          entry.purchaseItemId,
          entry.availableStock,
        ]),
      ),
    [returnContext],
  );
  // Phase 5: eligible serials per serial-tracked line.
  const serialsByItem = useMemo(
    () =>
      new Map(
        (serialsQuery.data?.items ?? []).map((entry) => [
          entry.purchaseItemId,
          entry.serials,
        ]),
      ),
    [serialsQuery.data],
  );
  // Keep a serial line's selection in sync with its quantity: the first N
  // eligible serials are preselected (the user can then adjust the boxes).
  const syncSerialSelection = (item: PurchaseDetailItem, quantity: number) => {
    const eligible = serialsByItem.get(item.id);
    if (!eligible) return;
    setSerialSelections((current) => {
      const previous = current[item.id] ?? [];
      if (previous.length === quantity) return current;
      return {
        ...current,
        [item.id]: eligible.slice(0, quantity).map((serial) => serial.id),
      };
    });
  };
  const toggleSerial = (
    item: PurchaseDetailItem,
    serialId: number,
    checked: boolean,
  ) => {
    const eligible = serialsByItem.get(item.id) ?? [];
    const previous = serialSelections[item.id] ?? [];
    const next = checked
      ? [...previous, serialId]
      : previous.filter((id) => id !== serialId);
    // Selection drives the quantity — the count must always match.
    setSerialSelections((current) => ({ ...current, [item.id]: next }));
    setReturnQuantities((current) => ({
      ...current,
      [item.id]: Math.min(next.length, eligible.length),
    }));
  };

  // Override the detail lines' (active-location) stock with the receiving
  // location's stock before any clamp/estimate math runs.
  const returnableItems = useMemo(
    () =>
      orderItems.map((item) => ({
        ...item,
        availableStock: stockByItem.get(item.id) ?? 0,
      })),
    [orderItems, stockByItem],
  );

  const requestedItems = useMemo(
    () =>
      orderItems
        .map((item) => {
          const quantity = returnQuantities[item.id] ?? 0;
          const eligible = serialsByItem.get(item.id);
          // Serial lines with an eligible list submit their EXACT
          // selection; lines without one use the auto-pick fallback.
          const serialSelection =
            item.trackingType === "serial" && eligible
              ? (serialSelections[item.id] ?? [])
              : undefined;
          return {
            purchaseItemId: item.id,
            quantity,
            ...(serialSelection !== undefined && eligible
              ? { serialIds: serialSelection }
              : {}),
            serialCountMatches:
              serialSelection === undefined ||
              serialSelection.length === quantity,
          };
        })
        .filter((item) => item.quantity > 0),
    [orderItems, returnQuantities, serialSelections, serialsByItem],
  );
  // Serial lines: the selected count must match the quantity before submit.
  const serialCountsMatch = requestedItems.every(
    (item) => item.serialCountMatches,
  );
  // The wire shape for preview + submit: only {purchaseItemId, quantity,
  // serialIds?} — the internal count-match flag never leaves the page.
  const wireItems = useMemo(
    () =>
      requestedItems.map(({ purchaseItemId, quantity, serialIds }) => ({
        purchaseItemId,
        quantity,
        ...(serialIds !== undefined ? { serialIds } : {}),
      })),
    [requestedItems],
  );
  const previewSelection = useDebouncedValue(wireItems, 300);
  // Phase 2: the summary shows the SERVER's authoritative preview, not a
  // client estimate. keepPreviousData holds the previous numbers while a
  // new selection loads.
  const preview = usePurchaseReturnPreview(
    validPurchaseId,
    previewSelection,
  );
  // Per-line authoritative credits from the preview (the table prefers
  // these over the client estimate).
  const previewLineCredits = useMemo(
    () =>
      new Map(
        (preview.data?.goodsCredit.lineCredits ?? []).map((line) => [
          line.purchaseItemId,
          line.goodsCredit,
        ]),
      ),
    [preview.data],
  );
  const receivedValue = returnableItems.reduce(
    (sum, item) =>
      sum + Number(item.receivedQuantity || 0) * estimateReturnUnitPrice(item),
    0,
  );

  const orderSummary: PaymentsInfoCard[] = [
    {
      bg: "bg-sky-50",
      circleBg: "bg-sky-500",
      title: "Order status",
      status: purchaseOrder?.status.replace("_", " ") ?? "Loading",
    },
    {
      bg: "bg-emerald-50",
      circleBg: "bg-emerald-500",
      title: "Payment status",
      status: purchaseOrder?.paymentStatus ?? "—",
    },
    {
      bg: "bg-violet-50",
      circleBg: "bg-violet-500",
      title: "Order total",
      total: Number(purchaseOrder?.totalAmount ?? 0),
    },
    {
      bg: "bg-rose-50",
      circleBg: "bg-rose-500",
      title: "Received value",
      total: receivedValue,
    },
  ];

  // Server-authoritative summary (Phase 2). While the preview loads there
  // are no cards at all — an estimate is never shown as a confirmed amount.
  const previewData = preview.data;
  const expectedReversal =
    previewData?.landedCost.applies === true
      ? previewData.landedCost.expectedReversal
      : 0;
  // Phase 7: when the reversal is not applicable, the card says WHY (a
  // label of the SERVER's state — never a client-side inference).
  const LANDED_STATE_LABELS: Record<
    NonNullable<PurchaseReturnPreview["landedCost"]["state"]>,
    string
  > = {
    no_document: "No landed-cost document",
    draft: "Draft — nothing capitalized to reverse",
    reversed: "Already fully reversed",
    posted: "No allocated landed cost on these batches",
    adjusted: "No allocated landed cost on these batches",
  };
  const totalExpectedCredit =
    previewData === undefined
      ? null
      : Math.round(
          (previewData.goodsCredit.total + expectedReversal) * 100,
        ) / 100;
  const returnSummary: PaymentsInfoCard[] =
    previewData === undefined
      ? []
      : [
          {
            bg: "bg-amber-50",
            circleBg: "bg-amber-500",
            title: "Expected goods credit",
            total: previewData.goodsCredit.total,
          },
          previewData.landedCost.applies
            ? {
                bg: "bg-orange-50",
                circleBg: "bg-orange-500",
                title: "Landed-cost reversal",
                total: expectedReversal,
              }
            : {
                bg: "bg-orange-50",
                circleBg: "bg-orange-500",
                title: "Landed-cost reversal",
                status: `${
                  LANDED_STATE_LABELS[previewData.landedCost.state]
                }${previewData.landedCost.pendingAllocation && previewData.landedCost.pendingAllocation > 0 ? ` · ৳${previewData.landedCost.pendingAllocation} pending allocation` : ""}`,
              },
          {
            bg: "bg-emerald-50",
            circleBg: "bg-emerald-500",
            title: "Total expected supplier credit",
            total: totalExpectedCredit ?? 0,
          },
          {
            bg: "bg-blue-50",
            circleBg: "bg-blue-500",
            title: "Purchase due after return",
            total: previewData.supplierBalance.outstandingAfter,
          },
          ...(previewData.supplierBalance.supplierCreditCreated > 0
            ? [
                {
                  bg: "bg-violet-50",
                  circleBg: "bg-violet-500",
                  title: "Supplier credit balance created",
                  total: previewData.supplierBalance.supplierCreditCreated,
                },
              ]
            : []),
        ];

  const maxReturnFor = (item: PurchaseDetailItem) => {
    // Units already typed for sibling lines sharing this variant.
    const selectedForVariant = orderItems.reduce(
      (sum, otherItem) =>
        otherItem.variantId === item.variantId && otherItem.id !== item.id
          ? sum + (returnQuantities[otherItem.id] ?? 0)
          : sum,
      0,
    );
    return maxReturnableForItem(
      item,
      returnedByItem.get(item.id) ?? 0,
      selectedForVariant,
    );
  };

  const updateQuantity = (item: PurchaseDetailItem, value: number) => {
    const maxReturn = maxReturnFor(item);
    const quantity = Math.min(Math.max(0, Math.floor(value)), maxReturn);
    setReturnQuantities((current) => ({ ...current, [item.id]: quantity }));
    syncSerialSelection(item, quantity);
  };

  const handleSubmit = async () => {
    if (!purchaseOrder || requestedItems.length === 0) return;
    try {
      const result = await createEntityPromiseToast({
        data: {
          orderId: purchaseId,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          changedItems: wireItems,
        },
        apiCall: (values) => returnMutation.mutateAsync(values),
        entityName: "Purchase return",
        getSuccessMessage: (response) =>
          `${response.message} Total: ৳ ${formatCurrency(response.data.totalAmount)}`,
      });
      // Store/query refreshes happen in usePurchaseReturn's onSuccess
      // (purchases, products, landed-cost, due-management). The detail
      // query is invalidated so a revisit re-reads the new availability;
      // the landed-cost reversal notice is rendered by the list page from
      // router state.
      await queryClient.invalidateQueries({
        queryKey: purchaseDetailKeys.detail(purchaseId),
      });
      navigate("/purchases-list", {
        state: {
          returnNotice: {
            purchaseId,
            landedCost: result.data.landedCost,
            supplierBalance: result.data.supplierBalance,
            returnedSerials: result.data.returnedSerials,
          },
        },
      });
    } catch {
      // The toast reports the API error; keep the return form open for correction.
    }
  };

  /**
   * Module scan handler — the scanner service only IDENTIFIES a barcode;
   * return eligibility (received − returned, capped by in-stock units)
   * lives here. Scanning never submits a return. Throwing surfaces the
   * failure as an error scan.
   */
  const returnQuantitiesRef = useRef(returnQuantities);
  returnQuantitiesRef.current = returnQuantities;

  const orderItemsRef = useRef(orderItems);
  orderItemsRef.current = orderItems;
  const returnedByItemRef = useRef(returnedByItem);
  returnedByItemRef.current = returnedByItem;
  const handleResolved = (match: LookupMatch) => {
    // Phase 4: a variant may span multiple purchase lines — the scan fills
    // the FIRST line with capacity (purchase-order sequence) and moves to
    // the next when one is exhausted, capped by the shared receiving-
    // location stock. No line can exceed its eligible quantity.
    if (
      !orderItemsRef.current.some(
        (entry) => entry.variantId === match.variantId,
      )
    ) {
      throw new Error("This item is not on this purchase order.");
    }
    const updated = allocateScannedUnit({
      lines: orderItemsRef.current,
      variantId: match.variantId,
      returnedByItem: returnedByItemRef.current,
      returnQuantities: returnQuantitiesRef.current,
    });
    if (!updated) {
      throw new Error(
        "This item has no remaining returnable quantity in this purchase.",
      );
    }
    // Eagerly mirror the next value into the ref: real scanners fire one
    // discrete event per scan (React re-renders between), but batched
    // scans arriving in one tick must still accumulate instead of all
    // reading the same committed state.
    returnQuantitiesRef.current = updated;
    setReturnQuantities(updated);
    const scannedItem = orderItemsRef.current.find(
      (entry) =>
        entry.variantId === match.variantId &&
        (returnQuantitiesRef.current[entry.id] ?? 0) !== updated[entry.id],
    );
    if (scannedItem) {
      syncSerialSelection(scannedItem, updated[scannedItem.id] ?? 0);
    }
  };

  const { scanner, state: scanState } = useBarcodeScanner({
    capture: "window",
    onResolve: handleResolved,
  });

  useScanFailureToast(scanState);

  if (!validPurchaseId) {
    return (
      <ReturnState
        title="Invalid purchase order"
        message="The purchase order ID is invalid."
      />
    );
  }
  if (detail.isPending) {
    return (
      <ReturnState
        title="Loading purchase order"
        message="Loading purchase items and previous returns..."
      />
    );
  }
  if (detail.isError || !purchaseOrder) {
    return (
      <ReturnState
        title="Purchase order not found"
        message={
          detail.error instanceof Error && detail.error.message
            ? detail.error.message
            : "This purchase order could not be found."
        }
      />
    );
  }
  if (!purchaseOrder.supplierId) {
    return (
      <ReturnState
        title="Supplier required"
        message="This purchase has no supplier. The current purchase return records require a supplier account."
      />
    );
  }

  return (
    <div className="min-h-[calc(100vh-1rem)] bg-muted/30 p-4 md:p-6">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Button nativeButton={false}
              variant="ghost"
              size="sm"
              className="-ml-2 mb-2"
              render={<Link to="/purchases-list" />}
            >
              <ArrowLeft /> Purchase orders
            </Button>
            <p className="text-sm font-medium text-muted-foreground">
              {purchaseOrder.purchaseOrderNumber}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              Return items to supplier
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {purchaseOrder.supplierName || "Supplier"} ·{" "}
              {new Date(purchaseOrder.purchaseDate).toLocaleDateString()}
              {returnContext?.locationName
                ? ` · Received at ${returnContext.locationName}`
                : ""}
            </p>
          </div>
          <div className="rounded-lg border bg-background px-4 py-3">
            <p className="text-sm text-muted-foreground">Order total</p>
            <p className="text-xl font-semibold">
              ৳ {formatCurrency(Number(purchaseOrder.totalAmount))}
            </p>
          </div>
        </header>

        <PurchaseReturnSummary
          cards={orderSummary}
          formatCurrency={formatCurrency}
        />

        <section className="overflow-hidden rounded-xl border bg-background shadow-sm">
          <div className="border-b p-4 md:p-5">
            <div className="flex items-center gap-3">
              <PackageMinus className="size-5 text-primary" />
              <div>
                <h2 className="font-semibold">Eligible purchase items</h2>
                <p className="text-sm text-muted-foreground">
                  Only received units that are still in stock can be returned.
                  {returnContext?.locationName
                    ? ` Stock shown for the receiving location (${returnContext.locationName}).`
                    : ""}
                </p>
              </div>
            </div>
            {orderItems.length ? (
              <div className="mt-3 space-y-2 rounded-lg border bg-muted/30 p-2">
                <BarcodeScannerInput
                  scanner={scanner}
                  placeholder="Scan a barcode to add it to the return…"
                  aria-label="Scan barcode to add a purchase return item"
                />
                <BarcodeScanFeedback state={scanState} />
              </div>
            ) : null}
          </div>
          {!serialCountsMatch && (
            <p
              role="alert"
              className="border-b bg-destructive/10 p-3 text-sm text-destructive"
            >
              Select exactly the return quantity for every serial-tracked
              line before submitting.
            </p>
          )}
          <ReturnItemsTable
            orderItems={returnableItems}
            returnedByItem={returnedByItem}
            returnQuantities={returnQuantities}
            lineCredits={previewLineCredits}
            serialsByItem={serialsByItem}
            selectedSerials={new Map(
              Object.entries(serialSelections).map(([id, ids]) => [
                Number(id),
                ids,
              ]),
            )}
            onToggleSerial={toggleSerial}
            onQuantityChange={updateQuantity}
          />
        </section>

        <SupplierCreditSummary
          cards={returnSummary}
          formatCurrency={formatCurrency}
        >
          {requestedItems.length > 0 && preview.isFetching && (
            <p className="text-sm text-muted-foreground">
              Calculating the authoritative preview…
            </p>
          )}
          {previewData && !previewData.canSubmit && (
            <div
              role="alert"
              className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
            >
              {previewData.issues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
            </div>
          )}
          {previewData && (
            <p className="text-xs text-muted-foreground">
              Final amounts are recalculated during submission and may change
              if inventory or purchase data changes.
            </p>
          )}
          <label className="block space-y-1.5 text-sm font-medium">
            Return reason{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={300}
              rows={2}
              placeholder="Damaged, incorrect item, or supplier agreement"
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
            />
          </label>

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button
              nativeButton={false}
              type="button"
              variant="outline"
              render={<Link to="/purchases-list" />}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={
                returnMutation.isPending ||
                requestedItems.length === 0 ||
                !serialCountsMatch ||
                // A required preview that is loading, failed, or reported
                // issues always blocks submission (Phase 2).
                (requestedItems.length > 0 &&
                  (preview.isPending ||
                    preview.isFetching ||
                    preview.isError ||
                    !preview.data?.canSubmit))
              }
            >
              <RotateCcw />
              {returnMutation.isPending
                ? "Processing return..."
                : "Process purchase return"}
            </Button>
          </div>
        </SupplierCreditSummary>
      </div>
    </div>
  );
};

function ReturnState({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex min-h-96 flex-col items-center justify-center px-6 text-center">
      <PackageMinus className="size-10 text-muted-foreground/50" />
      <h1 className="mt-4 text-xl font-semibold">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">{message}</p>
      <Button
        nativeButton={false}
        className="mt-5"
        variant="outline"
        render={<Link to="/purchases-list" />}
      >
        <ArrowLeft /> Back to purchase orders
      </Button>
    </div>
  );
}
