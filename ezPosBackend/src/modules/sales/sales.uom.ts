import { BadRequestError } from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import type { DbExecutor, UomContext } from "../uom/uom.service.js";
import {
  resolveUomContext,
  convertEnteredLine,
} from "../uom/uom.service.js";
import {
  factorToMicros,
  perBasePriceMicros,
  microsToNumber,
  MICROS,
} from "../uom/uom.money.js";

/**
 * UOM boundary for sales (migration 0062): the cashier enters a quantity in
 * a selling unit ("1 Box @ ৳1,500"); the server converts it ONCE to the
 * base-unit figures every downstream system speaks (FIFO consumption,
 * INTEGER stock, serial counts, COGS, GL, refunds, reports).
 *
 * Storage contract (same as purchases):
 *   sale_items.quantity       — BASE units (integer)
 *   sale_items.selling_price  — per-BASE-unit price snapshot (6-dp)
 *   entered_* / uom_conversion_id — what the operator typed (snapshots)
 *
 * Pricing is server-authoritative, exactly like the base-unit path:
 *   per-entered-unit price = conversion.sale_price
 *                            ?? round2(factor × variant.selling_price)
 *   per-base-unit price    = sale_price ÷ factor (6-dp)
 *                            ?? variant.selling_price (exact)
 * so a derived package price loses NO precision, and a configured package
 * price rounds only on the 6-dp per-base grid (≤ ½·10⁻⁶/base unit).
 */

export interface SaleUomSnapshot {
  conversionId: number;
  enteredQuantity: number;
  enteredUnitPrice: number;
  conversionFactor: number;
}

export interface BaseSaleItem {
  variantId: number;
  /** BASE-unit quantity (integer for stock-tracked flows). */
  quantity: number;
  /** Per-BASE-unit price (the shape every existing consumer expects). */
  unitPrice: number;
  discount: { type: "fixed" | "percentage"; value: number } | null;
  serialNumbers?: string[] | undefined;
  uomConversionId?: number | null | undefined;
  uomSnapshot: SaleUomSnapshot | null;
}

export interface VariantForSale {
  id: number;
  productId: number;
  sellingPrice: number;
  trackingType?: string | null | undefined;
}

/**
 * Resolve the authoritative per-entered-unit price for a selling unit.
 * conversion.sale_price wins; otherwise factor × variant base price,
 * rounded to currency (2 dp) for the operator-facing figure.
 */
export function resolveEnteredUnitPrice(
  ctx: UomContext,
  variantSellingPrice: number,
): number {
  if (ctx.conversion?.salePrice != null) return ctx.conversion.salePrice;
  if (ctx.factorMicros === MICROS) return variantSellingPrice;
  return roundMoney(
    microsToNumber(
      (BigInt(Math.round(variantSellingPrice * 1e6)) * ctx.factorMicros) / MICROS,
    ),
  );
}

/**
 * Convert entered sale lines to base-unit lines. Identity lines (no
 * uomConversionId) pass through with a null snapshot and their price
 * resolution untouched, so every legacy payload behaves exactly as before.
 * Stock-affecting flows require whole base quantities (INTEGER stock).
 */
export async function normalizeSaleItemsToBase(
  dbe: DbExecutor,
  businessId: number,
  variants: VariantForSale[],
  items: {
    variantId: number;
    quantity: number;
    discount: { type: "fixed" | "percentage"; value: number } | null;
    serialNumbers?: string[] | undefined;
    uomConversionId?: number | null | undefined;
  }[],
): Promise<BaseSaleItem[]> {
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const out: BaseSaleItem[] = [];
  for (const item of items) {
    const variant = variantById.get(item.variantId);
    if (!variant) {
      // Existence is reported by validateVariants; keep the item shaped.
      out.push({
        variantId: item.variantId,
        quantity: item.quantity,
        unitPrice: 0,
        discount: item.discount,
        serialNumbers: item.serialNumbers,
        uomConversionId: item.uomConversionId ?? null,
        uomSnapshot: null,
      });
      continue;
    }
    if (item.uomConversionId == null) {
      out.push({
        variantId: item.variantId,
        quantity: item.quantity,
        unitPrice: Number(variant.sellingPrice),
        discount: item.discount,
        serialNumbers: item.serialNumbers,
        uomConversionId: null,
        uomSnapshot: null,
      });
      continue;
    }
    const ctx = await resolveUomContext(
      dbe,
      businessId,
      variant.productId,
      variant.id,
      item.uomConversionId,
    );
    const converted = convertEnteredLine(ctx, item.quantity, null, {
      wholeBase: true,
    });
    const baseQuantity = Number(converted.baseMicros / MICROS);
    const enteredUnitPrice = resolveEnteredUnitPrice(
      ctx,
      Number(variant.sellingPrice),
    );
    const perBaseUnitPrice =
      ctx.conversion?.salePrice != null
        ? microsToNumber(
            perBasePriceMicros(ctx.conversion.salePrice, ctx.factorMicros),
          )
        : Number(variant.sellingPrice);
    out.push({
      variantId: item.variantId,
      quantity: baseQuantity,
      unitPrice: perBaseUnitPrice,
      discount: item.discount,
      serialNumbers: item.serialNumbers,
      uomConversionId: ctx.conversion!.id,
      uomSnapshot: {
        conversionId: ctx.conversion!.id,
        enteredQuantity: item.quantity,
        enteredUnitPrice,
        conversionFactor: ctx.factor,
      },
    });
  }
  return out;
}

/**
 * The duplicate-line guard, UOM-aware: the same variant may appear once per
 * DISTINCT packaging unit (a Box line and a Piece line in one cart is the
 * whole point of the feature), but two lines in the SAME unit are still a
 * client bug — combine them.
 */
export function assertNoDuplicateVariantUnitLines(
  items: { variantId: number; uomConversionId?: number | null | undefined }[],
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.variantId}:${item.uomConversionId ?? "base"}`;
    if (seen.has(key)) {
      throw new BadRequestError(
        "Duplicate product variants are not allowed. Combine their quantities first.",
      );
    }
    seen.add(key);
  }
}

export { factorToMicros };
