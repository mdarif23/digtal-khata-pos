import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, PackageCheck, ReceiptText } from "lucide-react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { toast } from "@/components/ui/toast";
import { ItemsReceiveTable } from "../components/purchasesReceiveItems/ItemsReceiveTable";
import { ReceivingSummary } from "../components/receiving/ReceivingSummary";
import { ReceivingPaymentSection } from "../components/receiving/ReceivingPaymentSection";
import type { PaymentsInfoCard } from "../purchase.types";
import {
  receiveItemsFormSchema,
  type ReceiveItemsFormValues,
} from "../schemas/receiveItem.schema";
import { usePurchasesStore } from "../usePurchaseStore";
import { formatCurrency } from "@/features/purchases/utils/formatCurrency";
import { useReceivePurchase } from "../hooks/useReceivePurchase";
import { useScanFailureToast } from "@/features/barcodes/scanning/useScanFailureToast";
import type { LookupMatch } from "@/features/barcodes/barcode.api";
import { useBarcodeScanner } from "@/features/barcodes/scanning/useBarcodeScanner";
import { BarcodeScannerInput } from "@/features/barcodes/scanning/BarcodeScannerInput";
import { BarcodeScanFeedback } from "@/features/barcodes/scanning/BarcodeScanFeedback";


export const ReceiveItems = () => {
  const { id } = useParams();
  const purchaseId = Number(id);
  const navigate = useNavigate();
  const [isLoadingOrder, setIsLoadingOrder] = useState(true);
  const purchases = usePurchasesStore((state) => state.purchases);
  const purchasesItems = usePurchasesStore((state) => state.purchasesItems);
  const loading = usePurchasesStore((state) => state.loading);
  const error = usePurchasesStore((state) => state.error);
  const getPurchases = usePurchasesStore((state) => state.getPurchases);
  const getPurchaseItems = usePurchasesStore((state) => state.getPurchaseItems);
  const receiveMutation = useReceivePurchase();

  useEffect(() => {
    if (!Number.isInteger(purchaseId) || purchaseId <= 0) return;
    setIsLoadingOrder(true);
    Promise.all([getPurchases(), getPurchaseItems()]).finally(() =>
      setIsLoadingOrder(false),
    );
  }, [getPurchaseItems, getPurchases, purchaseId]);

  const purchaseOrder = purchases.allPurchases.find(
    (purchase) => purchase.id === purchaseId,
  );
  const receiveItems = useMemo(
    () => purchasesItems.filter((item) => item.purchaseId === purchaseId),
    [purchaseId, purchasesItems],
  );

  const form = useForm<ReceiveItemsFormValues>({
    resolver: zodResolver(receiveItemsFormSchema),
    defaultValues: {
      purchaseId,
      items: [],
      paymentAmount: 0,
      paymentMethod: "cash",
      paymentNotes: "",
    },
  });
  const watchedItems = useWatch({ control: form.control, name: "items" }) ?? [];
  const paymentAmount =
    useWatch({ control: form.control, name: "paymentAmount" }) ?? 0;
  const paidAmount = Number(purchaseOrder?.paidAmount ?? 0);
  const dueAmount = Number(purchaseOrder?.dueAmount ?? 0);
  useEffect(() => {
    if (!purchaseOrder || receiveItems.length === 0) return;
    form.reset({
      purchaseId,
      items: receiveItems.map((item) => ({
        itemId: item.id,
        trackingType:
          item.trackingType === "batch" || item.trackingType === "serial"
            ? item.trackingType
            : "none",
        receiveNow: Math.max(
          0,
          Number(item.quantity) - Number(item.receivedQuantity),
        ),
        unitCost: Number(item.unitCost) || 0,
        sellingPrice: Number(item.sellingPrice) || 0,
        batches: [],
        serialNumbers: [],
      })),
      paymentAmount: 0,
      paymentMethod: "cash",
      paymentNotes: "",
    });
  }, [form.reset, purchaseId, purchaseOrder, receiveItems]);

  const receivingTotal = watchedItems.reduce(
    (sum, item) =>
      sum + (Number(item.receiveNow) || 0) * (Number(item.unitCost) || 0),
    0,
  );
  const hasItemsToReceive = watchedItems.some(
    (item) => Number(item.receiveNow) > 0,
  );
  // Client-side estimate of the payable limit (order cost × received units).
  // The backend recomputes this from the actual batch costs and is
  // authoritative — a rejected amount surfaces as a 400 toast.
  const previouslyReceivedValue = receiveItems.reduce(
    (sum, item) =>
      sum + Number(item.receivedQuantity || 0) * Number(item.unitCost || 0),
    0,
  );
  const paymentLimit = Math.max(
    0,
    Math.min(dueAmount, previouslyReceivedValue + receivingTotal - paidAmount),
  );

  useEffect(() => {
    if (Number(paymentAmount) > paymentLimit) {
      form.setValue("paymentAmount", paymentLimit, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
  }, [form.setValue, paymentAmount, paymentLimit]);

  const receiveSummary: PaymentsInfoCard[] = [
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
      title: "Balance due",
      total: dueAmount,
    },
  ];

  /**
   * Module scan handler — the scanner service only IDENTIFIES a barcode;
   * receiving rules (on-this-PO check, remaining cap, batch/serial routing)
   * live here. Throwing surfaces the failure as an error scan.
   *
   * Each scan counts one physical unit: from the untouched "receive the
   * full remainder" prefill, the first scan resumes at previously received
   * + 1 (Ordered 20 · received 5 · scan ×3 → receiving 8). Manual edits
   * increment as typed.
   */
  const handleResolved = (match: LookupMatch) => {
    const lineIndex = receiveItems.findIndex(
      (item) => item.variantId === match.variantId,
    );
    const line = lineIndex >= 0 ? receiveItems[lineIndex] : undefined;
    if (!line) {
      throw new Error("This item is not on this purchase order.");
    }
    const lineName =
      line.variantName ?? line.variantSku ?? `line ${lineIndex + 1}`;
    const remaining = Math.max(
      0,
      Number(line.quantity) - Number(line.receivedQuantity),
    );
    if (remaining <= 0) {
      throw new Error(`${lineName} is already fully received.`);
    }

    if (line.trackingType === "batch" || line.trackingType === "serial") {
      // Quantities for tracked lines are assigned in their dialogs —
      // scanning just jumps to the line.
      form.setFocus(`items.${lineIndex}.receiveNow`);
      toast.add({
        type: "success",
        description: `Found: ${lineName} — assign its ${
          line.trackingType === "batch" ? "batches" : "serials"
        } on the line.`,
      });
      return;
    }

    const current = Number(form.getValues(`items.${lineIndex}.receiveNow`)) || 0;
    const next =
      current === remaining
        ? Math.min(remaining, Number(line.receivedQuantity || 0) + 1)
        : Math.min(remaining, current + 1);
    form.setValue(`items.${lineIndex}.receiveNow`, next, {
      shouldValidate: true,
      shouldDirty: true,
    });
    form.setFocus(`items.${lineIndex}.receiveNow`);
    toast.add({
      type: "success",
      description: `${lineName} — receiving ${next} of ${line.quantity}`,
    });
  };

  const { scanner, state: scanState } = useBarcodeScanner({
    capture: "window",
    onResolve: handleResolved,
  });

  useScanFailureToast(scanState);

  const onSubmit = async (data: ReceiveItemsFormValues) => {
    try {
      const result = await createEntityPromiseToast({
        data,
        apiCall: (values) => receiveMutation.mutateAsync(values),
        entityName: "Receive purchase",
        getSuccessMessage: (response) => response.message,
      });
      // Store/query refreshes happen in useReceivePurchase's onSuccess
      // (purchases, products, landed-cost, due-management). The landed-cost
      // adjustment notice is rendered by the list page from router state.
      navigate("/purchases-list", {
        state: {
          receiveNotice: {
            purchaseId,
            landedCost: result.data.landedCost,
          },
        },
      });
    } catch {
      // The toast reports the API error; keep the form open so it can be corrected.
    }
  };

  if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
    return (
      <ReceiveState
        title="Invalid purchase order"
        message="The purchase order ID is invalid."
      />
    );
  }

  if ((isLoadingOrder || loading) && !purchaseOrder) {
    return (
      <ReceiveState
        title="Loading purchase order"
        message="Loading the order and its items..."
      />
    );
  }

  if (!purchaseOrder) {
    return (
      <ReceiveState
        title="Purchase order not found"
        message={error ?? "This purchase order could not be found."}
      />
    );
  }

  if (purchaseOrder.status === "received") {
    return (
      <ReceiveState
        title="Order already received"
        message="All items on this purchase order have already been received."
      />
    );
  }

  return (
    <div className="min-h-[calc(100vh-1rem)] bg-muted/30 p-4 md:p-6">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Button
              nativeButton={false}
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
              Receive purchase items
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {purchaseOrder.supplierName || "Walk-in purchase"} ·{" "}
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

        <ReceivingSummary
          cards={receiveSummary}
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

        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="space-y-6"
          noValidate
        >
          <section className="overflow-hidden rounded-xl border bg-background shadow-sm">
            <div className="border-b p-4 md:p-5">
              <div className="flex items-center gap-3">
                <PackageCheck className="size-5 text-primary" />
                <div>
                  <h2 className="font-semibold">Items to receive</h2>
                  <p className="text-sm text-muted-foreground">
                    Enter quantities, confirm costs, and add traceability
                    details.
                  </p>
                </div>
              </div>
            </div>
            {receiveItems.length ? (
              <>
              <div className="space-y-2 rounded-lg border bg-background px-3 py-2">
                <BarcodeScannerInput
                  scanner={scanner}
                  placeholder="Scan a barcode to count it in…"
                  aria-label="Scan barcode to receive a purchase line"
                />
                <BarcodeScanFeedback state={scanState} />
              </div>
              <ItemsReceiveTable
                receivePurchasesItems={receiveItems}
                form={form}
              />
              </>
            ) : (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No items were found on this purchase order.
              </p>
            )}
          </section>

          <ReceivingPaymentSection
            form={form}
            paymentLimit={paymentLimit}
            receivingTotal={receivingTotal}
            paidAmount={paidAmount}
            dueAmount={dueAmount}
            formatCurrency={formatCurrency}
          />

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
              type="submit"
              disabled={
                form.formState.isSubmitting ||
                receiveItems.length === 0 ||
                (watchedItems.every((item) => Number(item.receiveNow) <= 0) &&
                  Number(paymentAmount) <= 0)
              }
            >
              <ReceiptText />
              {form.formState.isSubmitting
                ? "Saving receipt..."
                : hasItemsToReceive
                  ? "Receive items and update stock"
                  : "Record payment"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

function ReceiveState({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex min-h-96 flex-col items-center justify-center px-6 text-center">
      <PackageCheck className="size-10 text-muted-foreground/50" />
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
