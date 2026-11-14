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
import { OpenRejectionsPanel } from "../components/receiving/OpenRejectionsPanel";
import { ReceivingPaymentSection } from "../components/receiving/ReceivingPaymentSection";
import type { PaymentsInfoCard } from "../purchase.types";
import {
  receiveItemsFormSchema,
  type ReceiveItemsFormValues,
} from "../schemas/receiveItem.schema";
import { usePurchasesStore } from "../usePurchaseStore";
import { formatCurrency, roundMoney } from "@/features/purchases/utils/formatCurrency";
import { useReceivePurchase } from "../hooks/useReceivePurchase";
import {
  outstandingOf,
  overReceiveInUnitOf,
  outstandingInUnitOf,
} from "../utils/receiveQuantities";
import {
  scanStepInLineUnit,
  unitCostFromBase,
} from "../utils/uom";
import {
  usePurchaseUnitsForVariants,
  type PurchaseUnitOption,
} from "../hooks/usePurchaseUnits";
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

  // UOM (migration 0062): only the variants whose PO lines were ordered in
  // a packaging unit need unit options — legacy documents fetch nothing.
  const uomVariantIds = useMemo(
    () =>
      [
        ...new Set(
          receiveItems
            .filter((item) => item.uomConversionId != null)
            .map((item) => item.variantId),
        ),
      ].sort((a, b) => a - b),
    [receiveItems],
  );
  const { byVariant: unitsByVariant, loading: unitsLoading } =
    usePurchaseUnitsForVariants(uomVariantIds);

  /**
   * The unit each line's quantities are entered in. The PO line's own unit
   * is the default; a packaging unit that has since been deactivated falls
   * back to the BASE unit (the line stays receivable — its stored figures
   * are base). Serial-tracked lines always receive per piece in the base
   * unit, since serials are per-piece.
   */
  const lineUnitDefaults = useMemo(() => {
    const map = new Map<
      number,
      { conversionId: number | null; factor: number; unitName: string; orderedUnitUnavailable: boolean }
    >();
    for (const item of receiveItems) {
      const units = unitsByVariant.get(item.variantId);
      const baseUnitName = item.productUnit || "units";
      if (item.trackingType === "serial") {
        map.set(item.id, {
          conversionId: null,
          factor: 1,
          unitName: baseUnitName,
          orderedUnitUnavailable: item.uomConversionId != null,
        });
        continue;
      }
      if (item.uomConversionId == null) {
        map.set(item.id, {
          conversionId: null,
          factor: 1,
          unitName: baseUnitName,
          orderedUnitUnavailable: false,
        });
        continue;
      }
      const ordered = units?.find(
        (unit) => unit.uomConversionId === item.uomConversionId,
      );
      map.set(
        item.id,
        ordered
          ? {
              conversionId: ordered.uomConversionId,
              factor: ordered.conversionFactor,
              unitName: ordered.unitName,
              orderedUnitUnavailable: false,
            }
          : {
              conversionId: null,
              factor: 1,
              unitName: baseUnitName,
              orderedUnitUnavailable: true,
            },
      );
    }
    return map;
  }, [receiveItems, unitsByVariant]);

  // Stable signature of the per-line unit defaults: the form prefill only
  // (re)runs when a real unit/factor resolves, never on unrelated refetches.
  const unitDefaultsSignature = useMemo(
    () =>
      receiveItems
        .map((item) => {
          const unit = lineUnitDefaults.get(item.id);
          return unit
            ? `${item.id}:${unit.conversionId ?? "base"}:${unit.factor}`
            : `${item.id}:?`;
        })
        .join("|"),
    [receiveItems, lineUnitDefaults],
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
    // UOM lines wait for their unit options so the prefill can be expressed
    // in the ordered unit; base-only orders reset immediately.
    if (uomVariantIds.length > 0 && unitsLoading) return;
    form.reset({
      purchaseId,
      items: receiveItems.map((item) => {
        const unit = lineUnitDefaults.get(item.id);
        const factor = unit?.factor ?? 1;
        const outstanding = outstandingOf(item);
        return {
          itemId: item.id,
          trackingType:
            item.trackingType === "batch" || item.trackingType === "serial"
              ? item.trackingType
              : "none",
          // Received in the SELECTED unit when a package unit applies.
          receiveNow: unit?.conversionId
            ? outstandingInUnitOf(item, factor)
            : Math.max(0, outstanding),
          rejectedQuantity: 0,
          // Per selected unit: the PO's entered price for its own unit,
          // otherwise the base cost scaled by the factor.
          unitCost:
            unit?.conversionId && item.enteredUnitPrice != null
              ? Number(item.enteredUnitPrice) || 0
              : unitCostFromBase(Number(item.unitCost) || 0, factor),
          sellingPrice: Number(item.sellingPrice) || 0,
          batches: [],
          serialNumbers: [],
          ...(unit?.conversionId
            ? { uomConversionId: unit.conversionId }
            : { uomConversionId: null }),
        };
      }),
      paymentAmount: 0,
      paymentMethod: "cash",
      paymentNotes: "",
    });
  }, [
    form.reset,
    purchaseId,
    purchaseOrder,
    receiveItems,
    unitDefaultsSignature,
    unitsLoading,
    uomVariantIds,
  ]);

  /**
   * UOM: switch a line's entering unit. The quantities are re-expressed in
   * the new unit (receiveNow from the outstanding remainder, cost scaled to
   * the factor); batch rows are cleared because their quantities were
   * entered in the previous unit.
   */
  const handleLineUnitChange = (
    index: number,
    item: (typeof receiveItems)[number],
    unit: PurchaseUnitOption,
  ) => {
    form.setValue(`items.${index}.uomConversionId`, unit.uomConversionId, {
      shouldDirty: true,
    });
    form.setValue(
      `items.${index}.receiveNow`,
      unit.uomConversionId === null
        ? outstandingOf(item)
        : outstandingInUnitOf(item, unit.conversionFactor),
      { shouldDirty: true, shouldValidate: true },
    );
    form.setValue(
      `items.${index}.unitCost`,
      unit.uomConversionId != null &&
        unit.uomConversionId === item.uomConversionId &&
        item.enteredUnitPrice != null
        ? Number(item.enteredUnitPrice) || 0
        : unitCostFromBase(Number(item.unitCost) || 0, unit.conversionFactor),
      { shouldDirty: true },
    );
    form.setValue(`items.${index}.rejectedQuantity`, 0, {
      shouldDirty: true,
      shouldValidate: true,
    });
    form.setValue(`items.${index}.batches`, [], { shouldDirty: true });
  };

  const receivingTotal = roundMoney(
    watchedItems.reduce(
      (sum, item) =>
        sum + (Number(item.receiveNow) || 0) * (Number(item.unitCost) || 0),
      0,
    ),
  );
  const hasItemsToReceive = watchedItems.some(
    (item) => Number(item.receiveNow) > 0,
  );
  // Client-side estimate of the payable limit — the backend recomputes this
  // from the actual batch costs and is authoritative; a rejected amount
  // surfaces as a 400 toast. The estimate mirrors the backend's
  // invoice-adjusted received basis (D1-01): batch value alone excludes line
  // tax/discount and the order-level charges, so a fully received purchase
  // must be payable in full. Rounded to the 2-dp money grid: raw float sums
  // land just below the real balance (320.33999999999997) and clamp the
  // final ৳0.34 payment.
  const invoiceReceivedValue = (() => {
    let orderedLineValue = 0;
    let receivedLineValue = 0;
    for (const item of receiveItems) {
      const orderedQty = Number(item.quantity) || 0;
      if (orderedQty <= 0) continue;
      const unitCost = Number(item.unitCost) || 0;
      const lineDiscount = Number(item.discount) || 0;
      const lineTax = Number(item.tax) || 0;
      const lineValue = orderedQty * unitCost - lineDiscount + lineTax;
      if (lineValue <= 0) continue;
      orderedLineValue += lineValue;
      const receivedQty = Math.min(
        (Number(item.receivedQuantity) || 0) + (Number(item.receiveNow) || 0),
        orderedQty,
      );
      if (receivedQty <= 0) continue;
      const share = receivedQty / orderedQty;
      receivedLineValue +=
        receivedQty * unitCost + share * (lineTax - lineDiscount);
    }
    const orderCharges =
      Number(purchaseOrder?.tax ?? 0) +
      Number(purchaseOrder?.shippingCost ?? 0) -
      Number(purchaseOrder?.discount ?? 0);
    const chargeShare =
      orderedLineValue > 0
        ? (receivedLineValue / orderedLineValue) * orderCharges
        : 0;
    return roundMoney(Math.max(0, receivedLineValue + chargeShare));
  })();
  const paymentLimit = roundMoney(
    Math.max(0, Math.min(dueAmount, invoiceReceivedValue - paidAmount)),
  );

  useEffect(() => {
    // Tolerance of half a cent so float noise never truncates a legitimate
    // full-balance payment; the stored value stays on the money grid.
    if (Number(paymentAmount) > paymentLimit + 0.005) {
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
   * Each scan counts one physical unit in the line's SELECTED unit: a box
   * scan adds one box, a piece scan one piece (UOM migration 0062). From
   * the untouched "receive the full remainder" prefill, the first scan
   * resumes at previously received + the scanned amount; manual edits
   * increment as typed. Scans never exceed the outstanding remainder —
   * over-receiving is approved in the discrepancy dialog.
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

    const units = unitsByVariant.get(line.variantId);
    const selectedConversionId =
      Number(form.getValues(`items.${lineIndex}.uomConversionId`)) || null;
    const selectedUnit = selectedConversionId
      ? units?.find((unit) => unit.uomConversionId === selectedConversionId)
      : (units?.[0] ?? null);
    const lineFactor = selectedUnit?.conversionFactor ?? 1;
    const lineUnitName = selectedUnit?.unitName ?? line.productUnit ?? "units";
    const remaining = outstandingInUnitOf(line, lineFactor);
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

    // A package-alias scan counts one PACKAGE; the scanned unit must be an
    // exact multiple of the line's entering unit to be countable.
    const step =
      scanStepInLineUnit(lineFactor, match.unit?.conversionFactor ?? 1) ?? 0;
    if (step <= 0) {
      throw new Error(
        `Scanned ${match.unit?.unitName ?? "barcode"} does not match the line's ${lineUnitName} unit — switch the line's unit to receive it.`,
      );
    }

    const current = Number(form.getValues(`items.${lineIndex}.receiveNow`)) || 0;
    const prefill = lineUnitDefaults.get(line.id);
    const untouchedPrefill = prefill
      ? outstandingInUnitOf(line, prefill.factor)
      : remaining;
    const next =
      current === untouchedPrefill
        ? Math.min(
            remaining,
            Math.floor(Number(line.receivedQuantity || 0) / lineFactor) + step,
          )
        : Math.min(remaining, current + step);
    form.setValue(`items.${lineIndex}.receiveNow`, next, {
      shouldValidate: true,
      shouldDirty: true,
    });
    form.setFocus(`items.${lineIndex}.receiveNow`);
    toast.add({
      type: "success",
      description: `${lineName} — receiving ${next} ${lineUnitName} of ${remaining}`,
    });
  };

  const { scanner, state: scanState } = useBarcodeScanner({
    capture: "window",
    onResolve: handleResolved,
  });

  useScanFailureToast(scanState);

  const onSubmit = async (data: ReceiveItemsFormValues) => {
    // Over-receiving requires a per-line reason — catch it before the
    // round-trip so the offending line can be corrected in its dialog.
    // Quantities are in each line's selected unit, so the check converts
    // both sides to base units first.
    const missingReason = data.items.find((item) => {
      const line = receiveItems.find((entry) => entry.id === item.itemId);
      if (!line) return false;
      const unit = lineUnitDefaults.get(line.id);
      const selectedConversionId = item.uomConversionId ?? null;
      const factor =
        selectedConversionId && selectedConversionId !== unit?.conversionId
          ? (unitsByVariant
              .get(line.variantId)
              ?.find((entry) => entry.uomConversionId === selectedConversionId)
              ?.conversionFactor ?? 1)
          : (unit?.factor ?? 1);
      return (
        overReceiveInUnitOf(line, item.receiveNow, factor) &&
        !item.overReceiveReason?.trim()
      );
    });
    if (missingReason) {
      toast.add({
        type: "error",
        priority: "high",
        description:
          "One or more lines accept more than the outstanding quantity — open Discrepancy… on the line and record the over-receiving reason.",
      });
      return;
    }
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
                unitsByVariant={unitsByVariant}
                onUnitChange={handleLineUnitChange}
              />
              </>
            ) : (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No items were found on this purchase order.
              </p>
            )}
          </section>

          <OpenRejectionsPanel purchaseId={purchaseId} />

          <ReceivingPaymentSection
            form={form}
            paymentLimit={paymentLimit}
            receivingTotal={receivingTotal}
            paidAmount={paidAmount}
            dueAmount={dueAmount}
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
