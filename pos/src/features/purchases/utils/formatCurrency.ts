/** Shared money formatting for the purchases domain (was copy-pasted per file). */
export const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-BD", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);

/** Round to the 2-dp money grid — raw float sums print residues like
 *  320.33999999999997 and then clamp legitimate payments (e.g. a ৳0.34
 *  remainder) below the real balance. */
export const roundMoney = (value: number) =>
  Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
