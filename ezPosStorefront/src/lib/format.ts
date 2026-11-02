const BDT = "৳";

/** Compact BDT formatting for storefront prices (server+client safe). */
export function formatPrice(amount: number): string {
  return `${BDT}${amount.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}
