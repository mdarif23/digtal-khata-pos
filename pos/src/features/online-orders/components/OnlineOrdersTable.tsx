import { formatCurrency, formatDateTime } from "@/features/reports/utils/reportUtils";
import { StatusBadge } from "@/features/reports/components/StatusBadge";
import {
  CHANNEL_LABELS,
  type OnlineOrderRow,
} from "../types/onlineOrders.types";
import { OrderStatusBadge } from "./OrderStatusBadge";

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
        <p className="text-sm font-medium text-rose-700">
          Unable to load online orders.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-100"
        >
          Try again
        </button>
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
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            {columns.map((c) => (
              <th key={c} className="px-3 py-2.5">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            [0, 1, 2, 3].map((i) => (
              <tr key={i} className="border-b border-slate-100">
                <td colSpan={columns.length} className="px-3 py-3">
                  <div className="h-5 animate-pulse rounded bg-slate-100" />
                </td>
              </tr>
            ))
          ) : !orders || orders.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="h-32 px-3 text-center text-slate-500"
              >
                No online orders match the current filters.
              </td>
            </tr>
          ) : (
            orders.map((order) => (
              <tr
                key={order.id}
                className="cursor-pointer border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50"
                onClick={() => onOpenOrder(order.id)}
              >
                <td className="px-3 py-2.5 font-medium text-slate-800">
                  {order.invoiceNumber}
                </td>
                <td className="px-3 py-2.5 text-slate-600">
                  {order.externalOrderNumber ?? "—"}
                </td>
                <td className="px-3 py-2.5 text-slate-600">
                  {formatDateTime(order.createdAt)}
                </td>
                <td className="px-3 py-2.5 text-slate-700">
                  {order.customerName ?? "—"}
                </td>
                <td className="px-3 py-2.5 text-slate-600">
                  {CHANNEL_LABELS[order.channel] ?? order.channel}
                </td>
                <td className="px-3 py-2.5 text-center text-slate-600">
                  {order.itemsCount}
                </td>
                <td className="px-3 py-2.5 font-medium text-slate-800">
                  {formatCurrency(order.finalTotal)}
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge status={order.paymentStatus} />
                </td>
                <td className="px-3 py-2.5">
                  <OrderStatusBadge status={order.fulfillmentStatus} />
                </td>
                <td className="px-3 py-2.5 text-slate-600">
                  {order.locationName ?? "—"}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
