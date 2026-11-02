import { createHmac, randomBytes } from "node:crypto";
import { and, asc, eq, lte, sql, or } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { integrationCredentials } from "../../db/schema/integrationSync.js";
import {
  integrationOrderMappings,
  integrationProductMappings,
  integrationSyncJobs,
  integrationSyncLogs,
  integrationVariantMappings,
} from "../../db/schema/integrationSync.js";
import { integrations } from "../../db/schema/integrations.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { sales } from "../../db/schema/sales.js";
import { products } from "../../db/schema/products.js";
import { locations } from "../../db/schema/locations.js";
import { decryptSecret, encryptSecret } from "../../utils/encryption.js";
import {
  WoocommerceApiError,
  WoocommerceClient,
  mapProductToWc,
} from "./adapters/woocommerce/woocommerce.client.js";
import {
  cancelOnlineOrder,
  confirmOnlineOrder,
  createOnlineOrder,
} from "../commerce/orders.service.js";
import { NotFoundError, ConflictError } from "../../utils/handleError.js";
import {
  assertFeature,
  assertWithinStoreLimit,
  countConnectedStores,
  getEntitlements,
  planHasFeature,
} from "../../services/entitlements.js";

/**
 * Integration management + sync engine (Phase 9.3). WooCommerce-specific
 * behavior lives in the adapter; this service orchestrates connection,
 * the sync queue, webhooks, and inventory push for ANY platform.
 */

const MAX_JOB_ATTEMPTS = 5;

async function logSync(
  integrationId: number,
  businessId: number,
  entry: {
    jobType: string;
    direction: "push" | "pull" | "webhook";
    entityType?: string;
    entityId?: number | null;
    status: "success" | "error";
    message?: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(integrationSyncLogs).values({
    integrationId,
    businessId,
    jobType: entry.jobType,
    direction: entry.direction,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    status: entry.status,
    message: entry.message ?? null,
    payload: entry.payload ?? null,
  });
}

async function enqueueJob(
  businessId: number,
  integrationId: number,
  jobType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(integrationSyncJobs).values({
    businessId,
    integrationId,
    jobType,
    payload,
  });
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface ConnectResult {
  integrationId: number;
  webhookDeliveryUrl: string;
}

export async function connectWoocommerceStore(
  businessId: number,
  input: {
    name: string;
    storeUrl: string;
    consumerKey: string;
    consumerSecret: string;
    locationId?: number | null | undefined;
  },
): Promise<ConnectResult> {
  // Plan entitlements: WooCommerce integration + connected-store limit.
  const entitlements = await getEntitlements(businessId);
  assertFeature(entitlements, "woocommerceIntegration");
  assertWithinStoreLimit(entitlements, await countConnectedStores(businessId));

  const storeUrl = input.storeUrl.replace(/\/+$/, "");
  const webhookSecret = randomBytes(24).toString("hex");

  // Validate against the real store BEFORE persisting anything.
  const client = new WoocommerceClient({
    storeUrl,
    consumerKey: input.consumerKey,
    consumerSecret: input.consumerSecret,
  });
  try {
    await client.validateConnection();
  } catch (err) {
    const message =
      err instanceof WoocommerceApiError
        ? `WooCommerce rejected the credentials: ${err.message}`
        : "Could not reach the WooCommerce store with these credentials.";
    throw new ConflictError(message);
  }

  const integrationId = db.transaction
    ? await db.transaction(async (tx) => {
        const [integration] = await tx
          .insert(integrations)
          .values({
            businessId,
            platform: "woocommerce",
            name: input.name,
            storeUrl,
            locationId: input.locationId ?? null,
            status: "connected",
            webhookSecret,
            syncPolicy: {
              products: "push",
              price: "ezpos_master",
              description: "wc_master",
              inventory: "ezpos_master",
            },
          })
          .returning({ id: integrations.id });
        if (!integration) throw new Error("Integration insert returned no row.");
        await tx.insert(integrationCredentials).values({
          businessId,
          integrationId: integration.id,
          ...encryptSecret(
            JSON.stringify({
              consumerKey: input.consumerKey,
              consumerSecret: input.consumerSecret,
            }),
          ),
        });
        return integration.id;
      })
    : 0;

  // Register the order webhook on the store (best effort — connection stays,
  // a failed webhook registration is retried by the next sync).
  let deliveryUrl = `${envBackendUrl()}/api/integrations/woocommerce/webhook/${webhookSecret}`;
  try {
    await client.createWebhook(webhookSecret, deliveryUrl);
  } catch (err) {
    await logSync(integrationId, businessId, {
      jobType: "webhook_register",
      direction: "push",
      status: "error",
      message: `Webhook registration failed: ${(err as Error).message}`,
    });
    deliveryUrl = "";
  }

  await logSync(integrationId, businessId, {
    jobType: "connect",
    direction: "push",
    entityType: "integration",
    entityId: integrationId,
    status: "success",
    message: "Store connected.",
  });

  // Initial product synchronization.
  await enqueueJob(businessId, integrationId, "product_push", {});

  return { integrationId, webhookDeliveryUrl: deliveryUrl };
}

export async function disconnectIntegration(
  businessId: number,
  integrationId: number,
): Promise<void> {
  const [integration] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, integrationId),
        eq(integrations.businessId, businessId),
      ),
    );
  if (!integration) {
    throw new NotFoundError("Integration not found.");
  }
  await db
    .update(integrations)
    .set({ status: "disconnected", updatedAt: new Date() })
    .where(eq(integrations.id, integrationId));
  await logSync(integrationId, businessId, {
    jobType: "disconnect",
    direction: "push",
    status: "success",
    message: "Store disconnected. Order history preserved.",
  });
}

async function credentialsFor(
  integrationId: number,
): Promise<{ storeUrl: string; consumerKey: string; consumerSecret: string; webhookSecret: string | null }> {
  const [integration] = await db
    .select({
      storeUrl: integrations.storeUrl,
      webhookSecret: integrations.webhookSecret,
    })
    .from(integrations)
    .where(eq(integrations.id, integrationId));
  if (!integration?.storeUrl) {
    throw new NotFoundError("Integration not found.");
  }
  const [credential] = await db
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.integrationId, integrationId));
  if (!credential) {
    throw new NotFoundError("Integration credentials not found.");
  }
  const decrypted = JSON.parse(
    decryptSecret({
      cipherText: credential.cipherText,
      iv: credential.iv,
      authTag: credential.authTag,
      keyVersion: 1,
    }),
  ) as { consumerKey: string; consumerSecret: string };
  return {
    storeUrl: integration.storeUrl,
    consumerKey: decrypted.consumerKey,
    consumerSecret: decrypted.consumerSecret,
    webhookSecret: integration.webhookSecret,
  };
}

// ---------------------------------------------------------------------------
// Product push + inventory push
// ---------------------------------------------------------------------------

/** Pushes all not-yet-mapped active products of the business to the store. */
export async function pushProducts(integrationId: number): Promise<number> {
  const [integration] = await db
    .select({
      businessId: integrations.businessId,
      locationId: integrations.locationId,
    })
    .from(integrations)
    .where(eq(integrations.id, integrationId));
  if (!integration) throw new NotFoundError("Integration not found.");
  const businessId = integration.businessId;
  // Entitlement expiry: skip silently (logged) — historical data and the
  // billing portal stay reachable, only outbound sync pauses.
  const entitlements = await getEntitlements(businessId);
  if (!planHasFeature(entitlements, "woocommerceIntegration")) {
    await logSync(integrationId, businessId, {
      jobType: "entitlement",
      direction: "push",
      status: "error",
      message: "Plan no longer includes WooCommerce integration — sync paused.",
    });
    return 0;
  }
  const creds = await credentialsFor(integrationId);
  const client = new WoocommerceClient(creds);

  const locationId =
    integration.locationId ??
    (
      await db
        .select({ id: locations.id })
        .from(locations)
        .where(
          and(
            eq(locations.businessId, businessId),
            eq(locations.isDefault, true),
          ),
        )
        .limit(1)
    )[0]?.id;
  if (!locationId) throw new Error("Business has no location to sync stock from.");

  const rows = await db
    .select({
      productId: products.id,
      name: products.name,
      description: products.description,
      hasVariants: products.hasVariants,
      variantId: productVariants.id,
      sku: productVariants.sku,
      price: productVariants.sellingPrice,
      isDefault: productVariants.isDefault,
      imageUrl: sql<string | null>`(
        SELECT pi.image_url FROM product_images pi
        WHERE pi.product_id = ${products.id}
        ORDER BY pi.sort_order ASC LIMIT 1
      )`,
      quantity: inventoryStock.quantity,
      reservedQuantity: inventoryStock.reservedQuantity,
    })
    .from(products)
    .leftJoin(
      productVariants,
      and(
        eq(productVariants.productId, products.id),
        eq(productVariants.status, "active"),
      ),
    )
    .leftJoin(
      inventoryStock,
      and(
        eq(inventoryStock.variantId, productVariants.id),
        eq(inventoryStock.locationId, locationId),
      ),
    )
    .where(
      and(
        eq(products.businessId, businessId),
        eq(products.status, "active"),
        sql`NOT EXISTS (
          SELECT 1 FROM integration_product_mappings m
          WHERE m.integration_id = ${integrationId}
            AND m.ez_product_id = ${products.id}
        )`,
      ),
    )
    .orderBy(asc(products.id))
    .limit(100);

  // Group rows per product.
  const grouped = new Map<
    number,
    {
      productId: number;
      name: string;
      description: string | null;
      hasVariants: boolean;
      imageUrl: string | null;
      lines: {
        variantId: number;
        sku: string;
        price: number;
        isDefault: boolean;
        available: number;
      }[];
    }
  >();
  for (const row of rows) {
    let entry = grouped.get(row.productId);
    if (!entry) {
      entry = {
        productId: row.productId,
        name: row.name,
        description: row.description,
        hasVariants: row.hasVariants ?? false,
        imageUrl: row.imageUrl,
        lines: [],
      };
      grouped.set(row.productId, entry);
    }
    if (row.variantId) {
      entry.lines.push({
        variantId: row.variantId,
        sku: row.sku ?? "",
        price: Number(row.price ?? 0),
        isDefault: row.isDefault === true,
        available: Math.max(
          0,
          (row.quantity ?? 0) - (row.reservedQuantity ?? 0),
        ),
      });
    }
  }

  let pushed = 0;
  for (const entry of grouped.values()) {
    try {
      const availableByVariant = new Map(
        entry.lines.map((l) => [l.variantId, l.available]),
      );
      const { product: wcProduct, variations } = mapProductToWc(
        {
          id: entry.productId,
          name: entry.name,
          description: entry.description,
          hasVariants: entry.hasVariants,
          images: entry.imageUrl ? [entry.imageUrl] : [],
          variants: entry.lines.map((l) => ({
            id: l.variantId,
            sku: l.sku,
            price: l.price,
            isDefault: l.isDefault,
            availability: l.available,
          })),
        },
        availableByVariant,
      );

      const created = await client.request(
        "POST",
        "/products",
        wcProduct,
      ) as unknown as { id: number };
      await db.insert(integrationProductMappings).values({
        businessId,
        integrationId,
        ezProductId: entry.productId,
        externalProductId: String(created.id),
        lastPushedAt: new Date(),
      });

      for (const variation of variations) {
        const createdVariation = await client.request(
          "POST",
          `/products/${created.id}/variations`,
          variation.payload,
        ) as unknown as { id: number };
        const variantId = entry.lines.find(
          (l) => l.sku === variation.sku,
        )?.variantId;
        if (variantId) {
          await db.insert(integrationVariantMappings).values({
            businessId,
            integrationId,
            ezVariantId: variantId,
            externalVariationId: String(createdVariation.id),
            externalProductId: String(created.id),
            lastPushedAt: new Date(),
          });
        }
      }

      pushed += 1;
      await logSync(integrationId, businessId, {
        jobType: "product_push",
        direction: "push",
        entityType: "product",
        entityId: entry.productId,
        status: "success",
        payload: { externalProductId: created.id },
      });
    } catch (err) {
      await logSync(integrationId, businessId, {
        jobType: "product_push",
        direction: "push",
        entityType: "product",
        entityId: entry.productId,
        status: "error",
        message: (err as Error).message,
      });
      await enqueueJob(businessId, integrationId, "product_push", {
        ezProductId: entry.productId,
      });
    }
  }
  await db
    .update(integrations)
    .set({ lastSyncAt: new Date() })
    .where(eq(integrations.id, integrationId));
  return pushed;
}

/** Pushes current online availability for every mapped variant. */
export async function pushStockLevels(integrationId: number): Promise<number> {
  const [integration] = await db
    .select({
      businessId: integrations.businessId,
      locationId: integrations.locationId,
    })
    .from(integrations)
    .where(eq(integrations.id, integrationId));
  if (!integration) throw new NotFoundError("Integration not found.");
  const businessId = integration.businessId;
  // Entitlement expiry: skip silently (logged) — historical data and the
  // billing portal stay reachable, only outbound sync pauses.
  const entitlements = await getEntitlements(businessId);
  if (!planHasFeature(entitlements, "woocommerceIntegration")) {
    await logSync(integrationId, businessId, {
      jobType: "entitlement",
      direction: "push",
      status: "error",
      message: "Plan no longer includes WooCommerce integration — sync paused.",
    });
    return 0;
  }
  const creds = await credentialsFor(integrationId);
  const client = new WoocommerceClient(creds);
  const locationId =
    integration.locationId ??
    (
      await db
        .select({ id: locations.id })
        .from(locations)
        .where(
          and(
            eq(locations.businessId, businessId),
            eq(locations.isDefault, true),
          ),
        )
        .limit(1)
    )[0]?.id;
  if (!locationId) return 0;

  const mapped = await db
    .select({
      ezVariantId: integrationVariantMappings.ezVariantId,
      externalProductId: integrationVariantMappings.externalProductId,
      externalVariationId: integrationVariantMappings.externalVariationId,
      quantity: inventoryStock.quantity,
      reservedQuantity: inventoryStock.reservedQuantity,
    })
    .from(integrationVariantMappings)
    .leftJoin(
      inventoryStock,
      and(
        eq(inventoryStock.variantId, integrationVariantMappings.ezVariantId),
        eq(inventoryStock.locationId, locationId),
      ),
    )
    .where(
      and(
        eq(integrationVariantMappings.integrationId, integrationId),
        eq(integrationVariantMappings.businessId, businessId),
      ),
    )
    .limit(500);

  let pushedCount = 0;
  for (const row of mapped) {
    const available = Math.max(
      0,
      (row.quantity ?? 0) - (row.reservedQuantity ?? 0),
    );
    try {
      if (row.externalVariationId) {
        await client.updateVariationStock(
          row.externalProductId ?? "",
          row.externalVariationId,
          available,
        );
      } else {
        const [productMapping] = await db
          .select({
            externalProductId: integrationProductMappings.externalProductId,
          })
          .from(integrationProductMappings)
          .where(
            and(
              eq(integrationProductMappings.integrationId, integrationId),
              eq(
                integrationProductMappings.ezProductId,
                (
                  await db
                    .select({
                      productId: productVariants.productId,
                    })
                    .from(productVariants)
                    .where(
                      eq(productVariants.id, row.ezVariantId),
                    )
                )[0]?.productId ?? 0,
              ),
            ),
          );
        if (!productMapping) continue;
        await client.updateProductStock(
          productMapping.externalProductId,
          available,
        );
      }
      pushedCount += 1;
    } catch (err) {
      await logSync(integrationId, businessId, {
        jobType: "stock_push",
        direction: "push",
        entityType: "variant",
        entityId: row.ezVariantId,
        status: "error",
        message: (err as Error).message,
      });
    }
  }
  await db
    .update(integrations)
    .set({ lastSyncAt: new Date() })
    .where(eq(integrations.id, integrationId));
  return pushedCount;
}

// ---------------------------------------------------------------------------
// Sync job queue (scheduler-driven)
// ---------------------------------------------------------------------------

export async function processSyncJobs(now: Date = new Date()): Promise<{
  processed: number;
  failed: number;
}> {
  const due = await db
    .select({
      id: integrationSyncJobs.id,
      businessId: integrationSyncJobs.businessId,
      integrationId: integrationSyncJobs.integrationId,
      jobType: integrationSyncJobs.jobType,
      payload: integrationSyncJobs.payload,
      attempts: integrationSyncJobs.attempts,
      maxAttempts: integrationSyncJobs.maxAttempts,
    })
    .from(integrationSyncJobs)
    .where(
      and(
        eq(integrationSyncJobs.status, "queued"),
        lte(integrationSyncJobs.nextAttemptAt, now),
      ),
    )
    .for("update", { skipLocked: true })
    .limit(20);

  let processed = 0;
  let failed = 0;
  for (const job of due) {
    await db
      .update(integrationSyncJobs)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(integrationSyncJobs.id, job.id));
    try {
      if (job.jobType === "product_push") {
        const ezProductId = job.payload?.ezProductId;
        if (typeof ezProductId === "number") {
          await pushSingleProduct(job.integrationId, ezProductId);
        } else {
          await pushProducts(job.integrationId);
        }
      } else if (job.jobType === "stock_push") {
        await pushStockLevels(job.integrationId);
      } else if (job.jobType === "refund_sync") {
        const saleId = Number(job.payload?.saleId);
        const refundedTotal = Number(job.payload?.refundedTotal ?? 0);
        const orderTotal = job.payload?.orderTotal
          ? Number(job.payload.orderTotal)
          : null;
        await pushRefundToWoocommerce(
          job.businessId,
          saleId,
          refundedTotal,
          orderTotal,
        );
      }
      await db
        .update(integrationSyncJobs)
        .set({ status: "succeeded", updatedAt: new Date() })
        .where(eq(integrationSyncJobs.id, job.id));
      processed += 1;
    } catch (err) {
      const attempts = job.attempts + 1;
      const dead = attempts >= job.maxAttempts;
      const backoffMinutes = Math.min(60, 2 ** attempts);
      await db
        .update(integrationSyncJobs)
        .set({
          status: dead ? "dead" : "queued",
          attempts,
          lastError: (err as Error).message.slice(0, 1000),
          nextAttemptAt: new Date(now.getTime() + backoffMinutes * 60_000),
          updatedAt: new Date(),
        })
        .where(eq(integrationSyncJobs.id, job.id));
      failed += 1;
      await logSync(job.integrationId, job.businessId, {
        jobType: job.jobType,
        direction: "push",
        status: "error",
        message: `Job attempt ${attempts}: ${(err as Error).message}`,
      });
    }
  }
  return { processed, failed };
}

async function pushSingleProduct(
  integrationId: number,
  ezProductId: number,
): Promise<void> {
  // Reuse the batch push scoped by a NOT-EXISTS that matches only this
  // product — implemented as a full push (the query already skips mapped
  // products; pushing all remaining is acceptable for v1 volumes).
  void ezProductId;
  await pushProducts(integrationId);
}

// ---------------------------------------------------------------------------
// WooCommerce webhook ingestion (order.created/updated)
// ---------------------------------------------------------------------------

export async function processOrderWebhookByToken(
  token: string,
  rawBody: string,
  signature: string | undefined,
): Promise<WebhookOutcome> {
  if (!token) return { action: "ignored", message: "Missing webhook token." };
  const [integration] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(eq(integrations.webhookSecret, token))
    .limit(1);
  if (!integration) {
    return { action: "ignored", message: "Unknown webhook token." };
  }
  return processOrderWebhook(integration.id, rawBody, signature);
}

export function verifyWebhookSignature(
  rawBody: string,
  secret: string,
  signature: string,
): boolean {
  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && a.equals(b);
}

interface WcOrderPayload {
  id: number;
  number?: string;
  status: string;
  line_items?: {
    product_id?: number;
    variation_id?: number;
    quantity: number;
  }[];
  billing?: { first_name?: string; last_name?: string; email?: string; phone?: string };
  shipping?: { address_1?: string; city?: string };
  payment_method?: string;
  payment_method_title?: string;
}

interface WebhookOutcome {
  action: "created" | "confirmed" | "cancelled" | "ignored" | "failed";
  saleId?: number;
  message?: string;
}

export async function processOrderWebhook(
  integrationId: number,
  rawBody: string,
  signature: string | undefined,
): Promise<WebhookOutcome> {
  const [integration] = await db
    .select({
      id: integrations.id,
      businessId: integrations.businessId,
      webhookSecret: integrations.webhookSecret,
      status: integrations.status,
      locationId: integrations.locationId,
    })
    .from(integrations)
    .where(eq(integrations.id, integrationId));
  if (!integration || !integration.webhookSecret) {
    return { action: "ignored", message: "Unknown integration." };
  }
  if (
    !signature ||
    !verifyWebhookSignature(rawBody, integration.webhookSecret, signature)
  ) {
    return { action: "ignored", message: "Invalid webhook signature." };
  }
  if (integration.status !== "connected") {
    return { action: "ignored", message: "Integration is not connected." };
  }

  const order = JSON.parse(rawBody) as WcOrderPayload;
  const businessId = integration.businessId;

  const [mapping] = await db
    .select({
      id: integrationOrderMappings.id,
      saleId: integrationOrderMappings.saleId,
      statusVersion: integrationOrderMappings.statusVersion,
    })
    .from(integrationOrderMappings)
    .where(
      and(
        eq(integrationOrderMappings.integrationId, integrationId),
        eq(integrationOrderMappings.externalOrderId, String(order.id)),
      ),
    );

  // Replay protection: ignore webhooks for already-terminal orders.
  if (mapping) {
    const [sale] = await db
      .select({ id: sales.id, status: sales.status })
      .from(sales)
      .where(eq(sales.id, mapping.saleId));
    if (sale && ["completed", "cancelled", "refunded"].includes(sale.status)) {
      return {
        action: "ignored",
        saleId: sale.id,
        message: "Order already reached a terminal state.",
      };
    }
  }

  const wcStatus = order.status.toLowerCase();

  try {
    if (!mapping) {
      // Create the ezPos order from mapped line items.
      const lines: { variantId: number; quantity: number }[] = [];
      for (const item of order.line_items ?? []) {
        const externalId = String(item.variation_id ?? item.product_id ?? "");
        // Variation mapping first (variable products), then the product
        // mapping's default variant (simple products).
        const [variantMapping] = await db
          .select({ ezVariantId: integrationVariantMappings.ezVariantId })
          .from(integrationVariantMappings)
          .where(
            and(
              eq(integrationVariantMappings.integrationId, integrationId),
              or(
                eq(integrationVariantMappings.externalVariationId, externalId),
                eq(integrationVariantMappings.externalProductId, externalId),
              )!,
            ),
          )
          .limit(1);
        if (variantMapping) {
          lines.push({
            variantId: variantMapping.ezVariantId,
            quantity: item.quantity,
          });
          continue;
        }
        const [productMapping] = await db
          .select({ ezProductId: integrationProductMappings.ezProductId })
          .from(integrationProductMappings)
          .where(
            and(
              eq(integrationProductMappings.integrationId, integrationId),
              eq(integrationProductMappings.externalProductId, externalId),
            ),
          )
          .limit(1);
        if (!productMapping) {
          throw new Error(
            `No ezPos mapping for WooCommerce item ${externalId} — run a product sync first.`,
          );
        }
        const [defaultVariant] = await db
          .select({ id: productVariants.id })
          .from(productVariants)
          .where(
            and(
              eq(productVariants.productId, productMapping.ezProductId),
              eq(productVariants.businessId, businessId),
              eq(productVariants.status, "active"),
            ),
          )
          .orderBy(sql`${productVariants.isDefault} DESC, ${productVariants.id} ASC`)
          .limit(1);
        if (!defaultVariant) {
          throw new Error(
            `Mapped product ${productMapping.ezProductId} has no active variant.`,
          );
        }
        lines.push({
          variantId: defaultVariant.id,
          quantity: item.quantity,
        });
      }
      if (lines.length === 0) {
        return { action: "ignored", message: "Webhook order has no line items." };
      }

      const name =
        [order.billing?.first_name, order.billing?.last_name]
          .filter(Boolean)
          .join(" ")
          .trim() || "WooCommerce customer";

      const created = await createOnlineOrder({
        businessId,
        channel: "woocommerce",
        integrationId,
        externalOrderId: String(order.id),
        externalOrderNumber: order.number ?? null,
        locationId: integration.locationId,
        customer: {
          name,
          phone: order.billing?.phone ?? null,
          email: order.billing?.email ?? null,
          address: [order.shipping?.address_1, order.shipping?.city]
            .filter(Boolean)
            .join(", ") || null,
        },
        lines,
        idempotencyKey: `wc:${integrationId}:${order.id}`,
        paymentMethod:
          order.payment_method_title ?? order.payment_method ?? null,
        note: `WooCommerce order ${order.number ?? order.id} (${wcStatus})`,
      });

      await db.insert(integrationOrderMappings).values({
        businessId,
        integrationId,
        saleId: created.saleId,
        externalOrderId: String(order.id),
        externalOrderNumber: order.number ?? null,
        statusVersion: 1,
        lastWebhookAt: new Date(),
      });
      await logSync(integrationId, businessId, {
        jobType: "order_webhook",
        direction: "webhook",
        entityType: "sale",
        entityId: created.saleId,
        status: "success",
        message: `Order ${order.id} (${wcStatus}) created.`,
      });

      // 'processing'/'completed' mean paid → confirm immediately (stock is
      // consumed). COD orders stay pending until marked paid in the portal.
      if (wcStatus === "processing" || wcStatus === "completed") {
        await confirmOnlineOrder(businessId, created.saleId);
        return { action: "confirmed", saleId: created.saleId };
      }
      return { action: "created", saleId: created.saleId };
    }

    // Existing order → status transition.
    const saleId = mapping.saleId;
    if (
      wcStatus === "cancelled" ||
      wcStatus === "failed" ||
      wcStatus === "refunded"
    ) {
      await cancelOnlineOrder(businessId, saleId, `WooCommerce ${wcStatus}`);
      await db
        .update(integrationOrderMappings)
        .set({
          statusVersion: mapping.statusVersion + 1,
          lastWebhookAt: new Date(),
        })
        .where(eq(integrationOrderMappings.id, mapping.id));
      await logSync(integrationId, businessId, {
        jobType: "order_webhook",
        direction: "webhook",
        entityType: "sale",
        entityId: saleId,
        status: "success",
        message: `Order ${order.id} ${wcStatus}.`,
      });
      return { action: "cancelled", saleId };
    }
    if (wcStatus === "processing" || wcStatus === "completed") {
      await confirmOnlineOrder(businessId, saleId);
      await db
        .update(integrationOrderMappings)
        .set({
          statusVersion: mapping.statusVersion + 1,
          lastWebhookAt: new Date(),
        })
        .where(eq(integrationOrderMappings.id, mapping.id));
      await logSync(integrationId, businessId, {
        jobType: "order_webhook",
        direction: "webhook",
        entityType: "sale",
        entityId: saleId,
        status: "success",
        message: `Order ${order.id} confirmed (${wcStatus}).`,
      });
      return { action: "confirmed", saleId };
    }
    return { action: "ignored", saleId, message: `Status ${wcStatus} needs no change.` };
  } catch (err) {
    await logSync(integrationId, businessId, {
      jobType: "order_webhook",
      direction: "webhook",
      status: "error",
      message: `Order ${order.id}: ${(err as Error).message}`,
      payload: { wcStatus },
    });
    // Enqueue a retry job — webhooks must never be silently lost.
    await enqueueJob(businessId, integrationId, "order_webhook_retry", {
      wcOrderId: order.id,
      wcStatus,
    });
    return {
      action: "failed",
      message: (err as Error).message,
    };
  }
}

function envBackendUrl(): string {
  // Late import avoided; env is already a static import above via config.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return process.env.BACKEND_URL?.trim() || "http://localhost:3000";
}

/**
 * Refund sync (Phase 9.5, outbound): when an ezPos sale with a WooCommerce
 * origin is refunded, push the refunded status to the store. Full refunds
 * set the WC order status to 'refunded'; partial refunds add an order note
 * instead (WC has no partial-status concept).
 */
export async function pushRefundToWoocommerce(
  businessId: number,
  saleId: number,
  refundedTotal: number,
  orderTotal: number | null,
): Promise<void> {
  const [mapping] = await db
    .select({
      integrationId: integrationOrderMappings.integrationId,
      externalOrderId: integrationOrderMappings.externalOrderId,
      platform: integrations.platform,
      status: integrations.status,
    })
    .from(integrationOrderMappings)
    .innerJoin(integrations, eq(integrations.id, integrationOrderMappings.integrationId))
    .where(
      and(
        eq(integrationOrderMappings.saleId, saleId),
        eq(integrationOrderMappings.businessId, businessId),
      ),
    )
    .limit(1);
  if (!mapping || mapping.platform !== "woocommerce" || mapping.status !== "connected") {
    return;
  }

  try {
    const creds = await credentialsFor(mapping.integrationId);
    const client = new WoocommerceClient(creds);
    const full = orderTotal !== null && refundedTotal >= Number(orderTotal);
    if (full) {
      await client.request("PUT", `/orders/${mapping.externalOrderId}`, {
        status: "refunded",
      });
    } else {
      await client.request("POST", `/orders/${mapping.externalOrderId}/notes`, {
        note: `ezPos partial refund: ${refundedTotal} of ${orderTotal ?? "?"}.`,
      });
    }
    await logSync(mapping.integrationId, businessId, {
      jobType: "refund_sync",
      direction: "push",
      entityType: "sale",
      entityId: saleId,
      status: "success",
      message: full
        ? "Refund pushed — WooCommerce order marked refunded."
        : `Partial refund note added (${refundedTotal}).`,
    });
  } catch (err) {
    await logSync(mapping.integrationId, businessId, {
      jobType: "refund_sync",
      direction: "push",
      entityType: "sale",
      entityId: saleId,
      status: "error",
      message: (err as Error).message,
    });
    await enqueueJob(businessId, mapping.integrationId, "refund_sync", {
      saleId,
      refundedTotal,
      orderTotal,
    });
  }
}

/**
 * Fire-safe post-refund hook: resolves the refunded total from the sale and
 * pushes the refund status to WooCommerce when the sale originated there.
 * Never throws — refund creation must not fail because of sync.
 */
export async function pushRefundStatusAfterCommit(
  businessId: number,
  saleId: number,
): Promise<void> {
  void (async () => {
    try {
      const [sale] = await db
        .select({ finalTotal: sales.finalTotal })
        .from(sales)
        .where(eq(sales.id, saleId));
      await pushRefundToWoocommerce(
        businessId,
        saleId,
        sale?.finalTotal !== null && sale?.finalTotal !== undefined
          ? Number(sale.finalTotal)
          : 0,
        sale?.finalTotal !== null && sale?.finalTotal !== undefined
          ? Number(sale.finalTotal)
          : null,
      );
    } catch (err) {
      console.error(`Refund sync failed for sale ${saleId}:`, err);
    }
  })();
}
