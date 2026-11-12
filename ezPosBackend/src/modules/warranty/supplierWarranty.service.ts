import { and, asc, count, eq, gte, ilike, inArray, lt, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { recordAudit, recordAuditInTx } from "../../services/audit.js";
import type { DbTransaction } from "../../config/db.js";
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { purchaseItems } from "../../db/schema/purchaseItems.js";
import { purchaseReceivingRecords } from "../../db/schema/purchaseReceivingRecords.js";
import { purchases } from "../../db/schema/purchases.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import { suppliers } from "../../db/schema/suppliers.js";
import { supplierLedger } from "../../db/schema/supplierLedger.js";
import {
  supplierWarranties,
  supplierWarrantyClaimEvents,
  supplierWarrantyClaims,
} from "../../db/schema/supplierWarranties.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/handleError.js";
import {
  formatSupplierClaimNumber,
  nextDocumentNumber,
} from "../../utils/documentSequence.js";
import { addWarrantyDuration } from "./warrantyEngine.service.js";
import type {
  SupplierClaimListQuery,
  SupplierWarrantyListQuery,
} from "./warranty.schemas.js";

/**
 * Supplier warranty subsystem (audit decision D7/D8) — deliberately separate
 * from customer warranties so the shop can measure its actual warranty
 * expense (cost_amount) and the supplier's reimbursement (recovery_amount).
 *
 * ONE supplier_warranties row per purchase item: created inside the receive
 * transaction when warranty fields are captured (source 'receive'), or
 * retroactively for historical POs (source 'manual'). Defective serials are
 * identified at claim time, never per-serial rows.
 */

const EXPIRING_SOON_DAYS = 30;

export type SupplierWarrantyInput = {
  duration: number;
  durationUnit: "days" | "months" | "years";
  provider?: string | undefined;
  terms?: string | null | undefined;
};

/**
 * Receive-time capture (called inside createReceivePurchase's tx, per item).
 * Upserts the purchase item's supplier warranty: cumulative quantity on
 * repeat receives; start date stays the FIRST receive date.
 */
export async function captureSupplierWarrantyOnReceive(
  tx: DbTransaction,
  params: {
    businessId: number;
    purchaseId: number;
    purchaseItemId: number;
    supplierId: number;
    variantId: number;
    locationId: number;
    acceptedQuantity: number;
    warranty: SupplierWarrantyInput;
  },
) {
  // purchase_items has no product_id column — resolve it from the variant.
  const [variant] = await tx
    .select({ productId: productVariants.productId })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.businessId, params.businessId),
        eq(productVariants.id, params.variantId),
      ),
    )
    .limit(1);
  if (!variant) throw new NotFoundError("Received variant not found.");

  const [existing] = await tx
    .select()
    .from(supplierWarranties)
    .where(
      and(
        eq(supplierWarranties.businessId, params.businessId),
        eq(supplierWarranties.purchaseItemId, params.purchaseItemId),
      ),
    )
    .limit(1);

  if (existing) {
    await tx
      .update(supplierWarranties)
      .set({
        quantity: existing.quantity + params.acceptedQuantity,
        terms: params.warranty.terms ?? existing.terms,
        updatedAt: new Date(),
      })
      .where(eq(supplierWarranties.id, existing.id));
    return;
  }

  const startDate = new Date();
  await tx.insert(supplierWarranties).values({
    businessId: params.businessId,
    supplierId: params.supplierId,
    purchaseId: params.purchaseId,
    purchaseItemId: params.purchaseItemId,
    productId: variant.productId,
    variantId: params.variantId,
    provider: params.warranty.provider ?? "supplier",
    duration: params.warranty.duration,
    durationUnit: params.warranty.durationUnit,
    terms: params.warranty.terms ?? null,
    quantity: params.acceptedQuantity,
    startDate,
    expiryDate: addWarrantyDuration(
      startDate,
      params.warranty.duration,
      params.warranty.durationUnit,
    ),
    status: "active",
    source: "receive",
  });
}

/**
 * Retroactive/manual entry for historical POs: loads the purchase item's
 * supplier/variant/received quantity from the purchase; the start date is
 * the item's first receiving record (or the purchase date as fallback).
 */
export async function createSupplierWarranty(
  businessId: number,
  actorUserId: number,
  payload: SupplierWarrantyInput & { purchaseItemId: number },
) {
  const [item] = await db
    .select({
      id: purchaseItems.id,
      purchaseId: purchaseItems.purchaseId,
      variantId: purchaseItems.variantId,
      receivedQuantity: purchaseItems.receivedQuantity,
      supplierId: purchases.supplierId,
      purchaseDate: purchases.createdAt,
      locationId: purchases.locationId,
      supplierName: suppliers.name,
    })
    .from(purchaseItems)
    .innerJoin(purchases, and(eq(purchases.id, purchaseItems.purchaseId), eq(purchases.businessId, businessId)))
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(
      and(
        eq(purchaseItems.businessId, businessId),
        eq(purchaseItems.id, payload.purchaseItemId),
      ),
    )
    .limit(1);
  if (!item) throw new NotFoundError("Purchase item not found.");
  if (!item.supplierId)
    throw new BadRequestError("This purchase has no supplier to warrant against.");
  if (Number(item.receivedQuantity ?? 0) <= 0)
    throw new BadRequestError("Nothing has been received for this purchase item yet.");

  const [variant] = await db
    .select({ productId: productVariants.productId })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.businessId, businessId),
        eq(productVariants.id, item.variantId),
      ),
    )
    .limit(1);
  if (!variant) throw new NotFoundError("Purchase item variant not found.");

  const [existing] = await db
    .select({ id: supplierWarranties.id })
    .from(supplierWarranties)
    .where(
      and(
        eq(supplierWarranties.businessId, businessId),
        eq(supplierWarranties.purchaseItemId, payload.purchaseItemId),
      ),
    )
    .limit(1);
  if (existing)
    throw new ConflictError("A supplier warranty already exists for this purchase item.");

  const [firstReceive] = await db
    .select({ createdAt: purchaseReceivingRecords.createdAt })
    .from(purchaseReceivingRecords)
    .where(
      and(
        eq(purchaseReceivingRecords.businessId, businessId),
        eq(purchaseReceivingRecords.purchaseItemId, payload.purchaseItemId),
      ),
    )
    .orderBy(asc(purchaseReceivingRecords.createdAt))
    .limit(1);

  const startDate = firstReceive?.createdAt ?? item.purchaseDate ?? new Date();
  const [created] = await db
    .insert(supplierWarranties)
    .values({
      businessId,
      supplierId: item.supplierId,
      purchaseId: item.purchaseId,
      purchaseItemId: payload.purchaseItemId,
      productId: variant.productId,
      variantId: item.variantId,
      provider: payload.provider ?? "supplier",
      duration: payload.duration,
      durationUnit: payload.durationUnit,
      terms: payload.terms ?? null,
      quantity: Number(item.receivedQuantity ?? 0),
      startDate,
      expiryDate: addWarrantyDuration(startDate, payload.duration, payload.durationUnit),
      status: "active",
      source: "manual",
    })
    .returning();
  if (!created) throw new Error("Failed to create the supplier warranty.");

  await recordAudit({
    businessId,
    actorUserId,
    action: "warranty.supplier.create",
    entityType: "supplier_warranty",
    entityId: created.id,
    metadata: { purchaseItemId: payload.purchaseItemId, supplierId: item.supplierId },
  });
  return created;
}

const supplierDerivedStatusSql = sql<string>`CASE
  WHEN ${supplierWarranties.status} <> 'active' THEN ${supplierWarranties.status}
  WHEN ${supplierWarranties.expiryDate} < now() THEN 'expired'
  WHEN ${supplierWarranties.expiryDate} < now() + INTERVAL '${sql.raw(String(EXPIRING_SOON_DAYS))} days' THEN 'expiring'
  ELSE 'active'
END`;

export async function listSupplierWarranties(
  businessId: number,
  filters: SupplierWarrantyListQuery,
) {
  const conditions = [eq(supplierWarranties.businessId, businessId)];
  switch (filters.status) {
    case "active":
      conditions.push(
        eq(supplierWarranties.status, "active"),
        gte(supplierWarranties.expiryDate, new Date()),
      );
      break;
    case "expiring":
      conditions.push(
        eq(supplierWarranties.status, "active"),
        gte(supplierWarranties.expiryDate, new Date()),
        lt(
          supplierWarranties.expiryDate,
          new Date(Date.now() + EXPIRING_SOON_DAYS * 86_400_000),
        ),
      );
      break;
    case "expired":
      conditions.push(
        eq(supplierWarranties.status, "active"),
        lt(supplierWarranties.expiryDate, new Date()),
      );
      break;
    case "voided":
    case "exhausted":
      conditions.push(eq(supplierWarranties.status, filters.status));
      break;
    default:
      break;
  }
  if (filters.supplierId)
    conditions.push(eq(supplierWarranties.supplierId, filters.supplierId));
  if (filters.search) {
    const term = `%${filters.search}%`;
    conditions.push(or(ilike(products.name, term), ilike(suppliers.name, term))!);
  }
  const where = and(...conditions);

  const rows = await db
    .select({
      id: supplierWarranties.id,
      supplierId: supplierWarranties.supplierId,
      supplierName: suppliers.name,
      purchaseId: supplierWarranties.purchaseId,
      purchaseItemId: supplierWarranties.purchaseItemId,
      productId: supplierWarranties.productId,
      productName: products.name,
      variantId: supplierWarranties.variantId,
      variantOptionLabel: sql<
        string | null
      >`(SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
         FROM variant_values vv
         INNER JOIN variant_options vo ON vo.id = vv.option_id
         WHERE vv.variant_id = ${supplierWarranties.variantId})`,
      duration: supplierWarranties.duration,
      durationUnit: supplierWarranties.durationUnit,
      terms: supplierWarranties.terms,
      quantity: supplierWarranties.quantity,
      claimedQuantity: supplierWarranties.claimedQuantity,
      startDate: supplierWarranties.startDate,
      expiryDate: supplierWarranties.expiryDate,
      status: supplierDerivedStatusSql,
      storedStatus: supplierWarranties.status,
      source: supplierWarranties.source,
    })
    .from(supplierWarranties)
    .innerJoin(suppliers, eq(suppliers.id, supplierWarranties.supplierId))
    .innerJoin(products, eq(products.id, supplierWarranties.productId))
    .where(where)
    .orderBy(asc(supplierWarranties.expiryDate))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);

  const [totalRow] = await db
    .select({ total: count() })
    .from(supplierWarranties)
    .innerJoin(suppliers, eq(suppliers.id, supplierWarranties.supplierId))
    .innerJoin(products, eq(products.id, supplierWarranties.productId))
    .where(where);

  return { rows, total: Number(totalRow?.total ?? 0) };
}

async function loadSupplierWarranty(businessId: number, supplierWarrantyId: number) {
  const [row] = await db
    .select()
    .from(supplierWarranties)
    .where(
      and(
        eq(supplierWarranties.businessId, businessId),
        eq(supplierWarranties.id, supplierWarrantyId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Supplier warranty not found.");
  if (row.status !== "active")
    throw new ConflictError(`This supplier warranty is ${row.status}.`);
  if (row.expiryDate.getTime() < Date.now())
    throw new ConflictError("This supplier warranty has expired.");
  return row;
}

async function insertSupplierClaimEvent(
  tx: typeof db | DbTransaction,
  params: {
    businessId: number;
    claimId: number;
    supplierWarrantyId: number;
    eventType: string;
    previousStatus: string | null;
    newStatus: string | null;
    actorUserId: number | null;
    note?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await tx.insert(supplierWarrantyClaimEvents).values({
    businessId: params.businessId,
    claimId: params.claimId,
    supplierWarrantyId: params.supplierWarrantyId,
    eventType: params.eventType,
    previousStatus: params.previousStatus,
    newStatus: params.newStatus,
    actorType: "user",
    actorUserId: params.actorUserId,
    note: params.note ?? null,
    metadata: params.metadata ?? {},
  });
}

export async function createSupplierClaim(
  businessId: number,
  actorUserId: number,
  payload: {
    supplierWarrantyId: number;
    defectiveQuantity: number;
    serialIds?: number[] | undefined;
    issueDescription: string;
    customerWarrantyClaimId?: number | undefined;
  },
) {
  const warranty = await loadSupplierWarranty(businessId, payload.supplierWarrantyId);
  const remaining = warranty.quantity - warranty.claimedQuantity;
  if (payload.defectiveQuantity > remaining) {
    throw new ConflictError(
      `Only ${remaining} unit(s) of this supplier warranty remain unclaimed.`,
    );
  }
  if (
    payload.serialIds &&
    payload.serialIds.length > 0 &&
    payload.serialIds.length !== payload.defectiveQuantity
  ) {
    throw new BadRequestError(
      "Select exactly one serial per defective unit (or none at all).",
    );
  }

  const claimNumber = formatSupplierClaimNumber(
    new Date().getFullYear(),
    await nextDocumentNumber(db, businessId, "supplier_warranty_claim"),
  );

  return db.transaction(async (tx) => {
    // The claim's location is the purchase's receiving location (returns and
    // serials are pinned there — audit gotcha 5). Resolved BEFORE the insert
    // because location_id is NOT NULL.
    const [purchase] = await tx
      .select({ locationId: purchases.locationId })
      .from(purchases)
      .where(eq(purchases.id, warranty.purchaseId))
      .limit(1);
    if (!purchase?.locationId)
      throw new BadRequestError("The purchase has no receiving location recorded.");

    const [claim] = await tx
      .insert(supplierWarrantyClaims)
      .values({
        businessId,
        locationId: purchase.locationId,
        claimNumber,
        supplierWarrantyId: warranty.id,
        supplierId: warranty.supplierId,
        purchaseId: warranty.purchaseId,
        productId: warranty.productId,
        variantId: warranty.variantId,
        customerWarrantyClaimId: payload.customerWarrantyClaimId ?? null,
        defectiveQuantity: payload.defectiveQuantity,
        serialIds: payload.serialIds ?? [],
        issueDescription: payload.issueDescription,
        status: "submitted",
        createdByUserId: actorUserId,
      })
      .returning();
    if (!claim) throw new Error("Failed to create supplier claim.");

    await tx
      .update(supplierWarranties)
      .set({
        claimedQuantity: sql`${supplierWarranties.claimedQuantity} + ${payload.defectiveQuantity}`,
        status:
          warranty.claimedQuantity + payload.defectiveQuantity >= warranty.quantity
            ? "exhausted"
            : warranty.status,
        updatedAt: new Date(),
      })
      .where(eq(supplierWarranties.id, warranty.id));

    // Defective units physically leave the shop toward the supplier.
    if (payload.serialIds && payload.serialIds.length > 0) {
      await tx
        .update(serialNumbers)
        .set({ status: "returned" })
        .where(
          and(
            eq(serialNumbers.businessId, businessId),
            inArray(serialNumbers.id, payload.serialIds),
          ),
        );
    }

    await insertSupplierClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      supplierWarrantyId: warranty.id,
      eventType: "created",
      previousStatus: null,
      newStatus: "submitted",
      actorUserId,
      metadata: { defectiveQuantity: payload.defectiveQuantity },
    });
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "warranty.supplier.claim.create",
      entityType: "supplier_warranty_claim",
      entityId: claim.id,
      metadata: { claimNumber, supplierWarrantyId: warranty.id },
    });
    return claim;
  });
}

const SUPPLIER_TRANSITIONS: Record<string, string[]> = {
  submitted: ["sent_to_supplier", "rejected", "cancelled"],
  sent_to_supplier: ["under_repair", "replaced", "rejected", "cancelled"],
  under_repair: ["replaced", "rejected", "cancelled"],
  replaced: ["closed", "cancelled"],
  rejected: ["closed", "cancelled"],
  closed: [],
  cancelled: [],
};

function assertSupplierTransition(current: string, next: string) {
  if (!(SUPPLIER_TRANSITIONS[current] ?? []).includes(next)) {
    throw new ConflictError(
      `A ${current.replace(/_/g, " ")} supplier claim cannot move to ${next.replace(/_/g, " ")}.`,
    );
  }
}

async function loadSupplierClaim(businessId: number, claimId: number) {
  const [claim] = await db
    .select()
    .from(supplierWarrantyClaims)
    .where(
      and(
        eq(supplierWarrantyClaims.businessId, businessId),
        eq(supplierWarrantyClaims.id, claimId),
      ),
    )
    .limit(1);
  if (!claim) throw new NotFoundError("Supplier warranty claim not found.");
  if ((SUPPLIER_TRANSITIONS[claim.status] ?? []).length === 0)
    throw new ConflictError(`This supplier claim is already ${claim.status}.`);
  return claim;
}

export async function listSupplierClaims(businessId: number, filters: SupplierClaimListQuery) {
  const conditions = [eq(supplierWarrantyClaims.businessId, businessId)];
  if (filters.status !== "all")
    conditions.push(eq(supplierWarrantyClaims.status, filters.status));
  if (filters.supplierId)
    conditions.push(eq(supplierWarrantyClaims.supplierId, filters.supplierId));
  if (filters.dateFrom)
    conditions.push(
      gte(supplierWarrantyClaims.createdAt, new Date(`${filters.dateFrom}T00:00:00.000Z`)),
    );
  if (filters.dateTo)
    conditions.push(
      lte(supplierWarrantyClaims.createdAt, new Date(`${filters.dateTo}T23:59:59.999Z`)),
    );
  if (filters.search) {
    const term = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(supplierWarrantyClaims.claimNumber, term),
        ilike(products.name, term),
        ilike(suppliers.name, term),
      )!,
    );
  }
  const where = and(...conditions);

  const rows = await db
    .select({
      id: supplierWarrantyClaims.id,
      claimNumber: supplierWarrantyClaims.claimNumber,
      status: supplierWarrantyClaims.status,
      defectiveQuantity: supplierWarrantyClaims.defectiveQuantity,
      replacementQuantity: supplierWarrantyClaims.replacementQuantity,
      recoveryAmount: supplierWarrantyClaims.recoveryAmount,
      recoveryMethod: supplierWarrantyClaims.recoveryMethod,
      costAmount: supplierWarrantyClaims.costAmount,
      issueDescription: supplierWarrantyClaims.issueDescription,
      createdAt: supplierWarrantyClaims.createdAt,
      closedDate: supplierWarrantyClaims.closedDate,
      supplierName: suppliers.name,
      productName: products.name,
      variantOptionLabel: sql<
        string | null
      >`(SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
         FROM variant_values vv
         INNER JOIN variant_options vo ON vo.id = vv.option_id
         WHERE vv.variant_id = ${supplierWarrantyClaims.variantId})`,
      supplierWarrantyId: supplierWarrantyClaims.supplierWarrantyId,
      customerWarrantyClaimId: supplierWarrantyClaims.customerWarrantyClaimId,
    })
    .from(supplierWarrantyClaims)
    .innerJoin(suppliers, eq(suppliers.id, supplierWarrantyClaims.supplierId))
    .innerJoin(products, eq(products.id, supplierWarrantyClaims.productId))
    .where(where)
    .orderBy(asc(supplierWarrantyClaims.createdAt))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);

  const [totalRow] = await db
    .select({ total: count() })
    .from(supplierWarrantyClaims)
    .innerJoin(suppliers, eq(suppliers.id, supplierWarrantyClaims.supplierId))
    .innerJoin(products, eq(products.id, supplierWarrantyClaims.productId))
    .where(where);

  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function getSupplierClaimDetail(businessId: number, claimId: number) {
  const [claim] = await db
    .select({
      claim: supplierWarrantyClaims,
      supplierName: suppliers.name,
      supplierPhone: suppliers.phone,
      productName: products.name,
      variantOptionLabel: sql<
        string | null
      >`(SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
         FROM variant_values vv
         INNER JOIN variant_options vo ON vo.id = vv.option_id
         WHERE vv.variant_id = ${supplierWarrantyClaims.variantId})`,
      warrantyDuration: supplierWarranties.duration,
      warrantyDurationUnit: supplierWarranties.durationUnit,
      warrantyStartDate: supplierWarranties.startDate,
      warrantyExpiryDate: supplierWarranties.expiryDate,
    })
    .from(supplierWarrantyClaims)
    .innerJoin(suppliers, eq(suppliers.id, supplierWarrantyClaims.supplierId))
    .innerJoin(products, eq(products.id, supplierWarrantyClaims.productId))
    .innerJoin(
      supplierWarranties,
      and(
        eq(supplierWarranties.id, supplierWarrantyClaims.supplierWarrantyId),
        eq(supplierWarranties.businessId, supplierWarrantyClaims.businessId),
      ),
    )
    .where(
      and(
        eq(supplierWarrantyClaims.businessId, businessId),
        eq(supplierWarrantyClaims.id, claimId),
      ),
    )
    .limit(1);
  if (!claim) throw new NotFoundError("Supplier warranty claim not found.");

  const events = await db
    .select()
    .from(supplierWarrantyClaimEvents)
    .where(
      and(
        eq(supplierWarrantyClaimEvents.businessId, businessId),
        eq(supplierWarrantyClaimEvents.claimId, claimId),
      ),
    )
    .orderBy(asc(supplierWarrantyClaimEvents.createdAt), asc(supplierWarrantyClaimEvents.id));

  return {
    ...claim,
    events,
    allowedTransitions: SUPPLIER_TRANSITIONS[claim.claim.status] ?? [],
  };
}

export async function respondSupplierClaim(
  businessId: number,
  actorUserId: number,
  claimId: number,
  data: { status: "sent_to_supplier" | "under_repair" | "rejected"; note?: string },
) {
  const claim = await loadSupplierClaim(businessId, claimId);
  assertSupplierTransition(claim.status, data.status);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(supplierWarrantyClaims)
      .set({
        status: data.status,
        respondedDate: new Date(),
        resolvedDate: data.status === "rejected" ? new Date() : claim.resolvedDate,
        notes: data.note ?? claim.notes,
        updatedAt: new Date(),
      })
      .where(eq(supplierWarrantyClaims.id, claim.id))
      .returning();
    await insertSupplierClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      supplierWarrantyId: claim.supplierWarrantyId,
      eventType: "status_changed",
      previousStatus: claim.status,
      newStatus: data.status,
      actorUserId,
      note: data.note ?? null,
    });
    return updated;
  });
}

/**
 * Record the supplier's replacement. D8: intake 'adjust' runs a guarded
 * stock increment + 'adjustment' movement (referenceType
 * 'warranty_replacement') for NON-serial products — serial-tracked
 * replacements record their texts here and enter stock through the manual
 * stock-adjustment endpoint (documented v1 limitation).
 */
export async function recordSupplierReplacement(
  businessId: number,
  actorUserId: number,
  claimId: number,
  data: {
    replacementQuantity: number;
    replacementSerialNumbers?: string | null;
    intake: "none" | "adjust";
    note?: string;
  },
) {
  const claim = await loadSupplierClaim(businessId, claimId);
  assertSupplierTransition(claim.status, "replaced");
  if (data.replacementQuantity > claim.defectiveQuantity) {
    throw new ConflictError(
      "The replacement quantity cannot exceed the claimed defective quantity.",
    );
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(supplierWarrantyClaims)
      .set({
        status: "replaced",
        replacementQuantity: data.replacementQuantity,
        replacementSerialNumbers: data.replacementSerialNumbers ?? null,
        replacementReceivedDate: new Date(),
        resolvedDate: new Date(),
        notes: data.note ?? claim.notes,
        updatedAt: new Date(),
      })
      .where(eq(supplierWarrantyClaims.id, claim.id))
      .returning();

    if (data.intake === "adjust") {
      const [variant] = await tx
        .select({ trackingType: products.trackingType })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(
          and(
            eq(productVariants.businessId, businessId),
            eq(productVariants.id, claim.variantId),
          ),
        )
        .limit(1);
      if (!variant) throw new NotFoundError("Claim variant not found.");
      if (variant.trackingType === "serial") {
        throw new BadRequestError(
          "Serial-tracked replacement units must be intaken through the stock-adjustment endpoint so their serials are recorded.",
        );
      }
      await tx
        .insert(inventoryStock)
        .values({
          businessId,
          variantId: claim.variantId,
          locationId: claim.locationId,
          quantity: data.replacementQuantity,
        })
        .onConflictDoUpdate({
          target: [
            inventoryStock.businessId,
            inventoryStock.variantId,
            inventoryStock.locationId,
          ],
          set: {
            quantity: sql`${inventoryStock.quantity} + ${data.replacementQuantity}`,
          },
        });
      await tx.insert(inventoryMovements).values({
        businessId,
        variantId: claim.variantId,
        locationId: claim.locationId,
        movementType: "adjustment",
        quantity: data.replacementQuantity,
        referenceType: "warranty_replacement",
        referenceId: claim.id,
      });
    }

    await insertSupplierClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      supplierWarrantyId: claim.supplierWarrantyId,
      eventType: "replacement_recorded",
      previousStatus: claim.status,
      newStatus: "replaced",
      actorUserId,
      note: data.note ?? null,
      metadata: {
        replacementQuantity: data.replacementQuantity,
        intake: data.intake,
      },
    });
    return updated;
  });
}

export async function recordSupplierRecovery(
  businessId: number,
  actorUserId: number,
  claimId: number,
  data: {
    recoveryAmount: number;
    recoveryMethod: "credit_note" | "replacement" | "cash";
    recoveryReferenceId?: number;
    note?: string;
  },
) {
  const claim = await loadSupplierClaim(businessId, claimId);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(supplierWarrantyClaims)
      .set({
        recoveryAmount: data.recoveryAmount,
        recoveryMethod: data.recoveryMethod,
        recoveryReferenceId: data.recoveryReferenceId ?? claim.recoveryReferenceId,
        notes: data.note ?? claim.notes,
        updatedAt: new Date(),
      })
      .where(eq(supplierWarrantyClaims.id, claim.id))
      .returning();

    // Supplier ledger credit, mirroring the PURCHASE_RETURN writer — the
    // sum of credits IS the supplier credit balance (display-level).
    await tx.insert(supplierLedger).values({
      businessId,
      supplierId: claim.supplierId,
      transactionType: "WARRANTY_RECOVERY",
      referenceId: claim.id,
      credit: data.recoveryAmount,
      note: `Warranty recovery for ${claim.claimNumber} (${data.recoveryMethod})`,
    });

    await insertSupplierClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      supplierWarrantyId: claim.supplierWarrantyId,
      eventType: "recovery_recorded",
      previousStatus: claim.status,
      newStatus: claim.status,
      actorUserId,
      note: data.note ?? null,
      metadata: {
        recoveryAmount: data.recoveryAmount,
        recoveryMethod: data.recoveryMethod,
      },
    });
    return updated;
  });
}

export async function closeSupplierClaim(
  businessId: number,
  actorUserId: number,
  claimId: number,
) {
  const claim = await loadSupplierClaim(businessId, claimId);
  assertSupplierTransition(claim.status, "closed");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(supplierWarrantyClaims)
      .set({ status: "closed", closedDate: new Date(), updatedAt: new Date() })
      .where(eq(supplierWarrantyClaims.id, claim.id))
      .returning();
    await insertSupplierClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      supplierWarrantyId: claim.supplierWarrantyId,
      eventType: "closed",
      previousStatus: claim.status,
      newStatus: "closed",
      actorUserId,
    });
    return updated;
  });
}

/**
 * Cancel: give the claimed units back (claimed_quantity rolls back; returned
 * serials flip to in_stock) so the warranty coverage is restored.
 */
export async function cancelSupplierClaim(
  businessId: number,
  actorUserId: number,
  claimId: number,
) {
  const claim = await loadSupplierClaim(businessId, claimId);
  assertSupplierTransition(claim.status, "cancelled");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(supplierWarrantyClaims)
      .set({ status: "cancelled", closedDate: new Date(), updatedAt: new Date() })
      .where(eq(supplierWarrantyClaims.id, claim.id))
      .returning();

    const [warranty] = await tx
      .select()
      .from(supplierWarranties)
      .where(eq(supplierWarranties.id, claim.supplierWarrantyId))
      .limit(1);
    if (warranty) {
      await tx
        .update(supplierWarranties)
        .set({
          claimedQuantity: Math.max(0, warranty.claimedQuantity - claim.defectiveQuantity),
          status: warranty.status === "exhausted" ? "active" : warranty.status,
          updatedAt: new Date(),
        })
        .where(eq(supplierWarranties.id, warranty.id));
    }

    const serialIds = Array.isArray(claim.serialIds)
      ? (claim.serialIds as number[])
      : [];
    if (serialIds.length > 0) {
      await tx
        .update(serialNumbers)
        .set({ status: "in_stock" })
        .where(
          and(
            eq(serialNumbers.businessId, businessId),
            inArray(serialNumbers.id, serialIds),
          ),
        );
    }

    await insertSupplierClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      supplierWarrantyId: claim.supplierWarrantyId,
      eventType: "cancelled",
      previousStatus: claim.status,
      newStatus: "cancelled",
      actorUserId,
    });
    return updated;
  });
}

export async function addSupplierClaimNote(
  businessId: number,
  actorUserId: number,
  claimId: number,
  note: string,
) {
  const claim = await loadSupplierClaim(businessId, claimId);
  await insertSupplierClaimEvent(db, {
    businessId,
    claimId: claim.id,
    supplierWarrantyId: claim.supplierWarrantyId,
    eventType: "note_added",
    previousStatus: claim.status,
    newStatus: claim.status,
    actorUserId,
    note,
  });
  return { ok: true };
}
