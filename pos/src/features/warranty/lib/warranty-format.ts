/**
 * Label + badge-color maps for the warranty domain (customer warranties,
 * customer claims, supplier claims) and small formatting helpers.
 */

export const WARRANTY_STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "expiring", label: "Expiring soon" },
  { value: "expired", label: "Expired" },
  { value: "voided", label: "Voided" },
  { value: "replaced", label: "Replaced" },
  { value: "suspended", label: "Suspended" },
] as const;

export const CLAIM_STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "submitted", label: "Submitted" },
  { value: "under_inspection", label: "Under inspection" },
  { value: "approved", label: "Approved" },
  { value: "repairing", label: "Repairing" },
  { value: "waiting_parts", label: "Waiting parts" },
  { value: "ready_for_pickup", label: "Ready for pickup" },
  { value: "replaced", label: "Replaced" },
  { value: "rejected", label: "Rejected" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export const CLAIM_TYPE_OPTIONS = [
  { value: "repair", label: "Repair" },
  { value: "replacement", label: "Replacement" },
  { value: "parts_replacement", label: "Parts replacement" },
  { value: "service", label: "Service" },
] as const;

export const SUPPLIER_CLAIM_STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "submitted", label: "Submitted" },
  { value: "sent_to_supplier", label: "Sent to supplier" },
  { value: "under_repair", label: "Under repair (supplier)" },
  { value: "rejected", label: "Rejected" },
  { value: "replaced", label: "Replaced" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

/** Claim statuses that still need shop action (drive the overview list). */
export const OPEN_CLAIM_STATUSES = new Set([
  "submitted",
  "under_inspection",
  "approved",
  "repairing",
  "waiting_parts",
  "ready_for_pickup",
]);

const STATUS_STYLES: Record<string, string> = {
  // warranties
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  expiring: "bg-amber-50 text-amber-700 border-amber-200",
  expired: "bg-rose-50 text-rose-700 border-rose-200",
  voided: "bg-slate-100 text-slate-500 border-slate-200",
  replaced: "bg-purple-50 text-purple-700 border-purple-200",
  suspended: "bg-slate-100 text-slate-500 border-slate-200",
  exhausted: "bg-amber-50 text-amber-700 border-amber-200",
  // claims
  submitted: "bg-sky-50 text-sky-700 border-sky-200",
  under_inspection: "bg-indigo-50 text-indigo-700 border-indigo-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-rose-50 text-rose-700 border-rose-200",
  repairing: "bg-amber-50 text-amber-700 border-amber-200",
  waiting_parts: "bg-orange-50 text-orange-700 border-orange-200",
  ready_for_pickup: "bg-teal-50 text-teal-700 border-teal-200",
  closed: "bg-slate-100 text-slate-500 border-slate-200",
  cancelled: "bg-slate-100 text-slate-500 border-slate-200",
  // supplier claim responses
  sent_to_supplier: "bg-blue-50 text-blue-700 border-blue-200",
  under_repair: "bg-amber-50 text-amber-700 border-amber-200",
  recovered: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

/** Tailwind classes for a status pill (falls back to neutral). */
export function statusBadgeClass(status: string | null | undefined): string {
  if (!status) return "bg-slate-50 text-slate-500 border-slate-200";
  return STATUS_STYLES[status] ?? "bg-slate-50 text-slate-700 border-slate-200";
}

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  const labels: Record<string, string> = {
    under_inspection: "Under inspection",
    waiting_parts: "Waiting parts",
    ready_for_pickup: "Ready for pickup",
    sent_to_supplier: "Sent to supplier",
    under_repair: "Under repair",
    parts_replacement: "Parts replacement",
  };
  const custom = labels[status];
  if (custom) return custom;
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** "12 months" / "6 months" — duration + unit as stored on the warranty. */
export function durationLabel(
  duration: number | null | undefined,
  durationUnit: string | null | undefined,
): string {
  if (duration === null || duration === undefined) return "—";
  const unit = (durationUnit ?? "").replace(/s$/, "");
  return `${duration} ${unit || "months"}`;
}

/** Transition key → the button label shown on the claim detail page. */
export const CLAIM_TRANSITION_LABELS: Record<string, string> = {
  under_inspection: "Start inspection",
  approved: "Approve",
  rejected: "Reject",
  repairing: "Begin repair",
  waiting_parts: "Waiting for parts",
  ready_for_pickup: "Mark ready for pickup",
  replaced: "Record replacement",
  closed: "Close claim",
  cancelled: "Cancel claim",
};

/** Transitions performed through dedicated forms (vs one-click actions). */
export const CLAIM_FORM_TRANSITIONS = new Set([
  "under_inspection",
  "approved",
  "rejected",
  "repairing",
  "waiting_parts",
  "replaced",
]);

/** Supplier response statuses (POST /supplier-warranty-claims/:id/response). */
export const SUPPLIER_RESPONSE_OPTIONS = [
  { value: "sent_to_supplier", label: "Sent to supplier" },
  { value: "under_repair", label: "Under repair (supplier)" },
  { value: "rejected", label: "Rejected by supplier" },
] as const;

export const RECOVERY_METHOD_OPTIONS = [
  { value: "credit_note", label: "Credit note" },
  { value: "replacement", label: "Replacement" },
  { value: "cash", label: "Cash" },
] as const;
