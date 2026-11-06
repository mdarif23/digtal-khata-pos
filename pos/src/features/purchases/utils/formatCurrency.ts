/** Shared money formatting for the purchases domain (was copy-pasted per file). */
export const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-BD", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
