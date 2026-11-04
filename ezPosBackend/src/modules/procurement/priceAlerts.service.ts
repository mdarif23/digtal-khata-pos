import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { priceAlertSettings } from "../../db/schema/priceAlertSettings.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { suppliers } from "../../db/schema/suppliers.js";
import { buildVariantNameFromLabel } from "../../utils/variantDisplay.js";
import type { DbTransaction } from "../purchases/purchase.types.js";
import { notifyInTx } from "../../services/notifications.js";

/**
 * Price-increase alerts (Smart Procurement Phase 3).
 *
 * Detection is EVENT-BASED: whenever a purchase is received, each received
 * line's actual unit cost is compared against that supplier's previous
 * actual price for the same variant. If the configured percentage
 * threshold is met, a factual `price_increase` notification is recorded.
 *
 * Duplicate prevention: the dedupe key encodes the exact price event
 * (business, variant, supplier, purchase). The notification helper appends
 * the current day, so a long-lived extra check on existing keys keeps the
 * alert strictly one-per-event even across partial receives on different
 * days.
 *
 * The system reports numbers only — it never labels a supplier unreliable.
 */

export interface AlertSettings {
  enabled: boolean;
  increaseThresholdPercent: number;
}

export async function getAlertSettings(
  businessId: number,
): Promise<AlertSettings> {
  const [row] = await db
    .select({
      enabled: priceAlertSettings.enabled,
      increaseThresholdPercent: priceAlertSettings.increaseThresholdPercent,
    })
    .from(priceAlertSettings)
    .where(eq(priceAlertSettings.businessId, businessId))
    .limit(1);
  if (!row) {
    return { enabled: false, increaseThresholdPercent: 10 };
  }
  return {
    enabled: row.enabled,
    increaseThresholdPercent: Number(row.increaseThresholdPercent),
  };
}

export async function updateAlertSettings(
  businessId: number,
  input: AlertSettings,
): Promise<AlertSettings> {
  await db
    .insert(priceAlertSettings)
    .values({
      businessId,
      enabled: input.enabled,
      increaseThresholdPercent: input.increaseThresholdPercent,
    })
    .onConflictDoUpdate({
      target: priceAlertSettings.businessId,
      set: {
        enabled: input.enabled,
        increaseThresholdPercent: input.increaseThresholdPercent,
        updatedAt: new Date(),
      },
    });
  return getAlertSettings(businessId);
}

export interface ReceivedPriceItem {
  variantId: number;
  unitCost: number;
  receiveNow: number;
}

function money(value: number): string {
  return value.toFixed(2);
}

/**
 * Called inside the purchase-receiving transaction with the lines that
 * were just received. Reads the business's alert settings, compares each
 * received unit cost against that supplier's previous actual price for
 * the variant, and records a deduplicated notification when the threshold
 * is met. Never throws for data reasons — alerting must not fail a
 * legitimate receive.
 */
export async function checkPriceIncreasesInTx(
  tx: DbTransaction,
  params: {
    businessId: number;
    purchaseId: number;
    supplierId: number | null;
    items: ReceivedPriceItem[];
  },
): Promise<void> {
  const { businessId, purchaseId, supplierId, items } = params;
  if (!supplierId) return;
  const received = items.filter((item) => item.receiveNow > 0);
  if (received.length === 0) return;

  const [settings] = await tx
    .select({
      enabled: priceAlertSettings.enabled,
      increaseThresholdPercent: priceAlertSettings.increaseThresholdPercent,
    })
    .from(priceAlertSettings)
    .where(eq(priceAlertSettings.businessId, businessId))
    .limit(1);
  if (!settings || !settings.enabled) return;
  const threshold = Number(settings.increaseThresholdPercent);

  const variantIds = [...new Set(received.map((item) => item.variantId))];
  const nameRows = await tx
    .select({
      id: productVariants.id,
      productName: products.name,
      variantOptions: sql<string | null>`(
        SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
        FROM variant_values vv
        JOIN variant_options vo ON vo.id = vv.option_id
        WHERE vv.variant_id = ${productVariants.id}
      )`,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(productVariants.businessId, businessId),
        inArray(productVariants.id, variantIds),
      ),
    );
  const productNames = new Map(
    nameRows.map((row) => [
      row.id,
      buildVariantNameFromLabel(row.productName, row.variantOptions),
    ]),
  );

  const [supplier] = await tx
    .select({ name: suppliers.name })
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)))
    .limit(1);
  const supplierName = supplier?.name ?? "Unknown supplier";

  for (const item of received) {
    const previousResult = await tx.execute(sql`
      SELECT pi.unit_cost::float8 AS "previousPrice"
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi.purchase_id
      WHERE pi.business_id = ${businessId}
        AND p.business_id = ${businessId}
        AND pi.variant_id = ${item.variantId}
        AND p.supplier_id = ${supplierId}
        AND p.id <> ${purchaseId}
        AND pi.received_quantity > 0
        AND p.status IN ('received', 'partially_received')
      ORDER BY p.purchase_date DESC, pi.id DESC
      LIMIT 1
    `);
    const previousRow = previousResult.rows[0] as
      | { previousPrice: number }
      | undefined;
    const previousPrice = previousRow?.previousPrice;
    if (previousPrice === undefined || previousPrice <= 0) continue;
    if (item.unitCost <= previousPrice) continue;

    const percentChange = Number(
      (((item.unitCost - previousPrice) / previousPrice) * 100).toFixed(2),
    );
    if (percentChange < threshold) continue;

    // One alert per price event, ever — survive the day-suffix dedupe.
    const keyBase = `price_increase:${businessId}:${item.variantId}:${supplierId}:${purchaseId}`;
    const existing = await tx.execute(sql`
      SELECT 1 FROM notifications
      WHERE business_id = ${businessId}
        AND dedupe_key LIKE ${`${keyBase}:%`}
      LIMIT 1
    `);
    if (existing.rows.length > 0) continue;


    const productName = productNames.get(item.variantId) ?? "a product";
    await notifyInTx(tx, {
      businessId,
      kind: "price_increase",
      severity: "warning",
      title: `Price increase: ${productName}`,
      body: `${money(previousPrice)} → ${money(item.unitCost)} (+${percentChange}%) from ${supplierName}.`,
      payload: {
        variantId: item.variantId,
        supplierId,
        purchaseId,
        previousPrice,
        currentPrice: item.unitCost,
        percentChange,
      },
      dedupeKey: keyBase,
    });
  }
}
