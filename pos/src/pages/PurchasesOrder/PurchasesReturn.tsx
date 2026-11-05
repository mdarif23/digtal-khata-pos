import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, PackageMinus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { toast } from "@/components/ui/toast";
import { PurchaseReturnSummary } from "@/features/purchases/components/return/PurchaseReturnSummary";
import { ReturnItemsTable } from "@/features/purchases/components/return/ReturnItemsTable";
import { SupplierCreditSummary } from "@/features/purchases/components/return/SupplierCreditSummary";
import { formatCurrency } from "@/features/purchases/utils/formatCurrency";
import {
  estimateReturnUnitPrice,
  maxReturnableForItem,
} from "@/features/purchases/utils/returnCalculations";
import type {
  PaymentsInfoCard,
  PurchasesItems,
} from "@/features/purchases/purchase.types";
import { usePurchasesStore } from "@/features/purchases/usePurchaseStore";
import { usePurchaseReturn } from "@/features/purchases/hooks/usePurchaseReturn";
import { useScanFailureToast } from "@/features/barcodes/scanning/useScanFailureToast";
import type { LookupMatch } from "@/features/barcodes/barcode.api";
import { useBarcodeScanner } from "@/features/barcodes/scanning/useBarcodeScanner";
import { BarcodeScannerInput } from "@/features/barcodes/scanning/BarcodeScannerInput";
import { BarcodeScanFeedback } from "@/features/barcodes/scanning/BarcodeScanFeedback";

export const PurchaseViewItems = () => {
  const { id } = useParams();
  const purchaseId = Number(id);
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [reason, setReason] = useState("");
  const [returnQuantities, setReturnQuantities] = useState<
    Record<number, number>
  >({});

  const purchases = usePurchasesStore((state) => state.purchases.allPurchases);
  const purchaseItems = usePurchasesStore((state) => state.purchasesItems);
  const returnedItems = usePurchasesStore(
    (state) => state.purchasesReturnItems,
  );
  const error = usePurchasesStore((state) => state.error);
  const getPurchases = usePurchasesStore((state) => state.getPurchases);
  const getPurchaseItems = usePurchasesStore((state) => state.getPurchaseItems);
  const getPurchasesReturnItems = usePurchasesStore(
    (state) => state.getPurchasesReturnItems,
  );
  const returnMutation = usePurchaseReturn();

  useEffect(() => {
    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    Promise.all([
      getPurchases(),
      getPurchaseItems(),
      getPurchasesReturnItems(),
    ]).finally(() => setIsLoading(false));
  }, [getPurchaseItems, getPurchases, getPurchasesReturnItems, purchaseId]);

  const purchaseOrder = purchases.find(
    (purchase) => purchase.id === purchaseId,
  );
  const orderItems = useMemo(
    () => purchaseItems.filter((item) => item.purchaseId === purchaseId),
    [purchaseId, purchaseItems],
  );
  const returnedByItem = useMemo(
    () =>
      new Map(
        returnedItems.map((item) => [
          item.purchaseItemId,
          Number(item.returnQuantity) || 0,
        ]),
      ),
    [returnedItems],
  );
  const requestedItems = useMemo(
    () =>
      orderItems
        .map((item) => ({
          purchaseItemId: item.id,
          quantity: returnQuantities[item.id] ?? 0,
        }))
        .filter((item) => item.quantity > 0),
    [orderItems, returnQuantities],
  );
  // Client-side ESTIMATE — the server credits per-unit batch costs (FIFO)
  // and its authoritative total is shown in the success toast.
  const totalRefund = orderItems.reduce(
    (sum, item) =>
      sum + (returnQuantities[item.id] ?? 0) * estimateReturnUnitPrice(item),
    0,
  );
  const receivedValue = orderItems.reduce(
    (sum, item) =>
      sum + Number(item.receivedQuantity || 0) * estimateReturnUnitPrice(item),
    0,
  );
  const balanceAfterReturn = Math.max(
    0,
    Number(purchaseOrder?.dueAmount || 0) - totalRefund,
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

  const returnSummary: PaymentsInfoCard[] = [
    {
      bg: "bg-amber-50",
      circleBg: "bg-amber-500",
      title: "Return value",
      total: totalRefund,
    },
    {
      bg: "bg-emerald-50",
      circleBg: "bg-emerald-500",
      title: "Previously paid",
      total: Number(purchaseOrder?.paidAmount ?? 0),
    },
    {
      bg: "bg-blue-50",
      circleBg: "bg-blue-500",
      title: "Balance after return",
      total: balanceAfterReturn,
    },
  ];

  // Units already typed for sibling lines sharing this variant.
  const selectedForVariant = (item: PurchasesItems) =>
    orderItems.reduce(
      (sum, otherItem) =>
        otherItem.variantId === item.variantId && otherItem.id !== item.id
          ? sum + (returnQuantities[otherItem.id] ?? 0)
          : sum,
      0,
    );

  const updateQuantity = (item: PurchasesItems, value: number) => {
    const maxReturn = maxReturnableForItem(
      item,
      returnedByItem.get(item.id) ?? 0,
      selectedForVariant(item),
    );
    const quantity = Math.min(Math.max(0, Math.floor(value)), maxReturn);
    setReturnQuantities((current) => ({ ...current, [item.id]: quantity }));
  };

  const handleSubmit = async () => {
    if (!purchaseOrder || requestedItems.length === 0) return;
    try {
      const result = await createEntityPromiseToast({
        data: {
          orderId: purchaseId,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          changedItems: requestedItems,
        },
        apiCall: (values) => returnMutation.mutateAsync(values),
        entityName: "Purchase return",
        getSuccessMessage: (response) =>
          `${response.message} Total: ৳ ${formatCurrency(response.data.totalAmount)}`,
      });
      // Store/query refreshes happen in usePurchaseReturn's onSuccess
      // (purchases, products, landed-cost, due-management). The landed-cost
      // reversal notice is rendered by the list page from router state.
      navigate("/purchases-list", {
        state: {
          returnNotice: {
            purchaseId,
            landedCost: result.data.landedCost,
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

  const handleResolved = (match: LookupMatch) => {
    const item = orderItems.find((entry) => entry.variantId === match.variantId);
    if (!item) {
      throw new Error("This item is not on this purchase order.");
    }
    const itemName = item.variantName ?? item.variantSku ?? "This item";
    const current = returnQuantitiesRef.current;
    const selectedForVariant = orderItems.reduce(
      (sum, otherItem) =>
        otherItem.variantId === item.variantId && otherItem.id !== item.id
          ? sum + (current[otherItem.id] ?? 0)
          : sum,
      0,
    );
    const maxReturn = maxReturnableForItem(
      item,
      returnedByItem.get(item.id) ?? 0,
      selectedForVariant,
    );
    if (maxReturn <= (current[item.id] ?? 0)) {
      throw new Error(`${itemName} has no returnable quantity left.`);
    }
    setReturnQuantities((existing) => ({
      ...existing,
      [item.id]: Math.min(maxReturn, (existing[item.id] ?? 0) + 1),
    }));
  };

  const { scanner, state: scanState } = useBarcodeScanner({
    capture: "window",
    onResolve: handleResolved,
  });

  useScanFailureToast(scanState);

  if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
    return (
      <ReturnState
        title="Invalid purchase order"
        message="The purchase order ID is invalid."
      />
    );
  }
  if (isLoading) {
    return (
      <ReturnState
        title="Loading purchase order"
        message="Loading purchase items and previous returns..."
      />
    );
  }
  if (!purchaseOrder) {
    return (
      <ReturnState
        title="Purchase order not found"
        message={error ?? "This purchase order could not be found."}
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

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <section className="overflow-hidden rounded-xl border bg-background shadow-sm">
          <div className="border-b p-4 md:p-5">
            <div className="flex items-center gap-3">
              <PackageMinus className="size-5 text-primary" />
              <div>
                <h2 className="font-semibold">Eligible purchase items</h2>
                <p className="text-sm text-muted-foreground">
                  Only received units that are still in stock can be returned.
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
          <ReturnItemsTable
            orderItems={orderItems}
            returnedByItem={returnedByItem}
            returnQuantities={returnQuantities}
            onQuantityChange={updateQuantity}
          />
        </section>

        <SupplierCreditSummary
          cards={returnSummary}
          formatCurrency={formatCurrency}
        >
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
                returnMutation.isPending || requestedItems.length === 0
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
