import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { customers } from "../../db/schema/customers.js";
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { saleItems } from "../../db/schema/saleItems.js";
import { sales } from "../../db/schema/sales.js";
import { businesses } from "../../db/schema/businesses.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { integrations } from "../../db/schema/integrations.js";
import { locations } from "../../db/schema/locations.js";
import {
  consumeStockFifo,
} from "../sales/sales.service.js";
import { emitWebhookEventInTx } from "../webhooks/webhookDelivery.service.js";
import { emitNotification } from "../notifications/notifications.service.js";
import {
  confirmReservationsForSaleInTx,
  createReservationsInTx,
  releaseReservationsForSaleInTx,
} from "./reservations.service.js";

/**
 * Unified online orders (Phase 9.1). An online order IS a `sales` row —
 * same items, refunds, and accounting rules as the POS — with channel
 * metadata and a reservation-based two-phase inventory flow:
 *
 *   create  → sale 'pending'/'unpaid' + active reservations (stock held)
 *   confirm → FIFO stock consumption + movements + 'completed'/'paid'
 *   cancel  → reservations released + sale 'cancelled'
 *
 * Client-submitted prices are ignored: every price is fetched from
 * product_variants inside the transaction. Serial-tracked variants are
 * rejected in v1 (serial selection is a POS workflow). VAT is treated as
 * tax-inclusive in v1 (architecture doc §11.2).
 */

const DEFAULT_RESERVATION_MINUTES = 30;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface OnlineOrderLineInput {
  variantId: number;
  quantity: number;
}

export interface OnlineOrderCustomerInput {
  name: string;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  address?: string | null | undefined;
}

export interface CreateOnlineOrderInput {
  businessId: number;
  channel: "woocommerce" | "custom_storefront";
  integrationId: number | null;
  externalOrderId?: string | null;
  externalOrderNumber?: string | null;
  locationId?: number | null;
  customer: OnlineOrderCustomerInput;
  lines: OnlineOrderLineInput[];
  /** Stable key for duplicate-submission protection. */
  idempotencyKey: string;
  /** Payment method recorded for the eventual payment ("cod", "online", …). */
  paymentMethod?: string | null;
  note?: string | null;
}

export interface OnlineOrderResult {
  saleId: number;
  invoiceNumber: string;
  status: "pending" | "completed" | "cancelled";
  total: number;
  currency: "BDT";
  duplicated: boolean;
}

function normalizePhone(phone?: string | null): string | null {
  const trimmed = phone?.replace(/[\s-]/g, "").trim();
  return trimmed ? trimmed : null;
}

/** Round to 2dp in the numeric domain (same rule as the POS pricing util). */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

async function resolveLocationId(
  tx: Tx,
  businessId: number,
  integrationId: number | null,
  requested?: number | null,
): Promise<number> {
  if (requested) {
    const [location] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(
        and(
          eq(locations.id, requested),
          eq(locations.businessId, businessId),
        ),
      );
    if (!location) throw new Error("Requested location does not exist.");
    return requested;
  }
  if (integrationId) {
    const [integration] = await tx
      .select({ locationId: integrations.locationId })
      .from(integrations)
      .where(eq(integrations.id, integrationId));
    if (integration?.locationId) return integration.locationId;
  }
  const [defaultLocation] = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.businessId, businessId),
        eq(locations.isDefault, true),
      ),
    );
  if (!defaultLocation) {
    throw new Error("Business has no default location to fulfill from.");
  }
  return defaultLocation.id;
}

async function resolveCustomerId(
  tx: Tx,
  businessId: number,
  customer: OnlineOrderCustomerInput,
): Promise<number | null> {
  const phone = normalizePhone(customer.phone);
  const email = customer.email?.trim().toLowerCase() || null;
  if (!phone && !email) return null; // guest checkout without contact info

  // Phone is the primary matching key; email secondary. Name never matches.
  const [existing] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.businessId, businessId),
        phone
          ? eq(
              sql`regexp_replace(${customers.phone}, '[\\s-]', '', 'g')`,
              phone,
            )
          : email
            ? eq(customers.email, email)
            : sql`false`,
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await tx
    .insert(customers)
    .values({
      businessId,
      name: customer.name.trim() || "Online customer",
      phone: phone ?? null,
      email,
      address: customer.address ?? null,
    })
    .returning({ id: customers.id });
  return created?.id ?? null;
}

/** Idempotency lookup: same integration + external order id → same sale. */
async function findExistingOrder(
  tx: Tx,
  businessId: number,
  integrationId: number | null,
  externalOrderId: string | null,
  idempotencyKey: string,
): Promise<{ id: number; invoiceNumber: string; status: string; finalTotal: number | null } | null> {
  if (integrationId && externalOrderId) {
    const [row] = await tx
      .select({
        id: sales.id,
        invoiceNumber: sales.invoiceNumber,
        status: sales.status,
        finalTotal: sales.finalTotal,
      })
      .from(sales)
      .where(
        and(
          eq(sales.businessId, businessId),
          eq(sales.integrationId, integrationId),
          eq(sales.externalOrderId, externalOrderId),
        ),
      )
      .limit(1);
    if (row) return row;
  }
  // Idempotency-key path: covers integrations without external ids and
  // plain storefront retries.
  const [byKey] = await tx
    .select({
      id: sales.id,
      invoiceNumber: sales.invoiceNumber,
      status: sales.status,
      finalTotal: sales.finalTotal,
    })
    .from(sales)
    .where(
      and(
        eq(sales.businessId, businessId),
        eq(sales.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return byKey ?? null;
}

export async function createOnlineOrder(
  input: CreateOnlineOrderInput,
): Promise<OnlineOrderResult> {
  if (input.lines.length === 0) {
    throw new Error("An order requires at least one line.");
  }

  return db.transaction(async (tx) => {
    const existing = await findExistingOrder(
      tx,
      input.businessId,
      input.integrationId,
      input.externalOrderId ?? null,
      input.idempotencyKey,
    );
    if (existing) {
      return {
        saleId: existing.id,
        invoiceNumber: existing.invoiceNumber,
        status: existing.status as OnlineOrderResult["status"],
        total: Number(existing.finalTotal ?? 0),
        currency: "BDT" as const,
        duplicated: true,
      };
    }

    const locationId = await resolveLocationId(
      tx,
      input.businessId,
      input.integrationId,
      input.locationId,
    );

    // Server-side prices and validation. Serial-tracked variants are
    // rejected — serial selection is a POS workflow (v1).
    const variantIds = [...new Set(input.lines.map((l) => l.variantId))];
    const variants = await tx
      .select({
        id: productVariants.id,
        sellingPrice: productVariants.sellingPrice,
        trackingType: products.trackingType,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(productVariants.businessId, input.businessId),
          inArray(productVariants.id, variantIds),
        ),
      );
    const variantById = new Map(variants.map((v) => [v.id, v]));
    if (variantById.size !== variantIds.length) {
      throw new BadRequestError(
        "One or more products do not exist for this business.",
      );
    }
    for (const line of input.lines) {
      const variant = variantById.get(line.variantId)!;
      if (variant.trackingType === "serial") {
        throw new Error(
          "Serial-tracked products cannot be sold through storefronts yet.",
        );
      }
    }

    const subtotal = roundMoney(
      input.lines.reduce(
        (sum, line) =>
          sum +
          Number(variantById.get(line.variantId)!.sellingPrice) * line.quantity,
        0,
      ),
    );
    const customerId = await resolveCustomerId(tx, input.businessId, input.customer);

    const [sale] = await tx
      .insert(sales)
      .values({
        businessId: input.businessId,
        status: "pending",
        channel: input.channel,
        integrationId: input.integrationId,
        externalOrderId: input.externalOrderId ?? null,
        externalOrderNumber: input.externalOrderNumber ?? null,
        locationId,
        subtotal,
        discount: 0,
        vat: 0,
        finalTotal: subtotal,
        paymentStatus: "unpaid",
        dueAmount: subtotal,
        customerId,
        idempotencyKey: input.idempotencyKey,
        note:
          input.note ??
          (input.paymentMethod ? `Payment method: ${input.paymentMethod}` : null),
      })
      .returning({
        id: sales.id,
        invoiceNumber: sales.invoiceNumber,
      });
    if (!sale) throw new Error("Sale insert returned no row.");

    for (const line of input.lines) {
      await tx.insert(saleItems).values({
        businessId: input.businessId,
        saleId: sale.id,
        variantId: line.variantId,
        quantity: line.quantity,
        sellingPrice: Number(variantById.get(line.variantId)!.sellingPrice),
        costAtSale: 0, // cost is computed at confirmation, when stock is consumed
        lineTotal: roundMoney(
          Number(variantById.get(line.variantId)!.sellingPrice) * line.quantity,
        ),
        discount: 0,
      });
    }

    // Hold the stock. Insufficient online availability aborts everything.
    await createReservationsInTx(tx, {
      businessId: input.businessId,
      locationId,
      integrationId: input.integrationId,
      saleId: sale.id,
      lines: input.lines,
      idempotencyKey: input.idempotencyKey,
      expiresAt: new Date(
        Date.now() + DEFAULT_RESERVATION_MINUTES * 60 * 1000,
      ),
    });

    const result = {
      saleId: sale.id,
      invoiceNumber: sale.invoiceNumber,
      status: "pending" as const,
      total: subtotal,
      currency: "BDT" as const,
      duplicated: false,
    };
    // Delivery rows commit atomically with the order — no race with the
    // delivery sweep.
    await emitWebhookEventInTx(tx, input.businessId, "order.created", {
      orderId: result.saleId,
      invoiceNumber: result.invoiceNumber,
      total: result.total,
      channel: input.channel,
      externalOrderId: input.externalOrderId ?? null,
    });
    await emitNotification(tx, input.businessId, {
      type: "order.created",
      title: `New online order ${result.invoiceNumber}`,
      body: `${input.channel === "woocommerce" ? "WooCommerce" : "Storefront"} order for ${result.total} BDT.`,
      entityType: "sale",
      entityId: result.saleId,
    });
    return result;
  });
}

/**
 * Payment confirmed (webhook / portal). Consumes stock through the SAME
 * FIFO/batch rules the POS uses, writes the movement, confirms the
 * reservations, and completes the sale — one transaction, locked against
 * concurrent confirmations.
 */
export async function confirmOnlineOrder(
  businessId: number,
  saleId: number,
): Promise<OnlineOrderResult> {
  return db.transaction(async (tx) => {
    const [sale] = await tx
      .select({
        id: sales.id,
        invoiceNumber: sales.invoiceNumber,
        status: sales.status,
        finalTotal: sales.finalTotal,
        locationId: sales.locationId,
      })
      .from(sales)
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
      .for("update");
    if (!sale) throw new Error("Order not found.");
    if (sale.status === "completed") {
      return {
        saleId: sale.id,
        invoiceNumber: sale.invoiceNumber,
        status: "completed" as const,
        total: Number(sale.finalTotal ?? 0),
        currency: "BDT" as const,
        duplicated: true,
      };
    }
    if (sale.status !== "pending") {
      throw new Error(
        `Order ${sale.invoiceNumber} is ${sale.status} and cannot be confirmed.`,
      );
    }

    const items = await tx
      .select({
        id: saleItems.id,
        variantId: saleItems.variantId,
        quantity: saleItems.quantity,
      })
      .from(saleItems)
      .where(eq(saleItems.saleId, saleId));

    const locationId = sale.locationId;
    if (!locationId) throw new Error("Order has no fulfillment location.");

    for (const item of items) {
      // Same FIFO batch consumption the POS uses (locks the batches).
      const cost = await consumeStockFifo(
        tx,
        businessId,
        locationId,
        item.variantId,
        item.quantity,
      );
      await tx
        .update(saleItems)
        .set({ costAtSale: cost.costAtSale })
        .where(eq(saleItems.id, item.id));

      const updated = await tx
        .update(inventoryStock)
        .set({
          quantity: sql`${inventoryStock.quantity} - ${item.quantity}`,
        })
        .where(
          and(
            eq(inventoryStock.businessId, businessId),
            eq(inventoryStock.variantId, item.variantId),
            eq(inventoryStock.locationId, locationId),
          ),
        )
        .returning({ id: inventoryStock.id });
      if (updated.length !== 1) {
        throw new Error(`Stock update failed for variant ${item.variantId}.`);
      }
      await tx.insert(inventoryMovements).values({
        businessId,
        variantId: item.variantId,
        locationId,
        movementType: "sale",
        quantity: item.quantity,
        referenceType: "sale",
        referenceId: saleId,
      });
    }

    // Physical quantity drop replaces the hold.
    await confirmReservationsForSaleInTx(tx, businessId, saleId);

    await tx
      .update(sales)
      .set({
        status: "completed",
        paymentStatus: "paid",
        dueAmount: 0,
        fulfillmentStatus: "processing",
      })
      .where(eq(sales.id, saleId));

    const result = {
      saleId: sale.id,
      invoiceNumber: sale.invoiceNumber,
      status: "completed" as const,
      total: Number(sale.finalTotal ?? 0),
      currency: "BDT" as const,
      duplicated: false,
    };
    await emitWebhookEventInTx(tx, businessId, "order.paid", {
      orderId: result.saleId,
      invoiceNumber: result.invoiceNumber,
      total: result.total,
    });
    await emitNotification(tx, businessId, {
      type: "order.paid",
      title: `Payment received — ${result.invoiceNumber}`,
      body: `${result.total} BDT collected; the order is ready for fulfillment.`,
      entityType: "sale",
      entityId: result.saleId,
    });
    return result;
  });
}

/** Cancels a pending online order and releases its reservations. */
export async function cancelOnlineOrder(
  businessId: number,
  saleId: number,
  reason?: string,
): Promise<void> {
  return db.transaction(async (tx) => {
    const [sale] = await tx
      .select({ id: sales.id, status: sales.status })
      .from(sales)
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
      .for("update");
    if (!sale) throw new Error("Order not found.");
    if (sale.status !== "pending") {
      throw new Error(
        `Order is ${sale.status}; only pending orders can be cancelled.`,
      );
    }
    await releaseReservationsForSaleInTx(tx, businessId, saleId);
    await tx
      .update(sales)
      .set({ status: "cancelled" })
      .where(eq(sales.id, saleId));
    await emitWebhookEventInTx(tx, businessId, "order.cancelled", {
      orderId: saleId,
      reason: reason ?? null,
    });
    await emitNotification(tx, businessId, {
      type: "order.cancelled",
      title: "Order cancelled",
      body: "The online order was cancelled and its stock released.",
      entityType: "sale",
      entityId: saleId,
    });
    void reason;
  });
}


// ---------------------------------------------------------------------------
// Unified order management (Phase 9.5) — all channels, one view
// ---------------------------------------------------------------------------

export interface UnifiedOrderRow {
  id: number;
  invoiceNumber: string;
  channel: "pos" | "woocommerce" | "custom_storefront";
  status: "pending" | "completed" | "held" | "cancelled" | "refunded";
  paymentStatus: "paid" | "unpaid" | "partial";
  fulfillmentStatus: "unfulfilled" | "processing" | "shipped" | "delivered";
  finalTotal: number | null;
  externalOrderNumber: string | null;
  customerName: string | null;
  locationName: string | null;
  createdAt: Date | null;
}

export interface UnifiedOrderFilters {
  channel?: "pos" | "woocommerce" | "custom_storefront" | undefined;
  status?: string | undefined;
  fulfillmentStatus?: string | undefined;
  search?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export async function listUnifiedOrders(
  businessId: number,
  filters: UnifiedOrderFilters,
): Promise<{ orders: UnifiedOrderRow[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));

  const conditions = [eq(sales.businessId, businessId)];
  if (filters.channel) {
    conditions.push(eq(sales.channel, filters.channel));
  }
  if (
    filters.status &&
    ["pending", "completed", "held", "cancelled", "refunded"].includes(
      filters.status,
    )
  ) {
    conditions.push(
      eq(
        sales.status,
        filters.status as "pending" | "completed" | "held" | "cancelled" | "refunded",
      ),
    );
  }
  if (
    filters.fulfillmentStatus &&
    ["unfulfilled", "processing", "shipped", "delivered"].includes(
      filters.fulfillmentStatus,
    )
  ) {
    conditions.push(
      eq(
        sales.fulfillmentStatus,
        filters.fulfillmentStatus as
          | "unfulfilled"
          | "processing"
          | "shipped"
          | "delivered",
      ),
    );
  }
  if (filters.search) {
    conditions.push(
      or(
        ilike(sales.invoiceNumber, `%${filters.search}%`),
        ilike(sales.externalOrderNumber, `%${filters.search}%`),
        ilike(sales.externalOrderId, `%${filters.search}%`),
      )!,
    );
  }

  const rows = await db
    .select({
      id: sales.id,
      invoiceNumber: sales.invoiceNumber,
      channel: sales.channel,
      status: sales.status,
      paymentStatus: sales.paymentStatus,
      fulfillmentStatus: sales.fulfillmentStatus,
      finalTotal: sales.finalTotal,
      externalOrderNumber: sales.externalOrderNumber,
      customerName: customers.name,
      locationName: locations.name,
      createdAt: sales.createdAt,
    })
    .from(sales)
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .leftJoin(locations, eq(locations.id, sales.locationId))
    .where(and(...conditions))
    .orderBy(desc(sales.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [totalRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sales)
    .where(and(...conditions));

  return {
    orders: rows,
    total: totalRow?.n ?? 0,
    page,
    pageSize,
  };
}

export interface OrderDetail {
  id: number;
  invoiceNumber: string;
  channel: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  subtotal: number | null;
  discount: number | null;
  vat: number | null;
  finalTotal: number | null;
  dueAmount: number | null;
  note: string | null;
  externalOrderId: string | null;
  externalOrderNumber: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  locationName: string | null;
  createdAt: Date | null;
  items: {
    id: number;
    variantId: number;
    sku: string;
    productName: string;
    quantity: number;
    sellingPrice: number;
    lineTotal: number;
  }[];
}

export async function getOrderDetail(
  businessId: number,
  orderId: number,
): Promise<OrderDetail> {
  const [order] = await db
    .select({
      id: sales.id,
      invoiceNumber: sales.invoiceNumber,
      channel: sales.channel,
      status: sales.status,
      paymentStatus: sales.paymentStatus,
      fulfillmentStatus: sales.fulfillmentStatus,
      subtotal: sales.subtotal,
      discount: sales.discount,
      vat: sales.vat,
      finalTotal: sales.finalTotal,
      dueAmount: sales.dueAmount,
      note: sales.note,
      externalOrderId: sales.externalOrderId,
      externalOrderNumber: sales.externalOrderNumber,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerEmail: customers.email,
      locationName: locations.name,
      createdAt: sales.createdAt,
    })
    .from(sales)
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .leftJoin(locations, eq(locations.id, sales.locationId))
    .where(and(eq(sales.id, orderId), eq(sales.businessId, businessId)));
  if (!order) throw new NotFoundError("Order not found.");

  const items = await db
    .select({
      id: saleItems.id,
      variantId: saleItems.variantId,
      sku: productVariants.sku,
      productName: products.name,
      quantity: saleItems.quantity,
      sellingPrice: saleItems.sellingPrice,
      lineTotal: saleItems.lineTotal,
    })
    .from(saleItems)
    .innerJoin(
      productVariants,
      eq(productVariants.id, saleItems.variantId),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(saleItems.saleId, orderId));

  return { ...order, items };
}

const FULFILLMENT_TRANSITIONS: Record<
  string,
  ("processing" | "shipped" | "delivered")[]
> = {
  unfulfilled: ["processing", "shipped", "delivered"],
  processing: ["shipped", "delivered"],
  shipped: ["delivered"],
  delivered: [],
};

/** COD / unpaid online orders: record payment and confirm the order. */
export async function markOnlineOrderPaid(
  businessId: number,
  orderId: number,
): Promise<void> {
  const [sale] = await db
    .select({
      id: sales.id,
      status: sales.status,
      channel: sales.channel,
    })
    .from(sales)
    .where(and(eq(sales.id, orderId), eq(sales.businessId, businessId)))
    .for("update");
  if (!sale) throw new NotFoundError("Order not found.");
  if (sale.channel === "pos") {
    throw new BadRequestError("POS sales are paid at the counter.");
  }
  if (sale.status !== "pending") {
    throw new ConflictError(
      `Only pending orders can be marked paid (order is ${sale.status}).`,
    );
  }
  await confirmOnlineOrder(businessId, orderId);
}

export async function updateFulfillmentStatus(
  businessId: number,
  orderId: number,
  next: "processing" | "shipped" | "delivered",
): Promise<void> {
  return db.transaction(async (tx) => {
    const [sale] = await tx
      .select({
        id: sales.id,
        status: sales.status,
        fulfillmentStatus: sales.fulfillmentStatus,
        channel: sales.channel,
      })
      .from(sales)
      .where(and(eq(sales.id, orderId), eq(sales.businessId, businessId)))
      .for("update");
    if (!sale) throw new NotFoundError("Order not found.");
    if (sale.channel === "pos") {
      throw new BadRequestError(
        "POS sales are fulfilled at the counter; fulfillment tracking is for online orders.",
      );
    }
    if (sale.status !== "completed") {
      throw new ConflictError(
        "Only completed orders can be fulfilled.",
      );
    }
    const allowed = FULFILLMENT_TRANSITIONS[sale.fulfillmentStatus] ?? [];
    if (!allowed.includes(next)) {
      throw new ConflictError(
        `Cannot move fulfillment from ${sale.fulfillmentStatus} to ${next}.`,
      );
    }
    await tx
      .update(sales)
      .set({ fulfillmentStatus: next })
      .where(eq(sales.id, orderId));
  });
}
