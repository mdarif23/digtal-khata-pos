import type { StatusTone } from "@/components/common/StatusBadge";

/**
 * Business + messaging helpers for due management. Display formatting
 * (money, dates) lives in the canonical `@/lib/format` module.
 */

export function todayInputValue(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export type PaymentStatusValue = "unpaid" | "partial" | "paid" | "credit";

export function statusTone(status: PaymentStatusValue): StatusTone {
  switch (status) {
    case "paid":
      return "success";
    case "partial":
      return "warning";
    case "credit":
      return "primary";
    default:
      return "danger";
  }
}

export function statusLabel(status: PaymentStatusValue): string {
  switch (status) {
    case "paid":
      return "Settled";
    case "partial":
      return "Partially paid";
    case "credit":
      return "Credit balance";
    default:
      return "Unpaid";
  }
}

/**
 * Normalize a Bangladesh phone number into international digits for
 * wa.me links. Accepts formats like 01712345678, +8801712345678,
 * 8801712345678. Returns null when the number is not a plausible
 * Bangladeshi mobile number.
 */
export function normalizeBangladeshPhone(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D+/g, "");
  if (!digits) return null;

  let normalized: string;
  if (digits.startsWith("880")) {
    normalized = digits;
  } else if (digits.startsWith("0")) {
    normalized = `880${digits.slice(1)}`;
  } else {
    normalized = digits;
  }

  // 880 + 10-digit national number (1XXXXXXXXX)
  if (/^8801[3-9]\d{8}$/.test(normalized)) return normalized;
  return null;
}

export function whatsappLink(phone: string, message: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}
