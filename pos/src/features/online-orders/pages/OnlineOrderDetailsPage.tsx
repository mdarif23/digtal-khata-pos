import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, PackageOpen, Truck } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { StatusBadge } from "@/features/reports/components/StatusBadge";
import { usePermissions } from "@/hooks/usePermissions";
import { formatCurrency, formatDateTime } from "@/features/reports/utils/reportUtils";
import {
  useCancelOrder,
  useConfirmOrder,
  useDeliverOrder,
  useMarkOrderPaid,
  useOnlineOrder,
  useOrderFulfillment,
  useOrderTimeline,
  useReadyToShip,
  useStartProcessing,
} from "../hooks/useOnlineOrders";
import { OrderStatusBadge } from "../components/OrderStatusBadge";
import { OrderTimeline } from "../components/OrderTimeline";
import { PackagingSection } from "../components/PackagingSection";
import { ShippingSection } from "../components/ShippingSection";
import { CHANNEL_LABELS, type SalesChannel } from "../types/onlineOrders.types";

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-right font-medium text-slate-800">{value}</span>
    </div>
  );
}

const COD_METHODS = ["cash", "bangla_qr", "card", "sslcommerz"] as const;

/** Order details & fulfillment (module two §5–§7). Payment and fulfillment
 * badges are always independent — shipping never implies payment. */
export function OnlineOrderDetailsPage() {
  const { orderId: orderIdParam } = useParams();
  const orderId = Number(orderIdParam);
  const { hasPermission } = usePermissions();

  const orderQuery = useOnlineOrder(orderId);
  const timelineQuery = useOrderTimeline(orderId);
  const fulfillmentQuery = useOrderFulfillment(orderId);

  const confirmOrder = useConfirmOrder();
  const startProcessing = useStartProcessing();
  const cancelOrder = useCancelOrder();
  const readyToShip = useReadyToShip();
  const deliverOrder = useDeliverOrder();
  const markPaid = useMarkOrderPaid();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [codOpen, setCodOpen] = useState(false);
  const [codMethod, setCodMethod] = useState<(typeof COD_METHODS)[number]>("cash");

  const order = orderQuery.data;
  const snapshot = fulfillmentQuery.data;

  if (orderQuery.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <div className="h-8 w-64 animate-pulse rounded bg-slate-100" />
        <div className="h-48 animate-pulse rounded-lg bg-slate-100" />
        <div className="h-64 animate-pulse rounded-lg bg-slate-100" />
      </div>
    );
  }

  if (orderQuery.isError || !order) {
    return (
      <div className="p-6">
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 p-6 text-center"
        >
          <p className="font-medium text-rose-700">
            {orderQuery.isError
              ? "Unable to load this order."
              : "Order not found."}
          </p>
          <Link
            to="/online-orders"
            className="mt-3 inline-block rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-100"
          >
            Back to online orders
          </Link>
        </div>
      </div>
    );
  }

  const status = order.status;
  const fulfillment = order.fulfillmentStatus;
  const isPending = status === "pending";
  const isCompleted = status === "completed";
  const isCancelled = status === "cancelled";
  const unpaid = order.paymentStatus !== "paid" && isCompleted;

  const onAction = async (
    label: string,
    action: () => Promise<void>,
  ): Promise<void> => {
    try {
      await action();
      toast.add({ type: "success", title: label });
    } catch (err) {
      toast.add({
        type: "error",
        title: `Could not ${label.toLowerCase()}`,
        description:
          err instanceof Error ? err.message : "Unexpected error. Try again.",
      });
    }
  };

  return (
    <div className="space-y-5 p-6">
      <Link
        to="/online-orders"
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" /> Online orders
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">
            {order.invoiceNumber}
          </h1>
          <p className="text-sm text-slate-500">
            {CHANNEL_LABELS[order.channel as SalesChannel] ?? order.channel}
            {order.externalOrderNumber
              ? ` · external #${order.externalOrderNumber}`
              : ""}{" "}
            · {formatDateTime(order.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={status} />
          <StatusBadge status={order.paymentStatus} />
          <OrderStatusBadge status={fulfillment} />
        </div>
      </div>

      {/* Workflow actions */}
      {!isCancelled ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3">
          {isPending && hasPermission("orders.confirm") ? (
            <button
              type="button"
              disabled={confirmOrder.isPending}
              onClick={() =>
                void onAction("Order confirmed", () =>
                  confirmOrder.mutateAsync(orderId),
                )
              }
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Confirm order
            </button>
          ) : null}
          {isPending && hasPermission("orders.cancel") ? (
            <button
              type="button"
              onClick={() => setCancelOpen(true)}
              className="rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-600 hover:bg-rose-50"
            >
              Cancel order
            </button>
          ) : null}
          {isCompleted && fulfillment === "confirmed" && hasPermission("orders.process") ? (
            <button
              type="button"
              disabled={startProcessing.isPending}
              onClick={() =>
                void onAction("Processing started", () =>
                  startProcessing.mutateAsync(orderId),
                )
              }
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              <PackageOpen className="mr-1 inline h-4 w-4" /> Start processing
            </button>
          ) : null}
          {isCompleted &&
          ["processing", "packed"].includes(fulfillment) &&
          hasPermission("orders.ready_to_ship") ? (
            <button
              type="button"
              disabled={readyToShip.isPending || (snapshot?.packages.length ?? 0) === 0}
              title={
                (snapshot?.packages.length ?? 0) === 0
                  ? "Record at least one package first"
                  : undefined
              }
              onClick={() =>
                void onAction("Order is ready to ship", () =>
                  readyToShip.mutateAsync(orderId),
                )
              }
              className="rounded-md bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
            >
              Mark as ready to ship
            </button>
          ) : null}
          {isCompleted && fulfillment === "shipped" && hasPermission("orders.deliver") ? (
            <button
              type="button"
              disabled={deliverOrder.isPending}
              onClick={() =>
                void onAction("Order delivered", () =>
                  deliverOrder.mutateAsync({
                    orderId,
                    payload: unpaid
                      ? { codCollected: false }
                      : {},
                  }),
                )
              }
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Truck className="mr-1 inline h-4 w-4" /> Mark delivered
            </button>
          ) : null}
          {unpaid && hasPermission("orders.mark_paid") ? (
            <button
              type="button"
              disabled={markPaid.isPending}
              onClick={() => {
                if (fulfillment === "shipped") {
                  // COD in transit — collect at delivery with method choice.
                  setCodOpen(true);
                  return;
                }
                void onAction("Payment recorded", () =>
                  markPaid.mutateAsync({ orderId, payload: { method: "cash" } }),
                );
              }}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Record payment collection
            </button>
          ) : null}
          {isCompleted && fulfillment === "shipped" && unpaid ? (
            <button
              type="button"
              onClick={() => setCodOpen(true)}
              className="rounded-md border border-emerald-300 px-3 py-1.5 text-sm text-emerald-700 hover:bg-emerald-50"
            >
              Collect COD on delivery
            </button>
          ) : null}
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
          This order is cancelled.
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Left column: overview, customer, items */}
        <div className="space-y-5 lg:col-span-2">
          <section className="rounded-lg border border-slate-200 bg-white">
            <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-800">
              Order overview
            </h2>
            <div className="grid grid-cols-1 gap-x-8 px-4 py-3 md:grid-cols-2">
              <DetailRow
                label="Channel"
                value={CHANNEL_LABELS[order.channel as SalesChannel] ?? order.channel}
              />
              <DetailRow
                label="External reference"
                value={order.externalOrderId ?? order.externalOrderNumber ?? "—"}
              />
              <DetailRow label="Order date" value={formatDateTime(order.createdAt)} />
              <DetailRow label="Location" value={order.locationName ?? "—"} />
              <DetailRow
                label="Subtotal"
                value={formatCurrency(order.subtotal)}
              />
              <DetailRow label="Discount" value={formatCurrency(order.discount)} />
              <DetailRow label="VAT" value={formatCurrency(order.vat)} />
              <DetailRow
                label="Delivery charge"
                value={formatCurrency(order.deliveryFee)}
              />
              <DetailRow
                label="Order total"
                value={formatCurrency(order.finalTotal)}
              />
              <DetailRow label="Due" value={formatCurrency(order.dueAmount)} />
            </div>
            {order.note ? (
              <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
                Note: {order.note}
              </p>
            ) : null}
          </section>

          <section className="rounded-lg border border-slate-200 bg-white">
            <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-800">
              Customer &amp; shipping address
            </h2>
            <div className="grid grid-cols-1 gap-x-8 px-4 py-3 md:grid-cols-2">
              <DetailRow label="Customer" value={order.customerName ?? "—"} />
              <DetailRow label="Phone" value={order.customerPhone ?? "—"} />
              <DetailRow label="Email" value={order.customerEmail ?? "—"} />
              <DetailRow
                label="Recipient"
                value={
                  order.shippingName
                    ? `${order.shippingName}${order.shippingPhone ? ` · ${order.shippingPhone}` : ""}`
                    : (order.customerName ?? "—")
                }
              />
              <div className="py-1 text-sm">
                <span className="text-slate-500">Shipping address</span>
                <p className="mt-0.5 font-medium text-slate-800">
                  {order.shippingAddress
                    ? [
                        order.shippingAddress,
                        order.shippingArea,
                        order.shippingCity,
                      ]
                        .filter(Boolean)
                        .join(", ")
                    : "Per customer record"}
                </p>
              </div>
              <div className="py-1 text-sm">
                <span className="text-slate-500">Delivery instructions</span>
                <p className="mt-0.5 font-medium text-slate-800">
                  {order.deliveryInstructions ?? "—"}
                </p>
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-800">
              Ordered products
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2">Product</th>
                  <th className="px-4 py-2">SKU</th>
                  <th className="px-4 py-2 text-center">Qty</th>
                  <th className="px-4 py-2 text-right">Unit price</th>
                  <th className="px-4 py-2 text-right">Line total</th>
                  <th className="px-4 py-2 text-center">Stock here</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => {
                  const stock = snapshot?.items.find(
                    (i) => i.saleItemId === item.id,
                  )?.stockAtLocation;
                  return (
                    <tr key={item.id} className="border-t border-slate-100">
                      <td className="px-4 py-2 font-medium text-slate-800">
                        {item.variantName || item.productName}
                        {item.variantOptions && item.variantName ? (
                          <span className="block text-xs font-normal text-slate-500">
                            {item.productName} · {item.variantOptions}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 text-slate-500">{item.sku}</td>
                      <td className="px-4 py-2 text-center">{item.quantity}</td>
                      <td className="px-4 py-2 text-right">
                        {formatCurrency(item.sellingPrice)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {formatCurrency(item.lineTotal)}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {stock == null ? (
                          <span className="text-slate-400">—</span>
                        ) : stock < item.quantity ? (
                          <span className="font-medium text-rose-600">{stock}</span>
                        ) : (
                          <span className="text-emerald-600">{stock}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <PackagingSection
            orderId={orderId}
            fulfillmentStatus={fulfillment}
            snapshot={snapshot}
            canPack={hasPermission("orders.pack")}
          />

          <ShippingSection
            orderId={orderId}
            fulfillmentStatus={fulfillment}
            snapshot={snapshot}
            canShip={hasPermission("orders.ship")}
          />
        </div>

        {/* Right column: timeline */}
        <div className="space-y-5">
          <section className="rounded-lg border border-slate-200 bg-white">
            <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-800">
              Order timeline
            </h2>
            <div className="px-4 py-4">
              <OrderTimeline
                events={timelineQuery.data}
                isLoading={timelineQuery.isLoading}
              />
            </div>
          </section>
        </div>
      </div>

      {/* Cancel dialog */}
      <ConfirmDeleteDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel order"
        description="Reserved stock will be released. This cannot be undone."
        entityName="order"
        onConfirm={async () => {
          await onAction("Order cancelled", async () => {
            await cancelOrder.mutateAsync({
              orderId,
              reason: cancelReason || undefined,
            });
          });
          setCancelReason("");
        }}
      />

      {/* COD collection dialog */}
      {codOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCodOpen(false);
          }}
        >
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-slate-800">
              Collect cash on delivery
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Due: {formatCurrency(order.dueAmount)}. Recording the collection
              writes a payment ledger row — it does not change the fulfillment
              state.
            </p>
            <label className="mt-4 flex flex-col gap-1 text-xs font-medium text-slate-500">
              Collection method
              <select
                value={codMethod}
                onChange={(e) =>
                  setCodMethod(e.target.value as (typeof COD_METHODS)[number])
                }
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {COD_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCodOpen(false)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={markPaid.isPending || deliverOrder.isPending}
                onClick={async () => {
                  setCodOpen(false);
                  await onAction("COD payment collected", () =>
                    deliverOrder.mutateAsync({
                      orderId,
                      payload: {
                        codCollected: true,
                        codMethod,
                      },
                    }),
                  );
                }}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Collect &amp; mark delivered
              </button>
              <button
                type="button"
                disabled={markPaid.isPending || deliverOrder.isPending}
                onClick={async () => {
                  setCodOpen(false);
                  await onAction("Payment recorded", () =>
                    markPaid.mutateAsync({
                      orderId,
                      payload: { method: codMethod },
                    }),
                  );
                }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Record payment only
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default OnlineOrderDetailsPage;
