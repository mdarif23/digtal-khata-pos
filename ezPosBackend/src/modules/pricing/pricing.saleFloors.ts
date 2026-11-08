import { db } from "../../db/schema/index.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { resolveVariantCost } from "./pricing.costProvider.js";
import { getPricingSettingsView } from "./pricing.service.js";

/**
 * Minimum-price protection at SALE TIME (Phase 6, approved design §13.10).
 * A line's effective per-base charge (after line discount and the
 * group/promotion/manual allocations) may never silently land below:
 *  - the variant's own `min_selling_price` floor, or
 *  - the business-wide `pricing_settings.min_margin_percent` margin floor
 *    (measured against the PricingCostProvider's weighted-average landed
 *    cost; when no priced batch exists the margin check is skipped — the
 *    cost provider never substitutes zero).
 *
 * The QUOTE always returns violations as `warnings` (warn always); createSale
 * BLOCKS unless the caller holds `pricing.below_minimum_override`, in which
 * case a reason is recorded on the sale lines and in the audit log.
 */

export interface FloorViolation {
  index: number;
  variantId: number;
  /** Effective per-base charge for the line (post allocations). */
  effectiveUnitPrice: number;
  /** The variant floor that was crossed, when set. */
  minPrice: number | null;
  /** The line's margin over cost, when cost was available. */
  marginPercent: number | null;
  /** The business-wide margin floor, when configured. */
  floorMarginPercent: number | null;
  message: string;
}

interface FloorItem {
  variantId: number;
  quantity: number;
  minSellingPrice: number | null;
}

/**
 * `lineCharges` are INDEX-ALIGNED effective per-LINE charges (post line
 * discount and all discount layers); quantities are BASE units.
 */
export async function evaluateMinimumFloors(
  dbe: Pick<typeof db, "select">,
  businessId: number,
  items: FloorItem[],
  lineCharges: number[],
): Promise<FloorViolation[]> {
  const settings = await getPricingSettingsView(businessId);
  const marginFloor = settings.minMarginPercent;

  // Cost only needs resolving when a margin floor is configured — one query
  // per distinct variant (cheap; the provider never substitutes zero).
  const costByVariant = new Map<number, number | null>();
  if (marginFloor != null && items.length > 0) {
    const variantIds = [...new Set(items.map((i) => i.variantId))];
    for (const variantId of variantIds) {
      const cost = await resolveVariantCost(dbe, businessId, variantId);
      costByVariant.set(variantId, cost.status === "available" ? cost.cost : null);
    }
  }

  const violations: FloorViolation[] = [];
  items.forEach((item, idx) => {
    const charge = roundMoney(lineCharges[idx] ?? 0);
    const qty = item.quantity;
    if (qty <= 0) return;
    const perBase = charge / qty;

    if (item.minSellingPrice != null && perBase < item.minSellingPrice) {
      violations.push({
        index: idx,
        variantId: item.variantId,
        effectiveUnitPrice: roundMoney(perBase),
        minPrice: item.minSellingPrice,
        marginPercent: null,
        floorMarginPercent: null,
        message: `Effective price ৳${roundMoney(perBase)} is below the minimum ৳${item.minSellingPrice}.`,
      });
      return;
    }

    if (marginFloor != null) {
      const cost = costByVariant.get(item.variantId);
      // Cost-unavailable is NEVER priced from nothing: the margin floor
      // check simply cannot run for that line (explicit, not silent-zero).
      if (cost != null && charge > 0) {
        const margin = ((charge / qty - cost) / (charge / qty)) * 100;
        if (margin < marginFloor) {
          violations.push({
            index: idx,
            variantId: item.variantId,
            effectiveUnitPrice: roundMoney(charge / qty),
            minPrice: null,
            marginPercent: Math.round(margin * 100) / 100,
            floorMarginPercent: marginFloor,
            message: `Margin ${Math.round(margin * 100) / 100}% is below the ${marginFloor}% floor (cost ৳${cost}).`,
          });
        }
      }
    }
  });
  return violations;
}
