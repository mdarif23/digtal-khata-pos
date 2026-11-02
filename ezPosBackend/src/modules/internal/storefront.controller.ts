import type { Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/schema/index.js";
import { businesses } from "../../db/schema/businesses.js";
import { customers } from "../../db/schema/customers.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { sales } from "../../db/schema/sales.js";
import { storefronts } from "../../db/schema/storefronts.js";
import { storefrontDeliveryZones } from "../../db/schema/storefrontDeliveryZones.js";
import { storefrontPages } from "../../db/schema/storefrontPages.js";
import { storefrontPaymentMethods } from "../../db/schema/storefrontPaymentMethods.js";
import { storefrontPublishVersions } from "../../db/schema/storefrontPublishVersions.js";
import {
  listStorefrontProducts,
  getStorefrontProduct,
  listStorefrontCategories,
  listStorefrontBrands,
} from "../storefront/storefront.catalog.service.js";
import type { StorefrontContext } from "../../middleware/storefront.js";
import {
  createOnlineOrder,
  confirmOnlineOrder,
} from "../commerce/orders.service.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";

/**
 * Shopper-facing internal endpoints for the ezPosStorefront renderer.
 * Authenticated by the shared internal token (x-internal-token) — never by
 * user sessions or storefront API keys. All reads are scoped to the
 * storefront's business; catalog reads honor the storefront's opt-in
 * visibility; orders flow through the unified online-order workflow
 * (server-side prices, reservations, FIFO stock consumption).
 *
 * SECURITY CONTRACT: only public fields are ever returned — no cost,
 * supplier, or private inventory data.
 */

function parseId(raw: string, label: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestError(`A valid ${label} is required.`);
  }
  return id;
}

async function requirePublishedStorefront(storefrontId: number) {
  const [row] = await db
    .select({
      id: storefronts.id,
      businessId: storefronts.businessId,
      status: storefronts.status,
      storePickupEnabled: storefronts.storePickupEnabled,
      mode: businesses.mode,
      businessStatus: businesses.status,
    })
    .from(storefronts)
    .innerJoin(businesses, eq(businesses.id, storefronts.businessId))
    .where(eq(storefronts.id, storefrontId))
    .limit(1);
  if (!row) throw new NotFoundError("Storefront not found.");
  if (row.businessStatus === "suspended" || row.status === "suspended") {
    throw new BadRequestError("This store is not accepting orders right now.");
  }
  if (row.status !== "published") {
    throw new BadRequestError("This store is not open yet.");
  }
  if (row.mode === "physical_only") {
    throw new BadRequestError("This store cannot accept online orders.");
  }
  return row;
}

function catalogContext(businessId: number): StorefrontContext {
  return {
    keyId: 0,
    businessId,
    integrationId: null,
    scopes: [],
    isPublishable: false,
    mode: "online_only",
  };
}

/** Full render payload: published config + pages + delivery zones. */
export async function getConfig(req: Request, res: Response) {
  try {
    const storefrontId = parseId(String(req.query.storefrontId ?? ""), "storefront ID");
    const previewToken = typeof req.query.preview === "string" ? req.query.preview : "";
    const { verifyPreviewToken } = await import("../storefronts/previewToken.js");

    const [storefront] = await db
      .select()
      .from(storefronts)
      .where(eq(storefronts.id, storefrontId))
      .limit(1);
    if (!storefront) throw new NotFoundError("Storefront not found.");

    const isPreview =
      previewToken !== "" &&
      (await verifyPreviewToken(previewToken))?.storefrontId === storefrontId;

    let config: Record<string, unknown> | null = null;
    if (isPreview) {
      config = storefront.draftConfig;
    } else {
      if (storefront.status !== "published" || !storefront.publishedVersionId) {
        return res.status(200).json({ success: true, data: { available: false } });
      }
      const [version] = await db
        .select({ config: storefrontPublishVersions.config })
        .from(storefrontPublishVersions)
        .where(eq(storefrontPublishVersions.id, storefront.publishedVersionId))
        .limit(1);
      if (!version) {
        return res.status(200).json({ success: true, data: { available: false } });
      }
      config = version.config;
    }

    const pages = await db
      .select({
        id: storefrontPages.id,
        slug: storefrontPages.slug,
        title: storefrontPages.title,
        blocks: storefrontPages.blocks,
        seoTitle: storefrontPages.seoTitle,
        seoDescription: storefrontPages.seoDescription,
        isPublished: storefrontPages.isPublished,
      })
      .from(storefrontPages)
      .where(eq(storefrontPages.storefrontId, storefrontId));
    const methods = await db
      .select({
        method: storefrontPaymentMethods.method,
        label: storefrontPaymentMethods.label,
      })
      .from(storefrontPaymentMethods)
      .where(
        and(
          eq(storefrontPaymentMethods.storefrontId, storefrontId),
          eq(storefrontPaymentMethods.enabled, true),
        ),
      );
    const zones = await db
      .select({
        id: storefrontDeliveryZones.id,
        name: storefrontDeliveryZones.name,
        areas: storefrontDeliveryZones.areas,
        rate: storefrontDeliveryZones.rate,
        freeThreshold: storefrontDeliveryZones.freeThreshold,
        estimatedDaysMin: storefrontDeliveryZones.estimatedDaysMin,
        estimatedDaysMax: storefrontDeliveryZones.estimatedDaysMax,
      })
      .from(storefrontDeliveryZones)
      .where(
        and(
          eq(storefrontDeliveryZones.storefrontId, storefrontId),
          eq(storefrontDeliveryZones.isActive, true),
        ),
      );

    res.status(200).json({
      success: true,
      data: {
        available: true,
        source: isPreview ? "preview" : "published",
        storefront: {
          id: storefront.id,
          businessId: storefront.businessId,
          name: storefront.name,
          subdomain: storefront.subdomain,
          themeId: storefront.themeId,
          config,
          seo: storefront.seo ?? null,
          contact: storefront.contact ?? null,
          flags: {
            storePickupEnabled: storefront.storePickupEnabled,
            analyticsEnabled: storefront.analyticsEnabled,
            searchIndexingEnabled: storefront.searchIndexingEnabled,
          },
        },
        pages: isPreview ? pages : pages.filter((page) => page.isPublished !== false),
        zones,
        paymentMethods: methods,
      },
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load the storefront.");
  }
}

export async function getCatalog(req: Request, res: Response) {
  try {
    const storefrontId = parseId(String(req.query.storefrontId ?? ""), "storefront ID");
    const storefront = await requirePublishedStorefront(storefrontId);

    const page = Number(req.query.page ?? "1");
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined;
    const brandId = req.query.brandId ? Number(req.query.brandId) : undefined;
    const sort =
      req.query.sort === "price_asc" ||
      req.query.sort === "price_desc" ||
      req.query.sort === "name"
        ? req.query.sort
        : "newest";

    const ctx = catalogContext(storefront.businessId);
    const [productsResult, categories, brands] = await Promise.all([
      listStorefrontProducts(ctx, {
        search,
        categoryId,
        brandId,
        sort,
        page: Number.isInteger(page) && page > 0 ? page : 1,
        pageSize: 12,
        storefrontId,
      }),
      listStorefrontCategories(storefront.businessId),
      listStorefrontBrands(storefront.businessId),
    ]);

    res.status(200).json({
      success: true,
      data: { ...productsResult, categories, brands },
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load the catalog.");
  }
}

export async function getProduct(req: Request, res: Response) {
  try {
    const storefrontId = parseId(String(req.query.storefrontId ?? ""), "storefront ID");
    const storefront = await requirePublishedStorefront(storefrontId);
    const productId = parseId(String(req.params.productId), "product ID");

    const product = await getStorefrontProduct(
      catalogContext(storefront.businessId),
      productId,
      { storefrontId },
    );
    if (!product) throw new NotFoundError("Product not found.");
    res.status(200).json({ success: true, data: product });
  } catch (err) {
    sendSafeError(res, err, "Unable to load the product.");
  }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

const checkoutSchema = z.object({
  storefrontId: z.number().int().positive(),
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().min(6).max(20),
    email: z.string().trim().email().max(255).optional(),
    address: z.string().trim().min(4).max(500),
    city: z.string().trim().min(1).max(100),
    area: z.string().trim().max(100).optional(),
    note: z.string().trim().max(500).optional(),
  }),
  lines: z
    .array(
      z.object({
        variantId: z.number().int().positive(),
        quantity: z.number().int().min(1).max(99),
      }),
    )
    .min(1)
    .max(50),
  /** Server re-validates the zone and computes the fee — never client trust. */
  deliveryZoneId: z.number().int().positive().nullable().optional(),
  storePickup: z.boolean().optional(),
  idempotencyKey: z.string().trim().min(8).max(80),
});

export async function createCheckoutOrder(req: Request, res: Response) {
  try {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(
        parsed.error.issues[0]?.message ?? "Invalid checkout data.",
      );
    }
    const input = parsed.data;
    const storefront = await requirePublishedStorefront(input.storefrontId);

    // Delivery fee is computed HERE, server-side, from the storefront's zones
    // against a server-recomputed subtotal. Client values are never trusted.
    let deliveryFee = 0;
    let deliveryLabel = "Store pickup";
    if (!input.storePickup) {
      if (!input.deliveryZoneId) {
        throw new BadRequestError("Choose a delivery area.");
      }
      const [zone] = await db
        .select()
        .from(storefrontDeliveryZones)
        .where(
          and(
            eq(storefrontDeliveryZones.id, input.deliveryZoneId),
            eq(storefrontDeliveryZones.storefrontId, input.storefrontId),
            eq(storefrontDeliveryZones.isActive, true),
          ),
        )
        .limit(1);
      if (!zone) throw new BadRequestError("Choose a delivery area.");

      const prices = await db
        .select({ id: productVariants.id, price: productVariants.sellingPrice })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.businessId, storefront.businessId),
            inArray(
              productVariants.id,
              input.lines.map((line) => line.variantId),
            ),
          ),
        );
      const priceById = new Map(prices.map((row) => [row.id, Number(row.price)]));
      const subtotal = input.lines.reduce(
        (sum, line) => sum + (priceById.get(line.variantId) ?? 0) * line.quantity,
        0,
      );
      const threshold =
        zone.freeThreshold !== null ? Number(zone.freeThreshold) : null;
      deliveryFee =
        threshold !== null && subtotal >= threshold ? 0 : Number(zone.rate);
      deliveryLabel = zone.name;
    }

    const result = await createOnlineOrder({
      businessId: storefront.businessId,
      channel: "custom_storefront",
      integrationId: null,
      customer: {
        name: input.customer.name,
        phone: input.customer.phone,
        email: input.customer.email ?? null,
        address: [
          input.customer.address,
          input.customer.area
            ? `${input.customer.area}, ${input.customer.city}`
            : input.customer.city,
        ]
          .filter(Boolean)
          .join(" · "),
      },
      lines: input.lines,
      idempotencyKey: input.idempotencyKey,
      paymentMethod: "cod",
      note: `Storefront order — delivery: ${deliveryLabel}${
        deliveryFee > 0 ? ` (delivery ৳${deliveryFee})` : " (free delivery)"
      }${input.customer.note ? ` — ${input.customer.note}` : ""}`,
    });

    // COD is confirmed immediately: stock is consumed through the existing
    // FIFO workflow and the order lands in the portal for fulfillment.
    const confirmed = result.duplicated
      ? result
      : await confirmOnlineOrder(storefront.businessId, result.saleId);

    res.status(201).json({
      success: true,
      message: "Order placed.",
      data: {
        saleId: confirmed.saleId,
        invoiceNumber: confirmed.invoiceNumber,
        status: confirmed.status,
        total: confirmed.total,
        deliveryFee,
        currency: confirmed.currency,
        duplicated: confirmed.duplicated,
      },
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to place the order right now.");
  }
}

/** Shopper order tracking: invoice number + the phone used at checkout. */
export async function trackOrder(req: Request, res: Response) {
  try {
    const schema = z.object({
      storefrontId: z.number().int().positive(),
      invoiceNumber: z.string().trim().min(3).max(40),
      phone: z.string().trim().min(6).max(20),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(
        parsed.error.issues[0]?.message ?? "Enter your order number and phone.",
      );
    }
    const { invoiceNumber, phone, storefrontId } = parsed.data;
    const storefront = await requirePublishedStorefront(storefrontId);

    const [row] = await db
      .select({
        invoiceNumber: sales.invoiceNumber,
        status: sales.status,
        paymentStatus: sales.paymentStatus,
        fulfillmentStatus: sales.fulfillmentStatus,
        finalTotal: sales.finalTotal,
        createdAt: sales.createdAt,
        customerPhone: customers.phone,
      })
      .from(sales)
      .innerJoin(customers, eq(customers.id, sales.customerId))
      .where(
        and(
          eq(sales.businessId, storefront.businessId),
          eq(sales.invoiceNumber, invoiceNumber),
        ),
      )
      .limit(1);

    const normalizedPhone = phone.replace(/[\s-]/g, "");
    const customerPhone = row?.customerPhone?.replace(/[\s-]/g, "") ?? "";
    if (!row || customerPhone !== normalizedPhone) {
      // Same response for missing order and wrong phone — no enumeration oracle.
      throw new NotFoundError("No order matches those details.");
    }

    res.status(200).json({
      success: true,
      data: {
        invoiceNumber: row.invoiceNumber,
        status: row.status,
        paymentStatus: row.paymentStatus,
        fulfillmentStatus: row.fulfillmentStatus,
        total: Number(row.finalTotal ?? 0),
        createdAt: row.createdAt,
      },
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to look up the order right now.");
  }
}
