import { StatusBadge, type StatusTone } from "@/components/common/StatusBadge";
import {
  FULFILLMENT_LABELS,
  type FulfillmentState,
} from "../types/onlineOrders.types";

interface OrderStatusBadgeProps {
  status: string | null | undefined;
}

/** Fulfillment workflow tone — independent from the payment badge. */
const fulfillmentTones: Record<string, StatusTone> = {
  unfulfilled: "neutral",
  confirmed: "info",
  processing: "info",
  packed: "info",
  ready_to_ship: "info",
  shipped: "info",
  delivered: "success",
  return_requested: "warning",
  partially_returned: "warning",
  returned: "danger",
};

/** Payment / order-status tone (paid, completed → success; pending → warning; …). */
const orderStateTones: Record<string, StatusTone> = {
  pending: "warning",
  completed: "success",
  cancelled: "danger",
  refunded: "primary",
  paid: "success",
  partial: "warning",
  unpaid: "danger",
  held: "info",
};

function orderStateLabel(status: string): string {
  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Fulfillment workflow badge — independent from the payment badge. */
export function OrderStatusBadge({ status }: OrderStatusBadgeProps) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const label =
    FULFILLMENT_LABELS[status as FulfillmentState] ?? status.replace(/_/g, " ");
  return (
    <span data-testid="order-fulfillment-badge" className="inline-flex">
      <StatusBadge tone={fulfillmentTones[status] ?? "neutral"}>{label}</StatusBadge>
    </span>
  );
}

interface OrderStateBadgeProps {
  status: string | null | undefined;
}

/** Payment / order-status badge on the shared StatusBadge tones. */
export function OrderStateBadge({ status }: OrderStateBadgeProps) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  return (
    <StatusBadge tone={orderStateTones[status.toLowerCase()] ?? "neutral"}>
      {orderStateLabel(status)}
    </StatusBadge>
  );
}
