import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { divRoundHalfUp, parseNumericToMicros } from "./pricing.money.js";

/**
 * PricingCostProvider (report §3): the ONE place the pricing system reads
 * cost from. It wraps the authoritative inventory costing — the generated
 * `inventory_batches.landed_cost_per_unit` column — with the same
 * weighted-average-of-on-hand-batches definition the products API exposes as
 * variant `purchaseCost` (barcodes.service loadVariantPurchaseCost /
 * products.service subquery). The engine NEVER re-derives cost from purchase
 * rows and NEVER substitutes zero: no priced batches → explicit
 * `unavailable` result (master prompt Part 8).
 */

type CostExecutor = Pick<typeof db, "select">;

export type CostResolution =
  | {
      status: "available";
      /** Exact weighted-average landed cost in micros (6-dp grid preserved). */
      costMicros: bigint;
      /** Display convenience: the same cost as a JS number (≤ 6 dp). */
      cost: number;
      batchCount: number;
      onHandQuantity: number;
    }
  | { status: "unavailable"; reason: string };

/**
 * Weighted-average landed cost of the variant's on-hand batches, optionally
 * narrowed to one location (cost is per-location; the products-list variant
 * of this query is business-global).
 */
export async function resolveVariantCost(
  dbe: CostExecutor,
  businessId: number,
  variantId: number,
  locationId?: number | null,
): Promise<CostResolution> {
  const filters = [
    eq(inventoryBatches.businessId, businessId),
    eq(inventoryBatches.variantId, variantId),
    sql`${inventoryBatches.quantityRemaining} > 0`,
  ];
  if (locationId != null) {
    filters.push(eq(inventoryBatches.locationId, locationId));
  }
  const [row] = await dbe
    .select({
      totalCost: sql<string | null>`SUM(${inventoryBatches.landedCostPerUnit} * ${inventoryBatches.quantityRemaining})`,
      totalQuantity: sql<number | null>`SUM(${inventoryBatches.quantityRemaining})`,
      batchCount: sql<number>`COUNT(*)::int`,
    })
    .from(inventoryBatches)
    .where(and(...filters));

  const totalQuantity = Number(row?.totalQuantity ?? 0);
  if (!row?.totalCost || totalQuantity <= 0) {
    return {
      status: "unavailable",
      reason: "No priced inventory batches are on hand for this variant.",
    };
  }
  const totalMicros = parseNumericToMicros(String(row.totalCost));
  const costMicros = divRoundHalfUp(totalMicros, BigInt(totalQuantity));
  return {
    status: "available",
    costMicros,
    cost: Number(costMicros) / 1_000_000,
    batchCount: Number(row.batchCount ?? 0),
    onHandQuantity: totalQuantity,
  };
}
