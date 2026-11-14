import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { formatCurrency, formatDateTime } from "@/lib/format";
import {
  CHANNEL_LABELS,
  type OnlineOrderRow,
} from "../types/onlineOrders.types";
import { OrderStateBadge, OrderStatusBadge } from "./OrderStatusBadge";

interface OnlineOrdersTableProps {
  orders: OnlineOrderRow[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onOpenOrder: (orderId: number) => void;
}

/** Server-paginated order list. Sorting/filtering happens on the backend —
 * this table renders exactly one page of results. */
export function OnlineOrdersTable({
  orders,
  isLoading,
  isError,
  onRetry,
  onOpenOrder,
}: OnlineOrdersTableProps) {
  if (isError) {
    return (
      <div
        role="alert"
        className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 py-10 text-center"
      >
        <p className="text-sm font-medium text-destructive">
          Unable to load online orders.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  const columns = [
    "Order #",
    "External",
    "Date",
    "Customer",
    "Channel",
    "Items",
    "Total",
    "Payment",
    "Fulfillment",
    "Location",
  ];

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table className="min-w-[900px]">
        <TableHeader>
          <TableRow className="border-b border-border bg-muted/50 hover:bg-muted/50">
            {columns.map((c) => (
              <TableHead
                key={c}
                className={
                  c === "Total"
                    ? "text-right"
                    : c === "Items"
                      ? "text-center"
                      : undefined
                }
              >
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            [0, 1, 2, 3].map((i) => (
              <TableRow key={i} className="border-b border-border">
                <TableCell colSpan={columns.length}>
                  <div className="h-5 animate-pulse rounded bg-muted" />
                </TableCell>
              </TableRow>
            ))
          ) : !orders || orders.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="py-6">
                <EmptyState
                  title="No online orders match the current filters."
                  className="border-0 bg-transparent"
                />
              </TableCell>
            </TableRow>
          ) : (
            orders.map((order) => (
              <TableRow
                key={order.id}
                className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/40"
                onClick={() => onOpenOrder(order.id)}
              >
                <TableCell className="font-medium text-foreground">
                  {order.invoiceNumber}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {order.externalOrderNumber ?? "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatDateTime(order.createdAt)}
                </TableCell>
                <TableCell className="text-foreground">
                  {order.customerName ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {CHANNEL_LABELS[order.channel] ?? order.channel}
                </TableCell>
                <TableCell className="text-center tabular-nums text-muted-foreground">
                  {order.itemsCount}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums text-foreground">
                  {formatCurrency(order.finalTotal)}
                </TableCell>
                <TableCell>
                  <OrderStateBadge status={order.paymentStatus} />
                </TableCell>
                <TableCell>
                  <OrderStatusBadge status={order.fulfillmentStatus} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {order.locationName ?? "—"}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
