import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  foldVariantOptionRows,
  variantNameFromMap,
  variantOptionsFromMap,
} from "../../utils/variantDisplay.js";
import { variantOptions } from "../../db/schema/variantOptions.js";
import { variantValues } from "../../db/schema/variantValues.js";
import { customers } from "../../db/schema/customers.js";
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { saleItems } from "../../db/schema/saleItems.js";
import { saleItemBatchConsumptions } from "../../db/schema/saleItemBatchConsumptions.js";
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
  insertSaleItemConsumptions,
} from "../sales/sales.service.js";
import { emitWebhookEventInTx } from "../webhooks/webhookDelivery.service.js";
import {
  formatSaleInvoiceNumber,
  nextDocumentNumber,
} from "../../utils/documentSequence.js";
import { salePayments } from "../../db/schema/salePayments.js";
import { saleRefunds } from "../../db/schema/saleRefunds.js";
import {
  confirmReservationsForSaleInTx,
  createReservationsInTx,
  releaseReservationsForSaleInTx,
} from "./reservations.service.js";
import { recordOrderEventInTx } from "./orderTimeline.service.js";
import { publishRealtime } from "../realtime/realtime.service.js";
import { pushFulfillmentToWoocommerce } from "../integrations/integrations.service.js";

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
  /**
   * Storefront delivery charge (stage 5) — computed SERVER-side by the
   * caller from the storefront's zones; included in final_total.
   */
  deliveryFee?: number | undefined;
  /** Shopper account placing the order (null/undefined = guest checkout). */
  shopperId?: number | null | undefined;
  /** Order-time shipping snapshot (module two). NULL fields fall back to the
   * customer record in the UI; editing the customer never rewrites these. */
  shippingName?: string | null | undefined;
  shippingPhone?: string | null | undefined;
  shippingAddress?: string | null | undefined;
  shippingCity?: string | null | undefined;
  shippingArea?: string | null | undefined;
  deliveryInstructions?: string | null | undefined;
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
  if (existing) {
    // Backfill missing contact details from the order (Module 12 sync):
    // the matched record keeps its identity, gains what it lacked.
    if (email || customer.address) {
      await tx
        .update(customers)
        .set({
          ...(email ? { email } : {}),
          ...(customer.address ? { address: customer.address } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(customers.id, existing.id),
            eq(customers.businessId, businessId),
          ),
        );
    }
    return existing.id;
  }

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
    const deliveryFee = roundMoney(input.deliveryFee ?? 0);

    // One invoice-numbering regime for every channel: online orders used
    // to draw from the legacy GLOBAL sale_invoice_number_seq column default,
    // which counts from 1 independently of the per-business
    // document_sequences counter the POS path uses — the two regimes could
    // hand the same business the same INV-YYYY-NNNNNN and the unique
    // constraint then 500'd one side. Allocate from document_sequences like
    // createSale does (migration 0049 repaired the counters first).
    const invoiceNumber = formatSaleInvoiceNumber(
      new Date().getFullYear(),
      await nextDocumentNumber(tx, input.businessId, "sale_invoice"),
    );
    const [sale] = await tx
      .insert(sales)
      .values({
        businessId: input.businessId,
        status: "pending",
        channel: input.channel,
        invoiceNumber,
        integrationId: input.integrationId,
        externalOrderId: input.externalOrderId ?? null,
        externalOrderNumber: input.externalOrderNumber ?? null,
        locationId,
        subtotal,
        discount: 0,
        vat: 0,
        deliveryFee,
        finalTotal: roundMoney(subtotal + deliveryFee),
        paymentStatus: "unpaid",
        dueAmount: roundMoney(subtotal + deliveryFee),
        customerId,
        shopperId: input.shopperId ?? null,
        idempotencyKey: input.idempotencyKey,
        shippingName: input.shippingName ?? null,
        shippingPhone: input.shippingPhone ?? null,
        shippingAddress: input.shippingAddress ?? null,
        shippingCity: input.shippingCity ?? null,
        shippingArea: input.shippingArea ?? null,
        deliveryInstructions: input.deliveryInstructions ?? null,
        note:
          input.note ??
          (input.paymentMethod ? `Payment method: ${input.paymentMethod}` : null),
      })
      // A concurrent duplicate (same business + idempotency key) that
      // committed first makes this insert a no-op; the refetch below then
      // returns the winner's order instead of a 500 on the unique violation.
      .onConflictDoNothing({
        target: [sales.businessId, sales.idempotencyKey],
      })
      .returning({
        id: sales.id,
        invoiceNumber: sales.invoiceNumber,
      });
    if (!sale) {
      const [replay] = await tx
        .select({
          id: sales.id,
          invoiceNumber: sales.invoiceNumber,
          status: sales.status,
          finalTotal: sales.finalTotal,
        })
        .from(sales)
        .where(
          and(
            eq(sales.businessId, input.businessId),
            eq(sales.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!replay) throw new Error("Sale insert returned no row.");
      return {
        saleId: replay.id,
        invoiceNumber: replay.invoiceNumber,
        status: replay.status as OnlineOrderResult["status"],
        total: Number(replay.finalTotal ?? 0),
        currency: "BDT" as const,
        duplicated: true,
      };
    }

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

    // Order timeline: reception from the channel (module two §7).
    await recordOrderEventInTx(tx, {
      businessId: input.businessId,
      saleId: sale.id,
      eventType: "created",
      newStatus: "pending",
      actorType: "integration",
      actorLabel:
        input.channel === "woocommerce"
          ? "WooCommerce"
          : "Storefront checkout",
      note: input.note ?? null,
      metadata: {
        externalOrderId: input.externalOrderId ?? null,
        paymentMethod: input.paymentMethod ?? null,
      },
    });

    const result = {
      saleId: sale.id,
      invoiceNumber: sale.invoiceNumber,
      status: "pending" as const,
      total: roundMoney(subtotal + deliveryFee),
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
    return result;
  });
}

/**
 * Payment confirmed (webhook / portal). Consumes stock through the SAME
 * FIFO/batch rules the POS uses, writes the movement, confirms the
 * reservations, and completes the sale — one transaction, locked against
 * concurrent confirmations.
 *
 * paymentMode: 'prepaid' (gateway verified — sale becomes paid) or 'cod'
 * (cash on delivery — sale stays UNPAID until the collection is recorded as
 * a sale_payments ledger row at mark-paid/delivery; payment and fulfillment
 * are independent, module two §5.4).
 */
export async function confirmOnlineOrder(
  businessId: number,
  saleId: number,
  options: { paymentMode?: "prepaid" | "cod" | undefined } = {},
): Promise<OnlineOrderResult> {
  return db.transaction((tx) =>
    confirmOnlineOrderInTx(tx, businessId, saleId, options),
  );
}

/**
 * Transaction-scoped confirm — callers that already hold a transaction (the
 * order-payment verify core locks the sale row before paying) MUST use this
 * variant; opening a nested db.transaction here would deadlock on the sale
 * row lock.
 */
export async function confirmOnlineOrderInTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  businessId: number,
  saleId: number,
  options: { paymentMode?: "prepaid" | "cod" | undefined } = {},
): Promise<OnlineOrderResult> {
  {
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
      if (cost.consumed?.length) {
        await insertSaleItemConsumptions(
          tx,
          businessId,
          saleId,
          item.id,
          item.variantId,
          cost.consumed,
        );
      }

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
        // Prepaid: the gateway verify (or ledger row) already covers the
        // total. COD: money has NOT moved — the sale stays unpaid until the
        // collection is recorded (payment ≠ fulfillment, always).
        ...(options.paymentMode === "cod"
          ? { paymentStatus: "unpaid" as const }
          : { paymentStatus: "paid" as const, dueAmount: 0 }),
        // Business checks passed and stock is consumed — the order is
        // CONFIRMED. Staff explicitly start processing (module two §6.3).
        fulfillmentStatus: "confirmed",
      })
      .where(eq(sales.id, saleId));

    await recordOrderEventInTx(tx, {
      businessId,
      saleId,
      eventType: "confirmed",
      previousStatus: "pending",
      newStatus: "confirmed",
      actorType: "user",
    });
    publishRealtime(businessId, null, { kind: "order.updated", saleId });

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
    return result;
  }
}

/** Cancels a pending online order and releases its reservations. */
export async function cancelOnlineOrder(
  businessId: number,
  saleId: number,
  reason?: string | null,
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
    await recordOrderEventInTx(tx, {
      businessId,
      saleId,
      eventType: "cancelled",
      previousStatus: "pending",
      newStatus: "cancelled",
      actorType: "user",
      note: reason ?? null,
    });
    publishRealtime(businessId, null, { kind: "order.updated", saleId });
    await emitWebhookEventInTx(tx, businessId, "order.cancelled", {
      orderId: saleId,
      reason: reason ?? null,
    });
  });
}


// ---------------------------------------------------------------------------
// Unified order management (Phase 9.5) — all channels, one view
// ---------------------------------------------------------------------------

export interface UnifiedOrderRow {
  id: number;
  invoiceNumber: string;
  channel: "pos" | "woocommerce" | "custom_storefront" | "offline";
  status: "pending" | "completed" | "held" | "cancelled" | "refunded";
  paymentStatus: "paid" | "unpaid" | "partial";
  fulfillmentStatus: FulfillmentState;
  finalTotal: number | null;
  externalOrderNumber: string | null;
  customerName: string | null;
  locationName: string | null;
  createdAt: Date | null;
  itemsCount: number;
}

export interface UnifiedOrderFilters {
  channel?: "pos" | "woocommerce" | "custom_storefront" | undefined;
  status?: string | undefined;
  fulfillmentStatus?: string | undefined;
  search?: string | undefined;
  locationId?: number | undefined;
  /** ISO dates (YYYY-MM-DD), inclusive. */
  from?: string | undefined;
  to?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export async function listUnifiedOrders(
  businessId: number,
  filters: UnifiedOrderFilters,
): Promise<{ orders: UnifiedOrderRow[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));

  // ONLINE orders only (module one §4): POS counter sales are fulfilled at
  // the register and must never surface here — the summary endpoint and
  // the fulfillment endpoints enforce the same boundary.
  const conditions = [
    eq(sales.businessId, businessId),
    sql`${sales.channel} NOT IN ('pos', 'offline')`,
  ];
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
    FULFILLMENT_STATES.includes(
      filters.fulfillmentStatus as FulfillmentState,
    )
  ) {
    conditions.push(
      eq(sales.fulfillmentStatus, filters.fulfillmentStatus as FulfillmentState),
    );
  }
  if (filters.locationId) {
    conditions.push(eq(sales.locationId, filters.locationId));
  }
  if (filters.from) {
    conditions.push(gte(sales.saleDate, new Date(`${filters.from}T00:00:00`)));
  }
  if (filters.to) {
    conditions.push(lte(sales.saleDate, new Date(`${filters.to}T23:59:59.999`)));
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
      itemsCount: sql<number>`(select coalesce(sum(${saleItems.quantity}), 0)::int from ${saleItems} where ${saleItems.saleId} = ${sales.id})`,
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
  deliveryFee: number | null;
  note: string | null;
  externalOrderId: string | null;
  externalOrderNumber: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  locationName: string | null;
  /** Order-time shipping snapshot (falls back to the customer in the UI). */
  shippingName: string | null;
  shippingPhone: string | null;
  shippingAddress: string | null;
  shippingCity: string | null;
  shippingArea: string | null;
  deliveryInstructions: string | null;
  createdAt: Date | null;
  items: {
    id: number;
    variantId: number;
    sku: string;
    productName: string;
    variantOptions: string;
    variantName: string;
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
      deliveryFee: sales.deliveryFee,
      note: sales.note,
      externalOrderId: sales.externalOrderId,
      externalOrderNumber: sales.externalOrderNumber,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerEmail: customers.email,
      locationName: locations.name,
      shippingName: sales.shippingName,
      shippingPhone: sales.shippingPhone,
      shippingAddress: sales.shippingAddress,
      shippingCity: sales.shippingCity,
      shippingArea: sales.shippingArea,
      deliveryInstructions: sales.deliveryInstructions,
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

  // Option labels batched per distinct variant (a join would fan out rows).
  const variantIds = [...new Set(items.map((item) => item.variantId))];
  let optionsByVariant = new Map<number, string[]>();
  if (variantIds.length > 0) {
    const optRows = await db
      .select({
        variantId: variantValues.variantId,
        value: variantOptions.value,
      })
      .from(variantValues)
      .innerJoin(variantOptions, eq(variantValues.optionId, variantOptions.id))
      .where(inArray(variantValues.variantId, variantIds))
      .orderBy(asc(variantValues.optionId));
    optionsByVariant = foldVariantOptionRows(optRows);
  }

  return {
    ...order,
    items: items.map((item) => ({
      ...item,
      variantOptions: variantOptionsFromMap(optionsByVariant, item.variantId),
      variantName: variantNameFromMap(optionsByVariant, item.variantId, item.productName),
    })),
  };
}

/**
 * Forward-only fulfillment workflow (module two §6). Forward skips stay
 * allowed (a courier order may go straight from packed to shipped); backward
 * moves and no-ops are rejected. Return states (return_requested,
 * partially_returned, returned) are set ONLY by the refund flow.
 */
export const FULFILLMENT_TRANSITIONS: Record<string, FulfillmentState[]> = {
  unfulfilled: ["confirmed", "processing", "packed", "ready_to_ship", "shipped", "delivered"],
  confirmed: ["processing", "packed", "ready_to_ship", "shipped", "delivered"],
  processing: ["packed", "ready_to_ship", "shipped", "delivered"],
  packed: ["ready_to_ship", "shipped", "delivered"],
  ready_to_ship: ["shipped", "delivered"],
  shipped: ["delivered"],
  delivered: [],
  return_requested: ["partially_returned", "returned"],
  partially_returned: ["returned"],
  returned: [],
};

export type FulfillmentState =
  | "unfulfilled"
  | "confirmed"
  | "processing"
  | "packed"
  | "ready_to_ship"
  | "shipped"
  | "delivered"
  | "return_requested"
  | "partially_returned"
  | "returned";

export const FULFILLMENT_STATES: FulfillmentState[] = [
  "unfulfilled",
  "confirmed",
  "processing",
  "packed",
  "ready_to_ship",
  "shipped",
  "delivered",
  "return_requested",
  "partially_returned",
  "returned",
];

/** Workflow states reachable through the public transition endpoint — return
 * states are reserved for the refund flow. */
export const WORKFLOW_FULFILLMENT_STATES: FulfillmentState[] = [
  "confirmed",
  "processing",
  "packed",
  "ready_to_ship",
  "shipped",
  "delivered",
];

export interface FulfillmentActor {
  actorUserId?: number | null | undefined;
  actorType?: "user" | "system" | "integration" | undefined;
  actorLabel?: string | null | undefined;
}

/**
 * Shared transition guard: locks the sale row, validates the transition, and
 * writes the timeline event. Callers that already hold a transaction MUST
 * pass it; standalone callers use `applyFulfillmentTransition`.
 */
export async function applyFulfillmentTransitionInTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  businessId: number,
  orderId: number,
  next: FulfillmentState,
  actor: FulfillmentActor = {},
): Promise<void> {
  const [sale] = await tx
    .select({
      id: sales.id,
      status: sales.status,
      fulfillmentStatus: sales.fulfillmentStatus,
      channel: sales.channel,
      locationId: sales.locationId,
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
    throw new ConflictError("Only completed orders can be fulfilled.");
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
  await recordOrderEventInTx(tx, {
    businessId,
    saleId: orderId,
    eventType: next,
    previousStatus: sale.fulfillmentStatus,
    newStatus: next,
    actorType: actor.actorType ?? "user",
    actorUserId: actor.actorUserId ?? null,
    actorLabel: actor.actorLabel ?? null,
  });
  // Portal screens refresh via SSE; business webhooks carry shipped/delivered.
  publishRealtime(businessId, null, { kind: "order.updated", saleId: orderId });
  if (next === "shipped" || next === "delivered") {
    await emitWebhookEventInTx(tx, businessId, `order.${next}`, {
      orderId,
      previousStatus: sale.fulfillmentStatus,
    });
  }
}

export async function applyFulfillmentTransition(
  businessId: number,
  orderId: number,
  next: FulfillmentState,
  actor: FulfillmentActor = {},
): Promise<void> {
  await db.transaction((tx) =>
    applyFulfillmentTransitionInTx(tx, businessId, orderId, next, actor),
  );
  // Post-commit: mirror shipped/delivered back to the WooCommerce origin
  // when the order came from there (best-effort, never blocks the portal).
  if (next === "shipped" || next === "delivered") {
    void pushFulfillmentToWoocommerce(businessId, orderId, next);
  }
}

/** COD / unpaid online orders: record the collection as a real ledger row
 * and confirm the order. Payment status is derived from the ledger, never
 * from the fulfillment state (module two §5.4). */
export async function markOnlineOrderPaid(
  businessId: number,
  orderId: number,
  options: {
    amount?: number | undefined;
    method?: string | undefined;
    reference?: string | null | undefined;
    /** Processor fee for this collection, as recorded by the business. */
    gatewayFee?: number | undefined;
    actorUserId?: number | null | undefined;
  } = {},
): Promise<void> {
  const method = options.method ?? "cash";
  if (
    !["cash", "bangla_qr", "card", "sslcommerz"].includes(method)
  ) {
    throw new BadRequestError(
      "Collection method must be cash, bangla_qr, card or sslcommerz.",
    );
  }
  await db.transaction(async (tx) => {
    const [sale] = await tx
      .select({
        id: sales.id,
        status: sales.status,
        channel: sales.channel,
        dueAmount: sales.dueAmount,
        customerId: sales.customerId,
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
    const amount = roundMoney(options.amount ?? Number(sale.dueAmount ?? 0));
    if (amount <= 0) {
      throw new BadRequestError("Collection amount must be positive.");
    }
    const gatewayFee = roundMoney(options.gatewayFee ?? 0);
    if (gatewayFee < 0) {
      throw new BadRequestError("Gateway fee cannot be negative.");
    }
    // The collection becomes a first-class payment row — COD money-in is
    // tracked in the SAME ledger as gateway captures (audit gap closed).
    await tx.insert(salePayments).values({
      businessId,
      saleId: orderId,
      customerId: sale.customerId ?? null,
      amount,
      paymentMethod: method,
      reference: options.reference ?? null,
      gatewayFee,
      notes: "Online order payment collection",
    });
    await recordOrderEventInTx(tx, {
      businessId,
      saleId: orderId,
      eventType: "payment_recorded",
      actorType: "user",
      actorUserId: options.actorUserId ?? null,
      note: `${method} — ${amount.toFixed(2)}`,
      metadata: { method, amount },
    });
    await confirmOnlineOrderInTx(tx, businessId, orderId);
  });
}

export async function updateFulfillmentStatus(
  businessId: number,
  orderId: number,
  next: FulfillmentState,
  actor: FulfillmentActor = {},
): Promise<void> {
  return applyFulfillmentTransition(businessId, orderId, next, actor);
}

// ---------------------------------------------------------------------------
// Orders dashboard summary (module one §4.1) — honest KPI counts. All figures
// are computed server-side over the same filters as the list.
// ---------------------------------------------------------------------------

export interface OrdersSummary {
  total: number;
  /** status='pending' — awaiting confirmation. */
  newOrders: number;
  confirmed: number;
  processing: number;
  packed: number;
  readyToShip: number;
  shipped: number;
  delivered: number;
  cancelled: number;
  /** return_requested + partially_returned + returned. */
  returnRequests: number;
  /** status='completed' (confirmed onward, not cancelled). */
  completed: number;
  /** Σ final_total of completed orders — order value, NOT cash collected. */
  grossSales: number;
  /** Σ refund_total of refunds against online orders in range. */
  refundedTotal: number;
  /** grossSales − refundedTotal. */
  netSales: number;
  /** Completed orders still carrying a due (COD uncollected / partial). */
  unpaidCount: number;
}

export async function getOrdersSummary(
  businessId: number,
  filters: Omit<UnifiedOrderFilters, "status" | "fulfillmentStatus" | "search" | "page" | "pageSize"> = {},
): Promise<OrdersSummary> {
  const conditions = [
    eq(sales.businessId, businessId),
    sql`${sales.channel} NOT IN ('pos', 'offline')`,
  ];
  if (filters.channel) conditions.push(eq(sales.channel, filters.channel));
  if (filters.locationId) conditions.push(eq(sales.locationId, filters.locationId));
  if (filters.from) conditions.push(gte(sales.saleDate, new Date(`${filters.from}T00:00:00`)));
  if (filters.to) conditions.push(lte(sales.saleDate, new Date(`${filters.to}T23:59:59.999`)));

  const [orderStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      newOrders: sql<number>`count(*) filter (where ${sales.status} = 'pending')::int`,
      confirmed: sql<number>`count(*) filter (where ${sales.fulfillmentStatus} = 'confirmed' and ${sales.status} = 'completed')::int`,
      processing: sql<number>`count(*) filter (where ${sales.fulfillmentStatus} = 'processing' and ${sales.status} = 'completed')::int`,
      packed: sql<number>`count(*) filter (where ${sales.fulfillmentStatus} = 'packed' and ${sales.status} = 'completed')::int`,
      readyToShip: sql<number>`count(*) filter (where ${sales.fulfillmentStatus} = 'ready_to_ship' and ${sales.status} = 'completed')::int`,
      shipped: sql<number>`count(*) filter (where ${sales.fulfillmentStatus} = 'shipped' and ${sales.status} = 'completed')::int`,
      delivered: sql<number>`count(*) filter (where ${sales.fulfillmentStatus} = 'delivered' and ${sales.status} = 'completed')::int`,
      cancelled: sql<number>`count(*) filter (where ${sales.status} = 'cancelled')::int`,
      returnRequests: sql<number>`count(*) filter (where ${sales.fulfillmentStatus} in ('return_requested','partially_returned','returned'))::int`,
      completed: sql<number>`count(*) filter (where ${sales.status} = 'completed')::int`,
      grossSales: sql<number>`coalesce(sum(${sales.finalTotal}) filter (where ${sales.status} = 'completed'), 0)::float8`,
      unpaidCount: sql<number>`count(*) filter (where ${sales.status} = 'completed' and ${sales.paymentStatus} <> 'paid')::int`,
    })
    .from(sales)
    .where(and(...conditions));

  const [refundStats] = await db
    .select({
      refundedTotal: sql<number>`coalesce(sum(${saleRefunds.refundTotal}), 0)::float8`,
    })
    .from(saleRefunds)
    .innerJoin(sales, eq(sales.id, saleRefunds.saleId))
    .where(
      and(
        eq(sales.businessId, businessId),
        sql`${sales.channel} NOT IN ('pos', 'offline')`,
        gte(saleRefunds.createdAt, filters.from ? new Date(`${filters.from}T00:00:00`) : new Date(0)),
        lte(saleRefunds.createdAt, filters.to ? new Date(`${filters.to}T23:59:59.999`) : new Date()),
      ),
    );

  const grossSales = orderStats?.grossSales ?? 0;
  const refundedTotal = refundStats?.refundedTotal ?? 0;
  return {
    total: orderStats?.total ?? 0,
    newOrders: orderStats?.newOrders ?? 0,
    confirmed: orderStats?.confirmed ?? 0,
    processing: orderStats?.processing ?? 0,
    packed: orderStats?.packed ?? 0,
    readyToShip: orderStats?.readyToShip ?? 0,
    shipped: orderStats?.shipped ?? 0,
    delivered: orderStats?.delivered ?? 0,
    cancelled: orderStats?.cancelled ?? 0,
    returnRequests: orderStats?.returnRequests ?? 0,
    completed: orderStats?.completed ?? 0,
    grossSales: Math.round(grossSales * 100) / 100,
    refundedTotal: Math.round(refundedTotal * 100) / 100,
    netSales: Math.round((grossSales - refundedTotal) * 100) / 100,
    unpaidCount: orderStats?.unpaidCount ?? 0,
  };
}
