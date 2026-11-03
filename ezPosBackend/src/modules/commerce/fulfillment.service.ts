import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { salePackages } from "../../db/schema/salePackages.js";
import { saleShipments } from "../../db/schema/saleShipments.js";
import { salePayments } from "../../db/schema/salePayments.js";
import { saleItems } from "../../db/schema/saleItems.js";
import { sales } from "../../db/schema/sales.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import {
  applyFulfillmentTransition,
  applyFulfillmentTransitionInTx,
  type FulfillmentActor,
} from "./orders.service.js";
import { recordOrderEventInTx } from "./orderTimeline.service.js";

/**
 * Order fulfillment (module two §6.3–6.7): processing, packaging, ready to
 * ship, shipping and delivery for online orders. Stock is consumed at
 * CONFIRM time (two-phase reservations, orders.service) — these steps move
 * workflow state and capture fulfillment costs, never stock.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Fulfillment states in which packages/shipments may still be edited. */
const EDITABLE_STATES = new Set([
  "unfulfilled",
  "confirmed",
  "processing",
  "packed",
  "ready_to_ship",
]);

async function getEditableSaleInTx(
  tx: Tx,
  businessId: number,
  orderId: number,
) {
  const [sale] = await tx
    .select({
      id: sales.id,
      invoiceNumber: sales.invoiceNumber,
      channel: sales.channel,
      status: sales.status,
      fulfillmentStatus: sales.fulfillmentStatus,
      paymentStatus: sales.paymentStatus,
      dueAmount: sales.dueAmount,
      customerId: sales.customerId,
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
      `Order is ${sale.status}; only confirmed orders can be fulfilled.`,
    );
  }
  return sale;
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export async function startOrderProcessing(
  businessId: number,
  orderId: number,
  actor: FulfillmentActor = {},
): Promise<void> {
  await applyFulfillmentTransition(businessId, orderId, "processing", actor);
}

// ---------------------------------------------------------------------------
// Packaging (§6.4)
// ---------------------------------------------------------------------------

export interface PackageInput {
  packageType?: string | null | undefined;
  weightKg?: number | null | undefined;
  lengthCm?: number | null | undefined;
  widthCm?: number | null | undefined;
  heightCm?: number | null | undefined;
  materialsNote?: string | null | undefined;
  packingCost?: number | null | undefined;
  notes?: string | null | undefined;
}

export interface PackageRow {
  id: number;
  packageNo: number;
  packageType: string | null;
  weightKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  materialsNote: string | null;
  packingCost: number | null;
  packedByUserId: number | null;
  packedAt: Date | null;
  notes: string | null;
  createdAt: Date | null;
}

export async function addOrderPackage(
  businessId: number,
  orderId: number,
  actorUserId: number | null | undefined,
  data: PackageInput,
): Promise<PackageRow> {
  return db.transaction(async (tx) => {
    const sale = await getEditableSaleInTx(tx, businessId, orderId);
    if (!EDITABLE_STATES.has(sale.fulfillmentStatus)) {
      throw new ConflictError(
        `Packages cannot be edited while the order is ${sale.fulfillmentStatus}.`,
      );
    }
    const [maxRow] = await tx
      .select({ maxNo: sql<number>`coalesce(max(${salePackages.packageNo}), 0)::int` })
      .from(salePackages)
      .where(
        and(
          eq(salePackages.saleId, orderId),
          eq(salePackages.businessId, businessId),
        ),
      );
    const [pkg] = await tx
      .insert(salePackages)
      .values({
        businessId,
        saleId: orderId,
        packageNo: (maxRow?.maxNo ?? 0) + 1,
        packageType: data.packageType ?? null,
        weightKg: data.weightKg ?? null,
        lengthCm: data.lengthCm ?? null,
        widthCm: data.widthCm ?? null,
        heightCm: data.heightCm ?? null,
        materialsNote: data.materialsNote ?? null,
        packingCost: data.packingCost != null ? roundMoney(data.packingCost) : 0,
        packedByUserId: actorUserId ?? null,
        packedAt: new Date(),
        notes: data.notes ?? null,
      })
      .returning();
    if (!pkg) throw new Error("Package insert returned no row.");
    await recordOrderEventInTx(tx, {
      businessId,
      saleId: orderId,
      eventType: "package_added",
      newStatus: sale.fulfillmentStatus,
      actorType: "user",
      actorUserId: actorUserId ?? null,
      note: `Package #${pkg.packageNo}`,
      metadata: { packageId: pkg.id, packingCost: pkg.packingCost },
    });
    return pkg;
  });
}

export async function updateOrderPackage(
  businessId: number,
  orderId: number,
  packageId: number,
  actorUserId: number | null | undefined,
  data: PackageInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const sale = await getEditableSaleInTx(tx, businessId, orderId);
    if (!EDITABLE_STATES.has(sale.fulfillmentStatus)) {
      throw new ConflictError(
        `Packages cannot be edited while the order is ${sale.fulfillmentStatus}.`,
      );
    }
    const [pkg] = await tx
      .update(salePackages)
      .set({
        ...(data.packageType !== undefined ? { packageType: data.packageType } : {}),
        ...(data.weightKg !== undefined ? { weightKg: data.weightKg } : {}),
        ...(data.lengthCm !== undefined ? { lengthCm: data.lengthCm } : {}),
        ...(data.widthCm !== undefined ? { widthCm: data.widthCm } : {}),
        ...(data.heightCm !== undefined ? { heightCm: data.heightCm } : {}),
        ...(data.materialsNote !== undefined ? { materialsNote: data.materialsNote } : {}),
        ...(data.packingCost !== undefined
          ? { packingCost: data.packingCost != null ? roundMoney(data.packingCost) : null }
          : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      })
      .where(
        and(
          eq(salePackages.id, packageId),
          eq(salePackages.saleId, orderId),
          eq(salePackages.businessId, businessId),
        ),
      )
      .returning({ id: salePackages.id });
    if (!pkg) throw new NotFoundError("Package not found.");
    await recordOrderEventInTx(tx, {
      businessId,
      saleId: orderId,
      eventType: "package_updated",
      newStatus: sale.fulfillmentStatus,
      actorType: "user",
      actorUserId: actorUserId ?? null,
      metadata: { packageId },
    });
  });
}

export async function deleteOrderPackage(
  businessId: number,
  orderId: number,
  packageId: number,
  actorUserId: number | null | undefined,
): Promise<void> {
  await db.transaction(async (tx) => {
    const sale = await getEditableSaleInTx(tx, businessId, orderId);
    if (!EDITABLE_STATES.has(sale.fulfillmentStatus)) {
      throw new ConflictError(
        `Packages cannot be edited while the order is ${sale.fulfillmentStatus}.`,
      );
    }
    const [pkg] = await tx
      .delete(salePackages)
      .where(
        and(
          eq(salePackages.id, packageId),
          eq(salePackages.saleId, orderId),
          eq(salePackages.businessId, businessId),
        ),
      )
      .returning({ id: salePackages.id });
    if (!pkg) throw new NotFoundError("Package not found.");
    await recordOrderEventInTx(tx, {
      businessId,
      saleId: orderId,
      eventType: "package_removed",
      newStatus: sale.fulfillmentStatus,
      actorType: "user",
      actorUserId: actorUserId ?? null,
      metadata: { packageId },
    });
  });
}

/** Product-level shipping & packaging defaults for the order's items —
 * used to prefill the packing form; nothing here is persisted until the
 * staff member saves a package. */
export async function getOrderPackagingDefaults(
  businessId: number,
  orderId: number,
): Promise<{
  totalWeightKg: number;
  isFragile: boolean;
  packagingInstructions: string[];
  handlingInstructions: string[];
}> {
  const items = await db
    .select({
      quantity: saleItems.quantity,
      shippingWeightKg: products.shippingWeightKg,
      isFragile: products.isFragile,
      packagingInstructions: products.packagingInstructions,
      handlingInstructions: products.handlingInstructions,
    })
    .from(saleItems)
    .innerJoin(
      productVariants,
      and(
        eq(productVariants.id, saleItems.variantId),
        eq(productVariants.businessId, businessId),
      ),
    )
    .innerJoin(
      products,
      and(eq(products.id, productVariants.productId), eq(products.businessId, businessId)),
    )
    .where(and(eq(saleItems.saleId, orderId), eq(saleItems.businessId, businessId)));
  let totalWeightKg = 0;
  let isFragile = false;
  const packagingInstructions = new Set<string>();
  const handlingInstructions = new Set<string>();
  for (const item of items) {
    if (item.shippingWeightKg != null) {
      totalWeightKg += Number(item.shippingWeightKg) * item.quantity;
    }
    if (item.isFragile) isFragile = true;
    if (item.packagingInstructions) packagingInstructions.add(item.packagingInstructions);
    if (item.handlingInstructions) handlingInstructions.add(item.handlingInstructions);
  }
  return {
    totalWeightKg: roundMoney(totalWeightKg),
    isFragile,
    packagingInstructions: [...packagingInstructions],
    handlingInstructions: [...handlingInstructions],
  };
}

// ---------------------------------------------------------------------------
// Ready to ship (§6.5) — requires at least one package
// ---------------------------------------------------------------------------

export async function markOrderReadyToShip(
  businessId: number,
  orderId: number,
  actor: FulfillmentActor = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await getEditableSaleInTx(tx, businessId, orderId);
    const packages = await tx
      .select({ id: salePackages.id })
      .from(salePackages)
      .where(
        and(
          eq(salePackages.saleId, orderId),
          eq(salePackages.businessId, businessId),
        ),
      )
      .limit(1);
    if (packages.length === 0) {
      throw new ConflictError(
        "Record at least one package before marking the order ready to ship.",
      );
    }
  });
  await applyFulfillmentTransition(businessId, orderId, "ready_to_ship", actor);
}

// ---------------------------------------------------------------------------
// Shipping (§6.6) — manual courier tracking; no courier API required
// ---------------------------------------------------------------------------

export interface ShipmentInput {
  courierName?: string | null | undefined;
  courierService?: string | null | undefined;
  trackingNumber?: string | null | undefined;
  expectedDeliveryDate?: string | Date | null | undefined;
  shippingCost?: number | null | undefined;
  notes?: string | null | undefined;
  referenceUrl?: string | null | undefined;
}

interface ShipmentRow {
  id: number;
  saleId: number;
  courierName: string | null;
  courierService: string | null;
  trackingNumber: string | null;
  shipmentDate: Date | null;
  expectedDeliveryDate: Date | null;
  shippingCost: string | number | null;
  status: string;
  notes: string | null;
  referenceUrl: string | null;
}

async function upsertShipmentInTx(
  tx: Tx,
  businessId: number,
  orderId: number,
  data: ShipmentInput,
): Promise<ShipmentRow> {
  const values = {
    businessId,
    saleId: orderId,
    courierName: data.courierName ?? null,
    courierService: data.courierService ?? null,
    trackingNumber: data.trackingNumber ?? null,
    expectedDeliveryDate: data.expectedDeliveryDate
      ? new Date(data.expectedDeliveryDate)
      : null,
    shippingCost:
      data.shippingCost != null ? roundMoney(Number(data.shippingCost)) : 0,
    notes: data.notes ?? null,
    referenceUrl: data.referenceUrl ?? null,
  };
  const [row] = await tx
    .insert(saleShipments)
    .values(values)
    .onConflictDoUpdate({
      target: [saleShipments.saleId, saleShipments.businessId],
      set: {
        courierName: values.courierName,
        courierService: values.courierService,
        trackingNumber: values.trackingNumber,
        expectedDeliveryDate: values.expectedDeliveryDate,
        shippingCost: values.shippingCost,
        notes: values.notes,
        referenceUrl: values.referenceUrl,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("Shipment upsert returned no row.");
  return row;
}

export async function shipOrder(
  businessId: number,
  orderId: number,
  actorUserId: number | null | undefined,
  data: ShipmentInput,
): Promise<ShipmentRow> {
  if (!data.courierName || !data.trackingNumber) {
    throw new BadRequestError(
      "Courier company and tracking/consignment number are required to ship.",
    );
  }
  return db.transaction(async (tx) => {
    const sale = await getEditableSaleInTx(tx, businessId, orderId);
    if (!EDITABLE_STATES.has(sale.fulfillmentStatus)) {
      throw new ConflictError(
        `Cannot ship an order that is ${sale.fulfillmentStatus}.`,
      );
    }
    const shipment = await upsertShipmentInTx(tx, businessId, orderId, data);
    await tx
      .update(saleShipments)
      .set({
        shipmentDate: new Date(),
        status: "in_transit",
        updatedAt: new Date(),
      })
      .where(eq(saleShipments.id, shipment.id));
    await recordOrderEventInTx(tx, {
      businessId,
      saleId: orderId,
      eventType: "courier_assigned",
      actorType: "user",
      actorUserId: actorUserId ?? null,
      note: `${data.courierName} — ${data.trackingNumber}`,
      metadata: {
        courierName: data.courierName,
        trackingNumber: data.trackingNumber,
        shippingCost: shipment.shippingCost,
      },
    });
    await applyFulfillmentTransitionInTx(tx, businessId, orderId, "shipped", {
      actorUserId,
    });
    return { ...shipment, shipmentDate: new Date(), status: "in_transit" };
  });
}

export async function updateOrderShipment(
  businessId: number,
  orderId: number,
  data: ShipmentInput,
): Promise<ShipmentRow> {
  return db.transaction(async (tx) => {
    const sale = await getEditableSaleInTx(tx, businessId, orderId);
    if (sale.fulfillmentStatus === "delivered") {
      throw new ConflictError("A delivered order's shipment cannot change.");
    }
    const [existing] = await tx
      .select({ id: saleShipments.id })
      .from(saleShipments)
      .where(
        and(
          eq(saleShipments.saleId, orderId),
          eq(saleShipments.businessId, businessId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundError("No shipment recorded for this order.");
    return upsertShipmentInTx(tx, businessId, orderId, data);
  });
}

// ---------------------------------------------------------------------------
// Delivery (§6.7) — COD collection is recorded independently
// ---------------------------------------------------------------------------

export async function deliverOrder(
  businessId: number,
  orderId: number,
  actorUserId: number | null | undefined,
  options: {
    codCollected?: boolean | undefined;
    codAmount?: number | null | undefined;
    codMethod?: string | undefined;
    codReference?: string | null | undefined;
    /** Processor fee for the COD collection (profitability input). */
    codGatewayFee?: number | null | undefined;
  } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const sale = await getEditableSaleInTx(tx, businessId, orderId);
    await applyFulfillmentTransitionInTx(tx, businessId, orderId, "delivered", {
      actorUserId,
    });
    await tx
      .update(saleShipments)
      .set({ status: "delivered", updatedAt: new Date() })
      .where(
        and(
          eq(saleShipments.saleId, orderId),
          eq(saleShipments.businessId, businessId),
        ),
      );

    if (options.codCollected) {
      if (sale.paymentStatus === "paid") {
        throw new ConflictError(
          "COD collection was requested but the order is already fully paid.",
        );
      }
      const method = options.codMethod ?? "cash";
      if (!["cash", "bangla_qr", "card", "sslcommerz"].includes(method)) {
        throw new BadRequestError(
          "Collection method must be cash, bangla_qr, card or sslcommerz.",
        );
      }
      const due = Number(sale.dueAmount ?? 0);
      const amount = roundMoney(options.codAmount ?? due);
      if (amount <= 0) {
        throw new BadRequestError("Collection amount must be positive.");
      }
      const gatewayFee = roundMoney(options.codGatewayFee ?? 0);
      if (gatewayFee < 0) {
        throw new BadRequestError("Gateway fee cannot be negative.");
      }
      await tx.insert(salePayments).values({
        businessId,
        saleId: orderId,
        customerId: sale.customerId ?? null,
        amount,
        paymentMethod: method,
        reference: options.codReference ?? null,
        gatewayFee,
        notes: "COD collection on delivery",
      });
      const remaining = Math.max(0, roundMoney(due - amount));
      await tx
        .update(sales)
        .set({
          paymentStatus: remaining > 0 ? "partial" : "paid",
          dueAmount: remaining,
        })
        .where(eq(sales.id, orderId));
      await recordOrderEventInTx(tx, {
        businessId,
        saleId: orderId,
        eventType: "payment_recorded",
        actorType: "user",
        actorUserId: actorUserId ?? null,
        note: `COD collected — ${method} ${amount.toFixed(2)}`,
        metadata: { method, amount, remainingDue: remaining },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Fulfillment snapshot for the order details page (§6.3–6.6)
// ---------------------------------------------------------------------------

export interface OrderFulfillmentSnapshot {
  fulfillmentStatus: string;
  packages: PackageRow[];
  shipment: ShipmentRow | null;
  items: {
    saleItemId: number;
    variantId: number;
    productName: string;
    sku: string | null;
    quantity: number;
    stockAtLocation: number | null;
  }[];
}

export async function getOrderFulfillment(
  businessId: number,
  orderId: number,
): Promise<OrderFulfillmentSnapshot> {
  const [sale] = await db
    .select({
      id: sales.id,
      fulfillmentStatus: sales.fulfillmentStatus,
      channel: sales.channel,
      locationId: sales.locationId,
    })
    .from(sales)
    .where(and(eq(sales.id, orderId), eq(sales.businessId, businessId)))
    .limit(1);
  if (!sale || sale.channel === "pos") throw new NotFoundError("Order not found.");

  const packages = await db
    .select()
    .from(salePackages)
    .where(
      and(
        eq(salePackages.saleId, orderId),
        eq(salePackages.businessId, businessId),
      ),
    )
    .orderBy(asc(salePackages.packageNo));
  const [shipment] = await db
    .select()
    .from(saleShipments)
    .where(
      and(
        eq(saleShipments.saleId, orderId),
        eq(saleShipments.businessId, businessId),
      ),
    )
    .limit(1);

  const items = await db
    .select({
      saleItemId: saleItems.id,
      variantId: saleItems.variantId,
      productName: products.name,
      sku: productVariants.sku,
      quantity: saleItems.quantity,
      stockAtLocation: sale.locationId
        ? sql<number | null>`(
            select ${inventoryStock.quantity} from ${inventoryStock}
            where ${inventoryStock.businessId} = ${businessId}
              and ${inventoryStock.variantId} = ${saleItems.variantId}
              and ${inventoryStock.locationId} = ${sale.locationId}
          )`
        : sql<number | null>`null`,
    })
    .from(saleItems)
    .innerJoin(
      productVariants,
      eq(productVariants.id, saleItems.variantId),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(saleItems.saleId, orderId),
        eq(saleItems.businessId, businessId),
      ),
    );

  return {
    fulfillmentStatus: sale.fulfillmentStatus,
    packages,
    shipment: shipment ?? null,
    items,
  };
}

/** Batch-fetch availability for the unified orders list (avoids N+1). */
export async function getStockForVariants(
  businessId: number,
  locationId: number,
  variantIds: number[],
): Promise<Map<number, number>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db
    .select({
      variantId: inventoryStock.variantId,
      quantity: inventoryStock.quantity,
    })
    .from(inventoryStock)
    .where(
      and(
        eq(inventoryStock.businessId, businessId),
        eq(inventoryStock.locationId, locationId),
        inArray(inventoryStock.variantId, variantIds),
      ),
    );
  return new Map(rows.map((r) => [r.variantId, r.quantity ?? 0]));
}
