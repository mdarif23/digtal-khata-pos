import { formatDateTime } from "@/features/reports/utils/reportUtils";
import type { OrderTimelineEvent } from "../types/onlineOrders.types";

const EVENT_LABELS: Record<string, string> = {
  created: "Order received",
  confirmed: "Order confirmed",
  processing: "Processing started",
  package_added: "Package recorded",
  package_updated: "Package updated",
  package_removed: "Package removed",
  ready_to_ship: "Marked ready to ship",
  courier_assigned: "Courier assigned",
  shipped: "Order shipped",
  delivered: "Order delivered",
  payment_recorded: "Payment collected",
  cancelled: "Order cancelled",
  partially_returned: "Partially returned",
  returned: "Returned",
};

function actorName(event: OrderTimelineEvent): string {
  if (event.actorType === "integration" && event.actorLabel) return event.actorLabel;
  if (event.actorUserId) return "Staff";
  if (event.actorLabel) return event.actorLabel;
  return event.actorType === "system" ? "System" : "Staff";
}

interface OrderTimelineProps {
  events: OrderTimelineEvent[] | undefined;
  isLoading: boolean;
}

/** Chronological audit history for one order — append-only on the backend. */
export function OrderTimeline({ events, isLoading }: OrderTimelineProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded-md bg-slate-100" />
        ))}
      </div>
    );
  }
  if (!events || events.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-slate-500">
        No activity recorded yet.
      </p>
    );
  }
  return (
    <ol className="relative space-y-5 border-l border-slate-200 pl-5">
      {events.map((event) => (
        <li key={event.id} className="relative">
          <span
            className="absolute -left-[26px] top-1.5 h-3 w-3 rounded-full border-2 border-white bg-blue-500"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-slate-800">
            {EVENT_LABELS[event.eventType] ?? event.eventType.replace(/_/g, " ")}
          </p>
          <p className="text-xs text-slate-500">
            {formatDateTime(event.createdAt)} · {actorName(event)}
          </p>
          {event.note ? (
            <p className="mt-0.5 text-xs text-slate-600">{event.note}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
