import { BadRequestError } from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { allocateByBasis } from "../landed-cost/landed-cost.money.js";

// ONE authoritative purchase financial calculation (Phase 2 of the
// Purchase Financial Summary feature). Pure functions — no DB access —
// so the create/edit endpoints and the details view all compute from the
// same rules and can never drift apart.
//
// The formula reproduces the historical createPurchase math EXACTLY
// (per-line round-then-sum) so new purchases carry identical totals:
//
//   items subtotal  = Σ round2(qty × unitPrice − lineDiscount + lineTax)
//   grand total     = itemsSubtotal − orderDiscount + orderTax
//                     + supplierShipping + otherSupplierCharges
//
// Tax treatments are CARRIED but not yet persisted at purchase level:
// they land with the approved schema change (Phase 4/5 gate). Until then
// order-level tax keeps its legacy behavior (payable-only, excluded from
// inventory capitalization).

export type PurchaseTaxTreatment =
  | "recoverable"
  | "non_recoverable"
  | "non_capitalizable";

export type DiscountBasis = "fixed" | "percentage";

export interface PurchaseLineInput {
  quantity: number;
  unitPrice: number;
  discount: number;
  tax: number;
}

export interface PurchaseChargeInput {
  label?: string;
  amount: number;
  taxTreatment?: PurchaseTaxTreatment;
  /** Defaults to true for supplier charges (capitalization is decided by
   *  the landed-cost module's classification, not here). */
  capitalizationEligible?: boolean;
}

export interface PurchaseFinancialInput {
  lines: PurchaseLineInput[];
  orderDiscount: number;
  /** Percentage resolves against the items subtotal and is stored as the
   *  resolved fixed amount (the payable only ever needs the amount). */
  orderDiscountBasis?: DiscountBasis;
  orderTax: number;
  supplierShipping: number;
  otherSupplierCharges?: PurchaseChargeInput[];
}

export interface PurchaseFinancialSummary {
  itemsSubtotal: number;
  lineDiscountTotal: number;
  lineTaxTotal: number;
  orderDiscount: number;
  orderTax: number;
  supplierShipping: number;
  otherSupplierCharges: number;
  grandTotal: number;
  /** Supplier charges eligible for inventory capitalization (Phase 4
   *  consumes this as the purchase-origin landed-cost component). */
  capitalizableSupplierCharges: number;
}

function requireNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new BadRequestError(`${label} must be a finite number.`);
  }
  if (value < 0) {
    throw new BadRequestError(`${label} cannot be negative.`);
  }
  return value;
}

/** Line net value — the same basis the return-credit amortization uses. */
export function lineNetValue(line: PurchaseLineInput): number {
  return roundMoney(
    Number(line.quantity) * Number(line.unitPrice) -
      Number(line.discount) +
      Number(line.tax),
  );
}

/**
 * The authoritative purchase financial summary. Throws BadRequestError on
 * invalid input (negative amounts, discounts exceeding their base) — the
 * zod schema remains the first gate, this is the calculation's own
 * defense.
 */
export function calculatePurchaseFinancials(
  input: PurchaseFinancialInput,
): PurchaseFinancialSummary {
  if (!input.lines.length) {
    throw new BadRequestError("At least one purchase item is required.");
  }

  let lineDiscountTotal = 0;
  let lineTaxTotal = 0;
  const lineValues: number[] = input.lines.map((line) => {
    if (Number(line.quantity) <= 0) {
      throw new BadRequestError("Line quantities must be greater than zero.");
    }
    requireNonNegative(Number(line.unitPrice), "Line unit price");
    requireNonNegative(Number(line.discount), "Line discount");
    requireNonNegative(Number(line.tax), "Line tax");
    const net = lineNetValue(line);
    if (net < 0) {
      throw new BadRequestError(
        "Line discount cannot exceed the line amount.",
      );
    }
    lineDiscountTotal += Number(line.discount);
    lineTaxTotal += Number(line.tax);
    return net;
  });
  const itemsSubtotal = roundMoney(
    lineValues.reduce((sum, value) => sum + value, 0),
  );
  lineDiscountTotal = roundMoney(lineDiscountTotal);
  lineTaxTotal = roundMoney(lineTaxTotal);

  requireNonNegative(Number(input.orderTax), "Order tax");
  requireNonNegative(Number(input.supplierShipping), "Supplier shipping");
  const otherCharges = input.otherSupplierCharges ?? [];
  for (const charge of otherCharges) {
    requireNonNegative(Number(charge.amount), "Supplier charge");
  }
  const otherSupplierCharges = roundMoney(
    otherCharges.reduce((sum, charge) => sum + Number(charge.amount), 0),
  );

  const basis = input.orderDiscountBasis ?? "fixed";
  const requestedDiscount = requireNonNegative(
    Number(input.orderDiscount),
    "Order discount",
  );
  const orderDiscount =
    basis === "percentage"
      ? roundMoney((itemsSubtotal * requestedDiscount) / 100)
      : roundMoney(requestedDiscount);
  if (orderDiscount > itemsSubtotal) {
    throw new BadRequestError(
      `Order discount (${orderDiscount.toFixed(2)}) cannot exceed the items subtotal (${itemsSubtotal.toFixed(2)}).`,
    );
  }

  const supplierShipping = roundMoney(Number(input.supplierShipping));
  const capitalizableSupplierCharges = roundMoney(
    supplierShipping +
      otherCharges.reduce(
        (sum, charge) =>
          charge.capitalizationEligible === false
            ? sum
            : sum + Number(charge.amount),
        0,
      ),
  );

  const grandTotal = roundMoney(
    itemsSubtotal -
      orderDiscount +
      Number(input.orderTax) +
      supplierShipping +
      otherSupplierCharges,
  );
  if (grandTotal < 0) {
    throw new BadRequestError("Purchase totals cannot be negative.");
  }

  return {
    itemsSubtotal,
    lineDiscountTotal,
    lineTaxTotal,
    orderDiscount,
    orderTax: roundMoney(Number(input.orderTax)),
    supplierShipping,
    otherSupplierCharges,
    grandTotal,
    capitalizableSupplierCharges,
  };
}

/**
 * Allocate the ORDER-level discount proportionally across lines by net
 * value (largest-remainder via the landed-cost exact allocator), so a
 * discount can reduce inventory acquisition cost exactly once and in full
 * (Phase 4 consumes this as a purchase-origin component). The per-line
 * amounts sum EXACTLY to the discount after 2dp rounding.
 */
export function allocateOrderDiscount(
  lines: PurchaseLineInput[],
  discount: number,
): number[] {
  const total = roundMoney(requireNonNegative(Number(discount), "Discount"));
  const lineValues = lines.map(lineNetValue);
  const totalBasis = roundMoney(
    lineValues.reduce((sum, value) => sum + Math.max(value, 0), 0),
  );
  if (total === 0) return lines.map(() => 0);
  if (totalBasis <= 0) {
    throw new BadRequestError(
      "Order discount cannot be allocated: no line carries a positive value.",
    );
  }

  const shares = allocateByBasis(
    BigInt(Math.round(total * 10_000)),
    lineValues.map((value, index) => ({
      key: String(index),
      basisMicros: BigInt(Math.round(Math.max(value, 0) * 10_000)),
    })),
  );

  const cents = lineValues.map((_, index) =>
    Math.round(Number(shares.get(String(index)) ?? 0n) / 10_000 * 100),
  );
  // Deterministic residual: hand the rounding difference to the largest
  // allocation so the parts sum exactly to the discount in cents.
  const residual =
    Math.round(total * 100) - cents.reduce((sum, value) => sum + value, 0);
  if (residual !== 0) {
    const largest = cents.reduce(
      (best, value, index) => (value > cents[best]! ? index : best),
      0,
    );
    cents[largest] = (cents[largest] ?? 0) + residual;
  }
  return cents.map((value) => value / 100);
}
