import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  ArrowLeft,
  ClipboardList,
  PackageMinus,
  RotateCcw,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SummaryCard } from "@/features/purchases/components/purchasesReceiveItems/SummaryCard";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import type {
  PaymentsInfoCard,
  PurchasesItems,
} from "@/features/purchases/purchase.types";
import { usePurchasesStore } from "@/features/purchases/usePurchaseStore";

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-BD", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);

const getReturnUnitPrice = (item: PurchasesItems) => {
  const quantity = Number(item.quantity);
  if (quantity <= 0) return 0;
  const lineTotal =
    quantity * Number(item.unitCost) -
    Number(item.discount || 0) +
    Number(item.tax || 0);
  return Math.max(0, Number((lineTotal / quantity).toFixed(2)));
};

export const PurchaseViewItems = () => {
  const { id } = useParams();
  const purchaseId = Number(id);
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
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
  const purchaseReturn = usePurchasesStore((state) => state.purchaseReturn);

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
  const totalRefund = orderItems.reduce(
    (sum, item) =>
      sum + (returnQuantities[item.id] ?? 0) * getReturnUnitPrice(item),
    0,
  );
  const receivedValue = orderItems.reduce(
    (sum, item) =>
      sum + Number(item.receivedQuantity || 0) * getReturnUnitPrice(item),
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

  const updateQuantity = (item: PurchasesItems, value: number) => {
    const alreadyReturned = returnedByItem.get(item.id) ?? 0;
    const remainingReceived = Math.max(
      0,
      Number(item.receivedQuantity) - alreadyReturned,
    );
    const alreadySelectedForVariant = orderItems.reduce(
      (sum, otherItem) =>
        otherItem.variantId === item.variantId && otherItem.id !== item.id
          ? sum + (returnQuantities[otherItem.id] ?? 0)
          : sum,
      0,
    );
    const availableStock = Math.max(
      0,
      Number(item.availableStock ?? 0) - alreadySelectedForVariant,
    );
    const maxReturn = Math.floor(Math.min(remainingReceived, availableStock));
    const quantity = Math.min(Math.max(0, Math.floor(value)), maxReturn);
    setReturnQuantities((current) => ({ ...current, [item.id]: quantity }));
  };

  const handleSubmit = async () => {
    if (!purchaseOrder || requestedItems.length === 0 || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await createEntityPromiseToast({
        data: {
          orderId: purchaseId,
          reason: reason.trim() || undefined,
          changedItems: requestedItems,
        },
        apiCall: purchaseReturn,
        entityName: "Purchase return",
        getSuccessMessage: (response) =>
          `${response.message} Total: ৳ ${formatCurrency(response.data.totalAmount)}`,
      });
      await Promise.all([
        getPurchases(),
        getPurchaseItems(),
        getPurchasesReturnItems(),
      ]);
      navigate("/purchases-list");
    } catch {
      // The toast reports the API error; keep the return form open for correction.
    } finally {
      setIsSubmitting(false);
    }
  };

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

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {orderSummary.map((card) => (
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
          </div>
          {orderItems.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Product</th>
                    <th className="px-3 py-3 font-medium">Unit</th>
                    <th className="px-3 py-3 text-right font-medium">
                      Ordered
                    </th>
                    <th className="px-3 py-3 text-right font-medium">
                      Received
                    </th>
                    <th className="px-3 py-3 text-right font-medium">
                      Returned
                    </th>
                    <th className="px-3 py-3 text-right font-medium">
                      Available stock
                    </th>
                    <th className="w-32 px-3 py-3 font-medium">Return qty</th>
                    <th className="px-4 py-3 text-right font-medium">
                      Unit cost
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Return total
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {orderItems.map((item) => {
                    const returned = returnedByItem.get(item.id) ?? 0;
                    const remainingReceived = Math.max(
                      0,
                      Number(item.receivedQuantity) - returned,
                    );
                    const selectedForVariant = orderItems.reduce(
                      (sum, otherItem) =>
                        otherItem.variantId === item.variantId &&
                        otherItem.id !== item.id
                          ? sum + (returnQuantities[otherItem.id] ?? 0)
                          : sum,
                      0,
                    );
                    const availableStock = Math.max(
                      0,
                      Number(item.availableStock ?? 0) - selectedForVariant,
                    );
                    const maxReturn = Math.floor(
                      Math.min(remainingReceived, availableStock),
                    );
                    const quantity = returnQuantities[item.id] ?? 0;
                    return (
                      <tr key={item.id}>
                        <td className="px-4 py-3">
                          <p className="font-medium">
                            {item.variantName || item.productName}
                          </p>
                          {item.variantOptions && item.variantName ? (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {item.productName} · {item.variantOptions}
                            </p>
                          ) : null}
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {item.trackingType} tracking
                          </p>
                        </td>
                        <td className="px-3 py-3 text-muted-foreground">
                          {item.productUnit || "—"}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {item.quantity}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {item.receivedQuantity}
                        </td>
                        <td className="px-3 py-3 text-right">{returned}</td>
                        <td className="px-3 py-3 text-right">
                          {availableStock}
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            aria-label={`Return quantity for ${item.variantName || item.productName}`}
                            type="number"
                            min={0}
                            max={maxReturn}
                            step={1}
                            value={quantity}
                            disabled={maxReturn <= 0}
                            onChange={(event) =>
                              updateQuantity(
                                item,
                                Number(event.target.value) || 0,
                              )
                            }
                            className="h-9"
                          />
                          <span className="mt-1 block text-xs text-muted-foreground">
                            Max {maxReturn}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right">
                          ৳ {formatCurrency(getReturnUnitPrice(item))}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right font-medium">
                          ৳{" "}
                          {formatCurrency(quantity * getReturnUnitPrice(item))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-8 text-center">
              <ClipboardList className="mx-auto size-9 text-muted-foreground/50" />
              <p className="mt-3 font-medium">No items on this order</p>
            </div>
          )}
        </section>

        <section className="space-y-4 rounded-xl border bg-background p-4 shadow-sm md:p-5">
          <div className="flex items-center gap-3">
            <Wallet className="size-5 text-primary" />
            <div>
              <h2 className="font-semibold">Return summary</h2>
              <p className="text-sm text-muted-foreground">
                Processing updates inventory and records a supplier credit.
              </p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {returnSummary.map((card) => (
              <SummaryCard
                key={card.title}
                card={card}
                formatCurrency={formatCurrency}
              />
            ))}
          </div>

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
              disabled={isSubmitting || requestedItems.length === 0}
            >
              <RotateCcw />
              {isSubmitting
                ? "Processing return..."
                : "Process purchase return"}
            </Button>
          </div>
        </section>
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
