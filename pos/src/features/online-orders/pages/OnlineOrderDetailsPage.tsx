import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, PackageOpen, Truck } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermissions } from "@/hooks/usePermissions";
import { formatCurrency, formatDateTime } from "@/lib/format";
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
import { OrderStateBadge, OrderStatusBadge } from "../components/OrderStatusBadge";
import { OrderTimeline } from "../components/OrderTimeline";
import { PackagingSection } from "../components/PackagingSection";
import { ShippingSection } from "../components/ShippingSection";
import { CHANNEL_LABELS, type SalesChannel } from "../types/onlineOrders.types";

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
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
      <PageContainer width="narrow">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </PageContainer>
    );
  }

  if (orderQuery.isError || !order) {
    return (
      <PageContainer width="narrow">
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 p-6 text-center"
        >
          <p className="font-medium text-destructive">
            {orderQuery.isError
              ? "Unable to load this order."
              : "Order not found."}
          </p>
          <Button
            render={<Link to="/online-orders" />}
            variant="outline"
            size="sm"
            className="mt-3"
          >
            Back to online orders
          </Button>
        </div>
      </PageContainer>
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
    <PageContainer>
      <Button
        render={<Link to="/online-orders" />}
        variant="ghost"
        size="sm"
        className="w-fit"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Online orders
      </Button>

      {/* Header */}
      <PageHeader
        title={order.invoiceNumber}
        description={
          <>
            {CHANNEL_LABELS[order.channel as SalesChannel] ?? order.channel}
            {order.externalOrderNumber
              ? ` · external #${order.externalOrderNumber}`
              : ""}{" "}
            · {formatDateTime(order.createdAt)}
          </>
        }
        actions={
          <>
            <OrderStateBadge status={status} />
            <OrderStateBadge status={order.paymentStatus} />
            <OrderStatusBadge status={fulfillment} />
          </>
        }
      />

      {/* Workflow actions */}
      {!isCancelled ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-4 py-3">
          {isPending && hasPermission("orders.confirm") ? (
            <Button
              type="button"
              disabled={confirmOrder.isPending}
              onClick={() =>
                void onAction("Order confirmed", () =>
                  confirmOrder.mutateAsync(orderId),
                )
              }
            >
              Confirm order
            </Button>
          ) : null}
          {isPending && hasPermission("orders.cancel") ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => setCancelOpen(true)}
            >
              Cancel order
            </Button>
          ) : null}
          {isCompleted && fulfillment === "confirmed" && hasPermission("orders.process") ? (
            <Button
              type="button"
              disabled={startProcessing.isPending}
              onClick={() =>
                void onAction("Processing started", () =>
                  startProcessing.mutateAsync(orderId),
                )
              }
            >
              <PackageOpen aria-hidden="true" className="size-4" />
              Start processing
            </Button>
          ) : null}
          {isCompleted &&
          ["processing", "packed"].includes(fulfillment) &&
          hasPermission("orders.ready_to_ship") ? (
            <Button
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
            >
              Mark as ready to ship
            </Button>
          ) : null}
          {isCompleted && fulfillment === "shipped" && hasPermission("orders.deliver") ? (
            <Button
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
            >
              <Truck aria-hidden="true" className="size-4" />
              Mark delivered
            </Button>
          ) : null}
          {unpaid && hasPermission("orders.mark_paid") ? (
            <Button
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
            >
              Record payment collection
            </Button>
          ) : null}
          {isCompleted && fulfillment === "shipped" && unpaid ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setCodOpen(true)}
            >
              Collect COD on delivery
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          This order is cancelled.
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Left column: overview, customer, items */}
        <div className="space-y-5 lg:col-span-2">
          <section className="rounded-lg border border-border bg-card">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
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
                value={<span className="tabular-nums">{formatCurrency(order.subtotal)}</span>}
              />
              <DetailRow
                label="Discount"
                value={<span className="tabular-nums">{formatCurrency(order.discount)}</span>}
              />
              <DetailRow
                label="VAT"
                value={<span className="tabular-nums">{formatCurrency(order.vat)}</span>}
              />
              <DetailRow
                label="Delivery charge"
                value={<span className="tabular-nums">{formatCurrency(order.deliveryFee)}</span>}
              />
              <DetailRow
                label="Order total"
                value={<span className="tabular-nums">{formatCurrency(order.finalTotal)}</span>}
              />
              <DetailRow
                label="Due"
                value={<span className="tabular-nums">{formatCurrency(order.dueAmount)}</span>}
              />
            </div>
            {order.note ? (
              <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                Note: {order.note}
              </p>
            ) : null}
          </section>

          <section className="rounded-lg border border-border bg-card">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
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
                <span className="text-muted-foreground">Shipping address</span>
                <p className="mt-0.5 font-medium text-foreground">
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
                <span className="text-muted-foreground">Delivery instructions</span>
                <p className="mt-0.5 font-medium text-foreground">
                  {order.deliveryInstructions ?? "—"}
                </p>
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-border bg-card">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
              Ordered products
            </h2>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="px-4">Product</TableHead>
                  <TableHead className="px-4">SKU</TableHead>
                  <TableHead className="px-4 text-center">Qty</TableHead>
                  <TableHead className="px-4 text-right">Unit price</TableHead>
                  <TableHead className="px-4 text-right">Line total</TableHead>
                  <TableHead className="px-4 text-center">Stock here</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.items.map((item) => {
                  const stock = snapshot?.items.find(
                    (i) => i.saleItemId === item.id,
                  )?.stockAtLocation;
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="px-4 font-medium text-foreground">
                        {item.variantName || item.productName}
                        {item.variantOptions && item.variantName ? (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {item.productName} · {item.variantOptions}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="px-4 text-muted-foreground">{item.sku}</TableCell>
                      <TableCell className="px-4 text-center tabular-nums">{item.quantity}</TableCell>
                      <TableCell className="px-4 text-right tabular-nums">
                        {formatCurrency(item.sellingPrice)}
                      </TableCell>
                      <TableCell className="px-4 text-right tabular-nums">
                        {formatCurrency(item.lineTotal)}
                      </TableCell>
                      <TableCell className="px-4 text-center tabular-nums">
                        {stock == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : stock < item.quantity ? (
                          <span className="font-medium text-destructive">{stock}</span>
                        ) : (
                          <span className="text-success">{stock}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
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
          <section className="rounded-lg border border-border bg-card">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
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
      <Dialog
        open={codOpen}
        onOpenChange={(open) => {
          if (!open) setCodOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Collect cash on delivery</DialogTitle>
            <DialogDescription>
              Due: {formatCurrency(order.dueAmount)}. Recording the collection
              writes a payment ledger row — it does not change the fulfillment
              state.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Collection method
            <Select
              value={codMethod}
              onValueChange={(value) =>
                setCodMethod(value as (typeof COD_METHODS)[number])
              }
            >
              <SelectTrigger aria-label="Collection method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COD_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCodOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
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
            >
              Record payment only
            </Button>
            <Button
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
            >
              Collect &amp; mark delivered
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

export default OnlineOrderDetailsPage;
