import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { suppliers } from "../../db/schema/suppliers.js";
import { NotFoundError } from "../../utils/handleError.js";
import { getPriceOverview, receivedEventsCte } from "./priceHistory.service.js";
import type { PriceOverviewRow } from "./priceHistory.service.js";
import type { PriceOverviewQuery } from "./schemas/priceHistory.schema.js";
import type { UpdateOrderSettingsInput } from "./schemas/priceCheck.schema.js";

/**
 * Supplier Price Monitoring (Smart Procurement Phase 3): this supplier's
 * actual received purchase prices per variant, with trend inputs, plus a
 * supplier profile/statistics summary. Reuses the price-overview
 * aggregation with the supplier filter forced on.
 */

export interface SupplierDetail {
  supplier: {
    id: number;
    name: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    status: string | null;
    minimumOrderValue: number | null;
    targetOrderValue: number | null;
    orderSettingsEnabled: boolean;
    orderSettingsNotes: string | null;
  };
  stats: {
    purchaseCount: number;
    totalReceivedValue: number;
    productCount: number;
    lastPurchaseDate: string | Date | null;
  };
}

export async function getSupplierDetail(
  businessId: number,
  supplierId: number,
): Promise<SupplierDetail> {
  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)))
    .limit(1);
  if (!supplier) throw new NotFoundError("Supplier not found.");

  const statsQuery = await db.execute(sql`
    SELECT
      COUNT(DISTINCT p.id)::int AS "purchaseCount",
      COALESCE(SUM(pi.received_quantity * pi.unit_cost), 0)::float8 AS "totalReceivedValue",
      COUNT(DISTINCT pi.variant_id)::int AS "productCount",
      MAX(p.purchase_date) AS "lastPurchaseDate"
    FROM purchases p
    JOIN purchase_items pi ON pi.purchase_id = p.id
      AND pi.business_id = p.business_id
    WHERE p.business_id = ${businessId}
      AND p.supplier_id = ${supplierId}
      AND p.status IN ('received', 'partially_received')
      AND pi.received_quantity > 0
  `);
  const stats = statsQuery.rows[0] as {
    purchaseCount: number;
    totalReceivedValue: number;
    productCount: number;
    lastPurchaseDate: string | Date | null;
  };

  return {
    supplier: {
      id: supplier.id,
      name: supplier.name,
      phone: supplier.phone,
      email: supplier.email,
      address: supplier.address,
      status: supplier.status,
      minimumOrderValue:
        supplier.minimumOrderValue === null
          ? null
          : Number(supplier.minimumOrderValue),
      targetOrderValue:
        supplier.targetOrderValue === null
          ? null
          : Number(supplier.targetOrderValue),
      orderSettingsEnabled: supplier.orderSettingsEnabled,
      orderSettingsNotes: supplier.orderSettingsNotes,
    },
    stats: {
      purchaseCount: Number(stats?.purchaseCount ?? 0),
      totalReceivedValue: Number(stats?.totalReceivedValue ?? 0),
      productCount: Number(stats?.productCount ?? 0),
      lastPurchaseDate: stats?.lastPurchaseDate ?? null,
    },
  };
}

export interface SupplierPriceHistoryParams {
  page: number;
  limit: number;
  search?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * This supplier's received prices per variant — the price-overview
 * aggregation with the supplier filter forced on, so each row only
 * aggregates purchases FROM this supplier and quotes FROM this supplier.
 */
export async function getSupplierPriceHistory(
  businessId: number,
  supplierId: number,
  params: SupplierPriceHistoryParams,
): Promise<{ data: PriceOverviewRow[]; total: number; page: number; limit: number }> {
  const [supplier] = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)))
    .limit(1);
  if (!supplier) throw new NotFoundError("Supplier not found.");

  const overviewParams: PriceOverviewQuery = {
    page: params.page,
    limit: params.limit,
    search: params.search,
    supplierId,
    from: params.from,
    to: params.to,
  };
  return getPriceOverview(businessId, overviewParams);
}

/** Re-exported for tests that need the shared events definition. */
export { receivedEventsCte };

/**
 * Supplier order-value settings (Feature D). The minimum order value is
 * the supplier's requirement, the target order value is the business's
 * own spending goal — configured independently, never derived from each
 * other. Omitted fields stay unchanged; explicit nulls clear them.
 */
export async function updateSupplierOrderSettings(
  businessId: number,
  supplierId: number,
  input: UpdateOrderSettingsInput,
): Promise<SupplierDetail> {
  const [supplier] = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)))
    .limit(1);
  if (!supplier) throw new NotFoundError("Supplier not found.");

  await db
    .update(suppliers)
    .set({
      ...(input.minimumOrderValue !== undefined
        ? { minimumOrderValue: input.minimumOrderValue }
        : {}),
      ...(input.targetOrderValue !== undefined
        ? { targetOrderValue: input.targetOrderValue }
        : {}),
      ...(input.orderSettingsEnabled !== undefined
        ? { orderSettingsEnabled: input.orderSettingsEnabled }
        : {}),
      ...(input.orderSettingsNotes !== undefined
        ? { orderSettingsNotes: input.orderSettingsNotes }
        : {}),
    })
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)));

  return getSupplierDetail(businessId, supplierId);
}

export interface SupplierVariantEvent {
  purchaseId: number;
  purchaseOrderNumber: string;
  purchaseDate: string | Date;
  unitCost: number;
  receivedQuantity: number;
}

/**
 * This supplier's received price events for one variant (chronological
 * ascending) — feeds the supplier price trend chart. Purchase-derived:
 * quotations are never part of the trend.
 */
export async function getSupplierVariantTrend(
  businessId: number,
  supplierId: number,
  variantId: number,
): Promise<SupplierVariantEvent[]> {
  const events = receivedEventsCte(businessId, { supplierId });
  const query = await db.execute(sql`
    ${events}
    SELECT
      e.purchase_id AS "purchaseId",
      p.purchase_order_number AS "purchaseOrderNumber",
      e.purchase_date,
      e.unit_cost::float8 AS "unitCost",
      e.received_quantity::float8 AS "receivedQuantity"
    FROM events e
    JOIN purchases p ON p.id = e.purchase_id
    WHERE e.variant_id = ${variantId}
    ORDER BY e.purchase_date ASC, e.item_id ASC
    LIMIT 200
  `);
  return query.rows as unknown as SupplierVariantEvent[];
}
