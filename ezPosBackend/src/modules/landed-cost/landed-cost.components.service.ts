import { roundMoney } from "../../utils/roundMoney.js";

// ONE authoritative classification for every landed-cost component
// (Phase 5). Pure functions — the allocation engine's money rules
// (capitalizableAmountMicros) and the postings consume this same
// classification, so the UI, allocation, and accounting can never disagree.
//
// Rule table (prompt Phase 5):
//   item purchase cost   → already capitalized in batches (purchase_price)
//   order discount       → REDUCES inventory acquisition cost (negative)
//   recoverable tax      → excluded from inventory (tracked, not capitalized)
//   non-recoverable tax  → capitalized with the expense
//   non-capitalizable    → expensed, never capitalized
//   supplier shipping    → capitalized (purchase-origin, Phase 4 auto row)
//   additional expenses  → capitalized when eligible
//
// NOTE on configurability: the ORDER TAX treatment defaults to excluded
// (preserving all existing behavior). Making it configurable per purchase
// requires a schema field — deferred to the DB approval gate.

export type ComponentSourceType = "purchase" | "additional_expense";

export type ComponentInventoryTreatment =
  | "capitalized"
  | "excluded"
  | "expensed";

export interface LandedCostComponent {
  sourceType: ComponentSourceType;
  /** Identifies the origin within the source: 'order_discount',
   *  'order_tax', 'shipping_cost' for purchase-origin; 'expense:<id>' for
   *  additional_expense rows. */
  sourceKey: string;
  sourceId: number | null;
  label: string;
  /** Signed: negative amounts REDUCE inventory acquisition cost. */
  amount: number;
  taxAmount: number;
  taxTreatment: "recoverable" | "non_recoverable" | "non_capitalizable" | "none";
  capitalizationEligible: boolean;
  inventoryTreatment: ComponentInventoryTreatment;
}

export interface LandedCostComponentTotals {
  /** Net amount that capitalizes into inventory (discount reduces it). */
  capitalizable: number;
  /** Recoverable tax tracked separately — excluded from inventory. */
  recoverableTax: number;
  /** Non-capitalizable amounts — expensed per accounting policy. */
  expensed: number;
}

type PurchaseHeader = {
  discount: string | number;
  tax: string | number;
  shippingCost: string | number;
};

type ExpenseRow = {
  id: number;
  expenseType: string;
  description: string | null;
  amount: string | number;
  taxAmount: string | number;
  taxTreatment: string;
  isCapitalizable: boolean;
  sourceType: string;
  sourceKey: string | null;
};

function classifyExpense(expense: ExpenseRow): LandedCostComponent {
  const eligible = expense.isCapitalizable;
  const isPurchaseOrigin = expense.sourceType === "purchase";
  return {
    sourceType: isPurchaseOrigin ? "purchase" : "additional_expense",
    sourceKey: isPurchaseOrigin
      ? (expense.sourceKey ?? "purchase_origin")
      : `expense:${expense.id}`,
    sourceId: expense.id,
    label:
      expense.description ??
      `${expense.expenseType} expense`,
    amount: roundMoney(Number(expense.amount)),
    taxAmount: roundMoney(Number(expense.taxAmount)),
    taxTreatment: expense.taxTreatment as LandedCostComponent["taxTreatment"],
    capitalizationEligible: eligible,
    inventoryTreatment: eligible ? "capitalized" : "expensed",
  };
}

/**
 * Classify every landed-cost component for a purchase. Order discount,
 * order tax and supplier shipping come from the purchase header; the
 * supplier shipping's capitalized state is mirrored by its Phase 4
 * purchase-origin expense row (excluded here to avoid double-counting).
 * User-entered expense rows classify per their own treatment.
 */
export function classifyLandedCostComponents(
  purchase: PurchaseHeader,
  expenses: ExpenseRow[],
): { components: LandedCostComponent[]; totals: LandedCostComponentTotals } {
  const components: LandedCostComponent[] = [];

  const orderDiscount = roundMoney(Number(purchase.discount));
  if (orderDiscount > 0) {
    components.push({
      sourceType: "purchase",
      sourceKey: "order_discount",
      sourceId: null,
      label: "Order discount",
      amount: -orderDiscount,
      taxAmount: 0,
      taxTreatment: "none",
      capitalizationEligible: true,
      inventoryTreatment: "capitalized",
    });
  }

  const orderTax = roundMoney(Number(purchase.tax));
  if (orderTax > 0) {
    components.push({
      sourceType: "purchase",
      sourceKey: "order_tax",
      sourceId: null,
      label: "Order tax",
      amount: orderTax,
      taxAmount: 0,
      taxTreatment: "none",
      // Legacy-preserving default: the order tax is payable-only and NOT
      // auto-capitalized. Per-treatment configurability requires a schema
      // field (deferred to the DB approval gate).
      capitalizationEligible: false,
      inventoryTreatment: "excluded",
    });
  }

  // User-entered expenses classify individually. Purchase-origin rows
  // (sourceType 'purchase') represent the header's supplier shipping —
  // they are represented ONCE by the shipping component below, never
  // again here.
  const shipping = roundMoney(Number(purchase.shippingCost));
  if (shipping > 0) {
    components.push({
      sourceType: "purchase",
      sourceKey: "shipping_cost",
      sourceId: null,
      label: "Supplier shipping",
      amount: shipping,
      taxAmount: 0,
      taxTreatment: "none",
      capitalizationEligible: true,
      inventoryTreatment: "capitalized",
    });
  }
  for (const expense of expenses) {
    if (expense.sourceType === "purchase") continue; // mirrored above
    components.push(classifyExpense(expense));
  }

  const totals: LandedCostComponentTotals = {
    capitalizable: 0,
    recoverableTax: 0,
    expensed: 0,
  };
  for (const component of components) {
    if (!component.capitalizationEligible) {
      totals.expensed = roundMoney(totals.expensed + component.amount);
      continue;
    }
    totals.capitalizable = roundMoney(totals.capitalizable + component.amount);
    if (
      component.taxTreatment === "recoverable" &&
      component.taxAmount > 0
    ) {
      totals.recoverableTax = roundMoney(
        totals.recoverableTax + component.taxAmount,
      );
    } else if (component.taxTreatment === "non_recoverable") {
      totals.capitalizable = roundMoney(totals.capitalizable + component.taxAmount);
    }
    // taxTreatment 'none' with a taxAmount > 0 would be a data anomaly —
    // excluded from both, matching the allocation engine's base.
  }

  return { components, totals };
}
