export type LandedCostAllocationMethod = "quantity" | "value" | "weight" | "manual";

export type LandedCostStatus = "draft" | "posted" | "adjusted" | "reversed";

export type LandedCostExpenseType =
  | "shipping"
  | "loading"
  | "customs"
  | "transportation"
  | "insurance"
  | "handling"
  | "other";

export type LandedCostTaxTreatment = "none" | "recoverable" | "non_recoverable";

export interface LandedCostExpenseInput {
  expenseType: LandedCostExpenseType;
  amount: number;
  description?: string | null;
  taxAmount?: number;
  taxTreatment?: LandedCostTaxTreatment;
  isCapitalizable?: boolean;
  vendorId?: number | null;
  referenceNumber?: string | null;
  expenseDate?: string | null;
}

/**
 * The capitalizable base of an expense list: capitalizable expense amounts
 * plus non-recoverable taxes; recoverable taxes are excluded (they are
 * reclaimable input tax, not product cost).
 */
export function capitalizableAmountMicros(
  expenses: {
    amount: number;
    taxAmount?: number;
    taxTreatment?: LandedCostTaxTreatment;
    isCapitalizable?: boolean;
  }[],
): bigint {
  return expenses.reduce((sum, expense) => {
    if (expense.isCapitalizable === false) return sum;
    const base = BigInt(Math.round(Number(expense.amount) * 100)) * 10_000n;
    const tax =
      expense.taxTreatment === "non_recoverable"
        ? BigInt(Math.round(Number(expense.taxAmount ?? 0) * 100)) * 10_000n
        : 0n;
    return sum + base + tax;
  }, 0n);
}
