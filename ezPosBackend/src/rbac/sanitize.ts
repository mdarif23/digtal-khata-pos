const COST_KEYS = new Set([
  "purchasePrice",
  "purchaseCost",
  "unitCost",
  "averageCost",
  "cost", // sold_products rows expose sale_items.cost_at_sale
]);

/**
 * Recursively removes purchase-cost fields from an API payload so sensitive
 * cost data never reaches callers lacking `products.view_cost` — hiding
 * columns in React is not sufficient. Arrays are cloned; unmatched shapes
 * pass through untouched.
 */
export function stripCostData<T>(payload: T): T {
  if (Array.isArray(payload)) {
    return payload.map((item) => stripCostData(item)) as unknown as T;
  }
  if (payload !== null && typeof payload === "object") {
    const source = payload as Record<string, unknown>;
    const clone: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (COST_KEYS.has(key)) continue;
      clone[key] = stripCostData(value);
    }
    return clone as unknown as T;
  }
  return payload;
}
