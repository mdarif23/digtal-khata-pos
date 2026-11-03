import {
  FULFILLMENT_LABELS,
  type FulfillmentState,
} from "../types/onlineOrders.types";

interface OrderStatusBadgeProps {
  status: string | null | undefined;
}

const fulfillmentConfig: Record<string, { label: string; className: string }> = {
  unfulfilled: {
    label: "Unfulfilled",
    className: "bg-slate-50 text-slate-700 border-slate-200",
  },
  confirmed: {
    label: "Confirmed",
    className: "bg-blue-50 text-blue-700 border-blue-200",
  },
  processing: {
    label: "Processing",
    className: "bg-indigo-50 text-indigo-700 border-indigo-200",
  },
  packed: {
    label: "Packed",
    className: "bg-violet-50 text-violet-700 border-violet-200",
  },
  ready_to_ship: {
    label: "Ready to Ship",
    className: "bg-cyan-50 text-cyan-700 border-cyan-200",
  },
  shipped: {
    label: "Shipped",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
  delivered: {
    label: "Delivered",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  return_requested: {
    label: "Return Requested",
    className: "bg-orange-50 text-orange-700 border-orange-200",
  },
  partially_returned: {
    label: "Partially Returned",
    className: "bg-orange-50 text-orange-700 border-orange-200",
  },
  returned: {
    label: "Returned",
    className: "bg-rose-50 text-rose-700 border-rose-200",
  },
};

/** Fulfillment workflow badge — independent from the payment badge. */
export function OrderStatusBadge({ status }: OrderStatusBadgeProps) {
  if (!status) return <span className="text-slate-400">—</span>;
  const config = fulfillmentConfig[status] ?? {
    label:
      FULFILLMENT_LABELS[status as FulfillmentState] ??
      status.replace(/_/g, " "),
    className: "bg-slate-50 text-slate-700 border-slate-200",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${config.className}`}
      data-testid="order-fulfillment-badge"
    >
      {config.label}
    </span>
  );
}
