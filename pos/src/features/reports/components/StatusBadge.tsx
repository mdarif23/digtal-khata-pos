import React from "react";

interface StatusBadgeProps {
  status: string | null | undefined;
}

const statusConfig: Record<string, { label: string; className: string }> = {
  paid: {
    label: "Paid",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  partial: {
    label: "Partial",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
  unpaid: {
    label: "Unpaid",
    className: "bg-rose-50 text-rose-700 border-rose-200",
  },
  completed: {
    label: "Completed",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-slate-100 text-slate-500 border-slate-200",
  },
  refunded: {
    label: "Refunded",
    className: "bg-primary/10 text-primary border-primary/30",
  },
  held: {
    label: "Held",
    className: "bg-blue-50 text-blue-700 border-blue-200",
  },
  in_stock: {
    label: "In Stock",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  low_stock: {
    label: "Low Stock",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
  out_of_stock: {
    label: "Out of Stock",
    className: "bg-rose-50 text-rose-700 border-rose-200",
  },
  expired: {
    label: "Expired",
    className: "bg-rose-50 text-rose-700 border-rose-200",
  },
  expiring_soon: {
    label: "Expiring Soon",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
  valid: {
    label: "Valid",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  no_expiry: {
    label: "No Expiry",
    className: "bg-slate-50 text-slate-500 border-slate-200",
  },
  ordered: {
    label: "Ordered",
    className: "bg-blue-50 text-blue-700 border-blue-200",
  },
  received: {
    label: "Received",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  partially_received: {
    label: "Partially Received",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
};

export function StatusBadge({ status }: StatusBadgeProps) {
  if (!status) return <span className="text-slate-400">—</span>;

  const key = status.toLowerCase();
  const config = statusConfig[key] ?? {
    label: status.replace(/_/g, " "),
    className: "bg-slate-50 text-slate-700 border-slate-200",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${config.className}`}
    >
      {config.label}
    </span>
  );
}

