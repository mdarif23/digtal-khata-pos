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

import type { StatusTone } from "@/components/common/StatusBadge";

/**
 * Status → semantic tone (rendered through the shared StatusBadge):
 * green → success, amber/yellow/orange → warning, red → danger,
 * blue/indigo/teal → info, purple → primary, gray → neutral.
 */
const STATUS_TONES: Record<string, StatusTone> = {
  // warranties
  active: "success",
  expiring: "warning",
  expired: "danger",
  voided: "neutral",
  replaced: "primary",
  suspended: "neutral",
  exhausted: "warning",
  // claims
  submitted: "info",
  under_inspection: "info",
  approved: "success",
  rejected: "danger",
  repairing: "warning",
  waiting_parts: "warning",
  ready_for_pickup: "info",
  closed: "neutral",
  cancelled: "neutral",
  // supplier claim responses
  sent_to_supplier: "info",
  under_repair: "warning",
  recovered: "success",
};

/** Semantic tone for a warranty/claim status pill (falls back to neutral). */
export function statusTone(status: string | null | undefined): StatusTone {
  if (!status) return "neutral";
  return STATUS_TONES[status] ?? "neutral";
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
