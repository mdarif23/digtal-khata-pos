import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, PackageCheck, ReceiptText, Wallet } from "lucide-react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { toast } from "@/components/ui/toast";
import { Barcode } from "lucide-react";
import { SummaryCard } from "../components/purchasesReceiveItems/SummaryCard";
import { ItemsReceiveTable } from "../components/purchasesReceiveItems/ItemsReceiveTable";
import type { PaymentsInfoCard } from "../purchase.types";
import {
  receiveItemsFormSchema,
  type ReceiveItemsFormValues,
} from "../schemas/receiveItem.schema";
import { usePurchasesStore } from "../usePurchaseStore";
import type { LookupMatch } from "@/features/barcodes/barcode.api";
import { useBarcodeScanner } from "@/features/barcodes/scanning/useBarcodeScanner";
import { BarcodeScannerInput } from "@/features/barcodes/scanning/BarcodeScannerInput";
import { BarcodeScanFeedback } from "@/features/barcodes/scanning/BarcodeScanFeedback";

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-BD", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);

const paymentMethods = [
  { label: "Cash", value: "cash" },
  { label: "Bank transfer", value: "bank_transfer" },
  { label: "Cheque", value: "cheque" },
  { label: "Card", value: "card" },
  { label: "Other", value: "other" },
] as const;

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
  const createReceivePurchase = usePurchasesStore(
    (state) => state.createReceivePurchase,
  );

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
  const previouslyReceivedValue = receiveItems.reduce(
    (sum, item) =>
      sum + Number(item.receivedQuantity || 0) * Number(item.unitCost || 0),
    0,
  );
  const paymentLimit = Math.max(
    0,
    Math.min(dueAmount, previouslyReceivedValue + receivingTotal - paidAmount),
  );
  const newBalance = Math.max(0, dueAmount - Number(paymentAmount || 0));

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

  const paymentSummary: PaymentsInfoCard[] = [
    {
      bg: "bg-amber-50",
      circleBg: "bg-amber-500",
      title: "Receiving now",
      total: receivingTotal,
    },
    {
      bg: "bg-emerald-50",
      circleBg: "bg-emerald-500",
      title: "Previously paid",
      total: paidAmount,
    },
    {
      bg: "bg-blue-50",
      circleBg: "bg-blue-500",
      title: "Maximum payable now",
      total: paymentLimit,
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

  // Scan outcome → toast (spec §16: never silently ignore failed scans).
  const lastHandledEventId = useRef(0);
  useEffect(() => {
    const event = scanState.last;
    if (!event || event.id <= lastHandledEventId.current) return;
    lastHandledEventId.current = event.id;
    if (event.status === "not_found") {
      toast.add({
        type: "error",
        description: "No product matches that barcode.",
      });
    } else if (event.status === "ambiguous") {
      toast.add({
        type: "error",
        description:
          event.detail ?? "That barcode matches more than one product.",
        priority: "high",
      });
    } else if (event.status === "error") {
      toast.add({
        type: "error",
        description: event.detail ?? "Scan failed.",
        priority: "high",
      });
    }
  }, [scanState.last]);

  const onSubmit = async (data: ReceiveItemsFormValues) => {
    try {
      await createEntityPromiseToast({
        data,
        apiCall: createReceivePurchase,
        entityName: "Receive purchase",
        getSuccessMessage: (response) => response.data.message,
      });
      await Promise.all([getPurchases(), getPurchaseItems()]);
      navigate("/purchases-list");
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

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {receiveSummary.map((card) => (
            <SummaryCard
              key={card.title}
              card={card}
              formatCurrency={formatCurrency}
            />
          ))}
        </section>

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

          <section className="space-y-4 rounded-xl border bg-background p-4 shadow-sm md:p-5">
            <div className="flex items-center gap-3">
              <Wallet className="size-5 text-primary" />
              <div>
                <h2 className="font-semibold">Payment for this receipt</h2>
                <p className="text-sm text-muted-foreground">
                  Payment is optional. The amount is limited to the received
                  value and outstanding balance.
                </p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {paymentSummary.map((card) => (
                <SummaryCard
                  key={card.title}
                  card={card}
                  formatCurrency={formatCurrency}
                />
              ))}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1.5 text-sm font-medium">
                Payment amount
                <Controller
                  control={form.control}
                  name="paymentAmount"
                  render={({ field, fieldState }) => (
                    <>
                      <Input
                        {...field}
                        value={field.value ?? 0}
                        type="number"
                        min={0}
                        max={paymentLimit}
                        step="0.01"
                        onChange={(event) => {
                          const amount = Number(event.target.value);
                          field.onChange(
                            Number.isFinite(amount)
                              ? Math.min(Math.max(0, amount), paymentLimit)
                              : 0,
                          );
                        }}
                        aria-invalid={fieldState.invalid}
                      />
                      <span className="text-xs text-muted-foreground">
                        Maximum payable: ৳ {formatCurrency(paymentLimit)}
                      </span>
                      {fieldState.error && (
                        <span className="block text-xs text-destructive">
                          {fieldState.error.message}
                        </span>
                      )}
                    </>
                  )}
                />
              </label>

              <label className="space-y-1.5 text-sm font-medium">
                Payment method
                <select
                  {...form.register("paymentMethod")}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {paymentMethods.map((method) => (
                    <option key={method.value} value={method.value}>
                      {method.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block space-y-1.5 text-sm font-medium">
              Payment notes{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
              <textarea
                {...form.register("paymentNotes")}
                rows={2}
                maxLength={300}
                placeholder="Reference number or payment note"
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
              />
            </label>

            <div className="flex flex-wrap justify-between gap-3 rounded-lg bg-muted/50 p-4 text-sm">
              <div>
                <p className="text-muted-foreground">
                  Outstanding before payment
                </p>
                <p className="mt-1 font-medium">
                  ৳ {formatCurrency(dueAmount)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Paying now</p>
                <p className="mt-1 font-medium">
                  ৳ {formatCurrency(Number(paymentAmount) || 0)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Balance after payment</p>
                <p className="mt-1 text-lg font-semibold">
                  ৳ {formatCurrency(newBalance)}
                </p>
              </div>
            </div>

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
          </section>
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
