import type { Request, Response } from "express";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/schema/index.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { saleItems } from "../../db/schema/saleItems.js";
import { sales } from "../../db/schema/sales.js";
import { storefrontAnalyticsEvents } from "../../db/schema/storefrontAnalyticsEvents.js";
import { storefronts } from "../../db/schema/storefronts.js";
import { getBusinessId } from "../../middleware/business.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import { sendSafeError } from "../../utils/safeError.js";
import { requireStorefront } from "./storefronts.service.js";

/**
 * Storefront analytics (stage 6). Tracked metrics come from the beacon
 * table; orders/revenue come from the unified sales table (channel
 * custom_storefront). Everything below is MEASURED — no estimated numbers
 * are presented as tracked.
 */

const beaconSchema = z.object({
  storefrontId: z.number().int().positive(),
  eventType: z.enum(["visit", "product_view", "add_to_cart", "checkout_start"]),
  path: z.string().trim().max(300).optional(),
  productId: z.number().int().positive().optional(),
  visitorRef: z.string().trim().max(64).optional(),
});

/** Beacon sink for the renderer bridge. Fails closed on unknown stores. */
export async function recordAnalyticsEvent(req: Request, res: Response) {
  try {
    const parsed = beaconSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(
        parsed.error.issues[0]?.message ?? "Invalid analytics event.",
      );
    }
    const input = parsed.data;
    const [storefront] = await db
      .select({
        id: storefronts.id,
        status: storefronts.status,
        analyticsEnabled: storefronts.analyticsEnabled,
      })
      .from(storefronts)
      .where(eq(storefronts.id, input.storefrontId))
      .limit(1);
    if (!storefront || storefront.status !== "published") {
      // Silent accept (no error to probe storefront existence with) — but
      // nothing is recorded for non-published stores.
      return res.status(200).json({ success: true });
    }
    if (!storefront.analyticsEnabled) {
      return res.status(200).json({ success: true });
    }
    await db.insert(storefrontAnalyticsEvents).values({
      storefrontId: storefront.id,
      eventType: input.eventType,
      path: input.path ?? null,
      productId: input.productId ?? null,
      visitorRef: input.visitorRef ?? null,
    });
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Analytics beacon failed:", err);
    // Beacons are fire-and-forget: never surface errors to shoppers.
    res.status(200).json({ success: true });
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Portal aggregates for one storefront (business-scoped via membership). */
export async function getStorefrontAnalytics(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const storefrontId = Number(req.params.storefrontId);
    if (!Number.isInteger(storefrontId) || storefrontId <= 0) {
      throw new BadRequestError("A valid storefront ID is required.");
    }
    await requireStorefront(businessId, storefrontId);

    const days = Math.min(90, Math.max(1, Number(req.query.days ?? 30) || 30));
    const since = new Date(Date.now() - days * DAY_MS);

    const counts = await db
      .select({
        eventType: storefrontAnalyticsEvents.eventType,
        n: sql<number>`count(*)::int`,
      })
      .from(storefrontAnalyticsEvents)
      .where(
        and(
          eq(storefrontAnalyticsEvents.storefrontId, storefrontId),
          gte(storefrontAnalyticsEvents.occurredAt, since),
        ),
      )
      .groupBy(storefrontAnalyticsEvents.eventType);
    const countByType = new Map(counts.map((row) => [row.eventType, row.n]));

    // Orders + revenue across the business's storefront channel (orders are
    // linked to the business; storefront attribution is aggregate-level).
    const [orderStats] = await db
      .select({
        orders: sql<number>`count(*)::int`,
        revenue: sql<number>`coalesce(sum(${sales.finalTotal}), 0)::float`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.businessId, businessId),
          eq(sales.channel, "custom_storefront"),
          inArray(sales.status, ["completed", "pending"]),
          gte(sales.createdAt, since),
        ),
      );

    // Best sellers by quantity sold in the window (top 5).
    const bestSellers = await db
      .select({
        productId: products.id,
        name: products.name,
        quantity: sql<number>`sum(${saleItems.quantity})::int`,
      })
      .from(saleItems)
      .innerJoin(sales, eq(sales.id, saleItems.saleId))
      .innerJoin(productVariants, eq(productVariants.id, saleItems.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(sales.businessId, businessId),
          eq(sales.channel, "custom_storefront"),
          inArray(sales.status, ["completed", "pending"]),
          gte(sales.createdAt, since),
        ),
      )
      .groupBy(products.id, products.name)
      .orderBy(desc(sql`sum(${saleItems.quantity})`))
      .limit(5);

    const visits = countByType.get("visit") ?? 0;
    const productViews = countByType.get("product_view") ?? 0;
    const addToCarts = countByType.get("add_to_cart") ?? 0;
    const checkoutStarts = countByType.get("checkout_start") ?? 0;
    const orders = orderStats?.orders ?? 0;

    res.status(200).json({
      success: true,
      data: {
        days,
        tracked: {
          visits,
          productViews,
          addToCarts,
          checkoutStarts,
        },
        orders,
        revenue: Number((orderStats?.revenue ?? 0).toFixed(2)),
        conversionRate:
          visits > 0 ? Number(((orders / visits) * 100).toFixed(1)) : null,
        bestSellers,
        notes: [
          "Orders and revenue are measured from your ezPos online orders.",
          visits === 0
            ? "Visits show as 0 until tracking is enabled and the store receives traffic."
            : null,
        ].filter((note): note is string => note !== null),
      },
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load analytics right now.");
  }
}
