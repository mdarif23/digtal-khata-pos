import { and, asc, count, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { recordAuditInTx } from "../../services/audit.js";
import type { DbTransaction } from "../../config/db.js";
import {
  customerWarranties as warrantiesTable,
  warrantyClaimEvents,
  warrantyClaims,
} from "../../db/schema/warranties.js";
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import { customers } from "../../db/schema/customers.js";
import { sales } from "../../db/schema/sales.js";
import { locations } from "../../db/schema/locations.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/handleError.js";
import { nextDocumentNumber, formatWarrantyClaimNumber, formatWarrantyNumber } from "../../utils/documentSequence.js";
import { roundMoney } from "../../utils/roundMoney.js";
import {
  assertWarrantyClaimable,
  isWarrantyClaimable,
  markWarrantyReplaced,
  WARRANTY_REPAIR_SERIAL_STATUS,
} from "./warrantyEngine.service.js";
import type {
  WarrantyClaimCreate,
  WarrantyClaimListQuery,
} from "./warranty.schemas.js";

/** Query executor: the shared pool or an in-flight transaction. */
type Executor = typeof db | DbTransaction;

/**
 * Customer warranty claim lifecycle.
 *
 * TRANSITION MAP — the single source of truth for what may move where.
 * Every action validates `status → next` against this map and appends a
 * warranty_claim_events row (append-only history) + an audit entry inside
 * the same transaction.
 */
const TRANSITIONS: Record<string, string[]> = {
  submitted: ["under_inspection", "rejected", "cancelled"],
  under_inspection: ["approved", "rejected", "repairing", "cancelled"],
  approved: ["repairing", "waiting_parts", "replaced", "rejected", "cancelled"],
  repairing: ["waiting_parts", "ready_for_pickup", "replaced", "cancelled"],
  waiting_parts: ["repairing", "ready_for_pickup", "replaced", "cancelled"],
  ready_for_pickup: ["closed", "repairing", "replaced", "cancelled"],
  rejected: ["closed", "cancelled"],
  replaced: ["closed", "cancelled"],
  closed: [],
  cancelled: [],
};

function assertTransition(current: string, next: string) {
  if (!(TRANSITIONS[current] ?? []).includes(next)) {
    throw new ConflictError(
      `A ${current.replace(/_/g, " ")} claim cannot move to ${next.replace(/_/g, " ")}.`,
    );
  }
}

function isTerminal(status: string) {
  return (TRANSITIONS[status] ?? []).length === 0;
}

async function insertClaimEvent(
  tx: Executor,
  params: {
    businessId: number;
    claimId: number;
    warrantyId: number;
    eventType: string;
    previousStatus: string | null;
    newStatus: string | null;
    actorUserId: number | null;
    note?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await tx.insert(warrantyClaimEvents).values({
    businessId: params.businessId,
    claimId: params.claimId,
    warrantyId: params.warrantyId,
    eventType: params.eventType,
    previousStatus: params.previousStatus,
    newStatus: params.newStatus,
    actorType: "user",
    actorUserId: params.actorUserId,
    note: params.note ?? null,
    metadata: params.metadata ?? {},
  });
}

export async function createClaim(
  businessId: number,
  actorUserId: number,
  payload: WarrantyClaimCreate,
) {
  const warranty = await assertWarrantyClaimable(db, businessId, payload.warrantyId);

  const [openClaim] = await db
    .select({ id: warrantyClaims.id, claimNumber: warrantyClaims.claimNumber })
    .from(warrantyClaims)
    .where(
      and(
        eq(warrantyClaims.businessId, businessId),
        eq(warrantyClaims.warrantyId, payload.warrantyId),
        // One unresolved claim per warranty — rejected/closed claims never
        // block a new attempt (multi-claim is supported for active coverage).
        inArray(warrantyClaims.status, [
          "submitted",
          "under_inspection",
          "approved",
          "repairing",
          "waiting_parts",
          "ready_for_pickup",
        ]),
      ),
    )
    .limit(1);
  if (openClaim) {
    throw new ConflictError(
      `An unresolved claim (${openClaim.claimNumber}) already exists for this warranty.`,
    );
  }

  const claimNumber = formatWarrantyClaimNumber(
    new Date().getFullYear(),
    await nextDocumentNumber(db, businessId, "warranty_claim"),
  );

  const result = await db.transaction(async (tx) => {
    const [claim] = await tx
      .insert(warrantyClaims)
      .values({
        businessId,
        locationId: warranty.locationId,
        claimNumber,
        warrantyId: warranty.id,
        customerId: warranty.customerId,
        productId: warranty.productId,
        variantId: warranty.variantId,
        serialId: warranty.serialId,
        serialNumber: warranty.serialNumber,
        claimType: payload.claimType,
        status: "submitted",
        reportedProblem: payload.reportedProblem,
        receivedDate: payload.receivedDate ? new Date(payload.receivedDate) : new Date(),
      })
      .returning();
    if (!claim) throw new Error("Failed to create warranty claim.");

    await insertClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      warrantyId: warranty.id,
      eventType: "created",
      previousStatus: null,
      newStatus: "submitted",
      actorUserId,
      metadata: { claimType: payload.claimType },
    });
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "warranty.claim.create",
      entityType: "warranty_claim",
      entityId: claim.id,
      metadata: { claimNumber, warrantyId: warranty.id },
    });
    return claim;
  });

  return result;
}

export async function listClaims(businessId: number, filters: WarrantyClaimListQuery) {
  const conditions = [eq(warrantyClaims.businessId, businessId)];
  if (filters.status !== "all")
    conditions.push(eq(warrantyClaims.status, filters.status));
  if (filters.claimType)
    conditions.push(eq(warrantyClaims.claimType, filters.claimType));
  if (filters.assignedUserId)
    conditions.push(eq(warrantyClaims.assignedUserId, filters.assignedUserId));
  if (filters.dateFrom)
    conditions.push(
      gte(warrantyClaims.createdAt, new Date(`${filters.dateFrom}T00:00:00.000Z`)),
    );
  if (filters.dateTo)
    conditions.push(
      lte(warrantyClaims.createdAt, new Date(`${filters.dateTo}T23:59:59.999Z`)),
    );
  if (filters.search) {
    const term = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(warrantyClaims.claimNumber, term),
        ilike(warrantyClaims.serialNumber, term),
        ilike(warrantiesTable.warrantyNumber, term),
        ilike(products.name, term),
        ilike(customers.name, term),
      )!,
    );
  }
  const where = and(...conditions);

  const rows = await db
    .select({
      id: warrantyClaims.id,
      claimNumber: warrantyClaims.claimNumber,
      claimType: warrantyClaims.claimType,
      status: warrantyClaims.status,
      resolutionType: warrantyClaims.resolutionType,
      reportedProblem: warrantyClaims.reportedProblem,
      repairCost: warrantyClaims.repairCost,
      assignedUserId: warrantyClaims.assignedUserId,
      serialNumber: warrantyClaims.serialNumber,
      createdAt: warrantyClaims.createdAt,
      closedDate: warrantyClaims.closedDate,
      warrantyId: warrantyClaims.warrantyId,
      warrantyNumber: warrantiesTable.warrantyNumber,
      customerName: customers.name,
      customerPhone: customers.phone,
      productName: products.name,
      variantOptionLabel: sql<
        string | null
      >`(SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
         FROM variant_values vv
         INNER JOIN variant_options vo ON vo.id = vv.option_id
         WHERE vv.variant_id = ${warrantyClaims.variantId})`,
      locationName: locations.name,
    })
    .from(warrantyClaims)
    .innerJoin(
      warrantiesTable,
      and(
        eq(warrantiesTable.id, warrantyClaims.warrantyId),
        eq(warrantiesTable.businessId, warrantyClaims.businessId),
      ),
    )
    .leftJoin(customers, eq(customers.id, warrantyClaims.customerId))
    .innerJoin(products, eq(products.id, warrantyClaims.productId))
    .leftJoin(locations, and(eq(locations.id, warrantyClaims.locationId), eq(locations.businessId, warrantyClaims.businessId)))
    .where(where)
    .orderBy(asc(warrantyClaims.createdAt))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);

  const [totalRow] = await db
    .select({ total: count() })
    .from(warrantyClaims)
    .innerJoin(
      warrantiesTable,
      and(
        eq(warrantiesTable.id, warrantyClaims.warrantyId),
        eq(warrantiesTable.businessId, warrantyClaims.businessId),
      ),
    )
    .leftJoin(customers, eq(customers.id, warrantyClaims.customerId))
    .innerJoin(products, eq(products.id, warrantyClaims.productId))
    .where(where);

  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function getClaimDetail(businessId: number, claimId: number) {
  const [claim] = await db
    .select({
      claim: warrantyClaims,
      warrantyNumber: warrantiesTable.warrantyNumber,
      warrantyExpiryDate: warrantiesTable.expiryDate,
      warrantyStartDate: warrantiesTable.startDate,
      warrantyStatus: warrantiesTable.status,
      warrantyDuration: warrantiesTable.duration,
      warrantyDurationUnit: warrantiesTable.durationUnit,
      warrantyProvider: warrantiesTable.provider,
      warrantyTerms: warrantiesTable.terms,
      invoiceNumber: sales.invoiceNumber,
      saleId: sales.id,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerEmail: customers.email,
      customerAddress: customers.address,
      productName: products.name,
      variantOptionLabel: sql<
        string | null
      >`(SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
         FROM variant_values vv
         INNER JOIN variant_options vo ON vo.id = vv.option_id
         WHERE vv.variant_id = ${warrantyClaims.variantId})`,
      locationName: locations.name,
    })
    .from(warrantyClaims)
    .innerJoin(
      warrantiesTable,
      and(
        eq(warrantiesTable.id, warrantyClaims.warrantyId),
        eq(warrantiesTable.businessId, warrantyClaims.businessId),
      ),
    )
    .leftJoin(sales, and(eq(sales.id, warrantiesTable.saleId), eq(sales.businessId, warrantyClaims.businessId)))
    .leftJoin(customers, eq(customers.id, warrantyClaims.customerId))
    .innerJoin(products, eq(products.id, warrantyClaims.productId))
    .leftJoin(locations, and(eq(locations.id, warrantyClaims.locationId), eq(locations.businessId, warrantyClaims.businessId)))
    .where(
      and(eq(warrantyClaims.businessId, businessId), eq(warrantyClaims.id, claimId)),
    )
    .limit(1);
  if (!claim) throw new NotFoundError("Warranty claim not found.");

  const events = await db
    .select()
    .from(warrantyClaimEvents)
    .where(
      and(
        eq(warrantyClaimEvents.businessId, businessId),
        eq(warrantyClaimEvents.claimId, claimId),
      ),
    )
    .orderBy(asc(warrantyClaimEvents.createdAt), asc(warrantyClaimEvents.id));

  const siblingClaims = await db
    .select({
      id: warrantyClaims.id,
      claimNumber: warrantyClaims.claimNumber,
      status: warrantyClaims.status,
      claimType: warrantyClaims.claimType,
      createdAt: warrantyClaims.createdAt,
    })
    .from(warrantyClaims)
    .where(
      and(
        eq(warrantyClaims.businessId, businessId),
        eq(warrantyClaims.warrantyId, claim.claim.warrantyId),
      ),
    )
    .orderBy(asc(warrantyClaims.createdAt));

  return { ...claim, events, siblingClaims, allowedTransitions: TRANSITIONS[claim.claim.status] ?? [] };
}

async function loadClaim(businessId: number, claimId: number) {
  const [claim] = await db
    .select()
    .from(warrantyClaims)
    .where(and(eq(warrantyClaims.businessId, businessId), eq(warrantyClaims.id, claimId)))
    .limit(1);
  if (!claim) throw new NotFoundError("Warranty claim not found.");
  if (isTerminal(claim.status)) {
    throw new ConflictError(`This claim is already ${claim.status}.`);
  }
  return claim;
}

/** Flip the claim's serial (serial-tracked warranties) into/under repair. */
async function setSerialRepairStatus(
  tx: Executor,
  businessId: number,
  claim: { serialId: number | null; id: number },
  status: "in_repair" | "sold" | "returned",
) {
  if (!claim.serialId) return;
  await tx
    .update(serialNumbers)
    .set({ status })
    .where(
      and(
        eq(serialNumbers.businessId, businessId),
        eq(serialNumbers.id, claim.serialId),
      ),
    );
}

export async function updateClaimInspection(
  businessId: number,
  actorUserId: number,
  claimId: number,
  data: { inspectionNotes?: string; receivedDate?: string },
) {
  const claim = await loadClaim(businessId, claimId);
  assertTransition(claim.status, "under_inspection");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(warrantyClaims)
      .set({
        status: "under_inspection",
        inspectionNotes: data.inspectionNotes ?? claim.inspectionNotes,
        receivedDate: data.receivedDate ? new Date(data.receivedDate) : claim.receivedDate,
        updatedAt: new Date(),
      })
      .where(eq(warrantyClaims.id, claim.id))
      .returning();
    await insertClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      warrantyId: claim.warrantyId,
      eventType: "status_changed",
      previousStatus: claim.status,
      newStatus: "under_inspection",
      actorUserId,
      note: data.inspectionNotes ?? null,
    });
    return updated;
  });
}

export async function approveClaim(
  businessId: number,
  actorUserId: number,
  claimId: number,
  data: { inspectionNotes?: string; assignedUserId?: number; note?: string },
) {
  const claim = await loadClaim(businessId, claimId);
  assertTransition(claim.status, "approved");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(warrantyClaims)
      .set({
        status: "approved",
        inspectionNotes: data.inspectionNotes ?? claim.inspectionNotes,
        assignedUserId: data.assignedUserId ?? claim.assignedUserId,
        updatedAt: new Date(),
      })
      .where(eq(warrantyClaims.id, claim.id))
      .returning();
    await insertClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      warrantyId: claim.warrantyId,
      eventType: "status_changed",
      previousStatus: claim.status,
      newStatus: "approved",
      actorUserId,
      note: data.note ?? null,
    });
    return updated;
  });
}

export async function rejectClaim(
  businessId: number,
  actorUserId: number,
  claimId: number,
  data: { resolutionNotes: string },
) {
  const claim = await loadClaim(businessId, claimId);
  assertTransition(claim.status, "rejected");
  // A rejection NEVER voids the warranty (D-multi-claim): the unit keeps
  // its coverage and a new claim may be submitted later.
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(warrantyClaims)
      .set({
        status: "rejected",
        resolutionType: "rejected",
        resolutionNotes: data.resolutionNotes,
        resolvedDate: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(warrantyClaims.id, claim.id))
      .returning();
    // Serial goes back to the customer (sold) — the unit was not repaired.
    await setSerialRepairStatus(tx, businessId, claim, "sold");
    await insertClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      warrantyId: claim.warrantyId,
      eventType: "status_changed",
      previousStatus: claim.status,
      newStatus: "rejected",
      actorUserId,
      note: data.resolutionNotes,
    });
    return updated;
  });
}

export async function updateClaimRepair(
  businessId: number,
  actorUserId: number,
  claimId: number,
  data: {
    status: "repairing" | "waiting_parts";
    repairDescription?: string;
    partsUsed?: string;
    repairCost?: number;
    assignedUserId?: number;
    note?: string;
  },
) {
  const claim = await loadClaim(businessId, claimId);
  assertTransition(claim.status, data.status);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(warrantyClaims)
      .set({
        status: data.status,
        repairDescription: data.repairDescription ?? claim.repairDescription,
        partsUsed: data.partsUsed ?? claim.partsUsed,
        repairCost: data.repairCost != null ? roundMoney(data.repairCost) : claim.repairCost,
        assignedUserId: data.assignedUserId ?? claim.assignedUserId,
        updatedAt: new Date(),
      })
      .where(eq(warrantyClaims.id, claim.id))
      .returning();
    await setSerialRepairStatus(tx, businessId, claim, WARRANTY_REPAIR_SERIAL_STATUS);
    await insertClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      warrantyId: claim.warrantyId,
      eventType: data.status === "repairing" ? "repair_updated" : "status_changed",
      previousStatus: claim.status,
      newStatus: data.status,
      actorUserId,
      note: data.note ?? null,
      metadata: {
        repairDescription: data.repairDescription ?? null,
        partsUsed: data.partsUsed ?? null,
        repairCost: data.repairCost ?? null,
      },
    });
    return updated;
  });
}

export async function assignClaim(
  businessId: number,
  actorUserId: number,
  claimId: number,
  data: { assignedUserId: number; note?: string },
) {
  const claim = await loadClaim(businessId, claimId);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(warrantyClaims)
      .set({ assignedUserId: data.assignedUserId, updatedAt: new Date() })
      .where(eq(warrantyClaims.id, claim.id))
      .returning();
    await insertClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      warrantyId: claim.warrantyId,
      eventType: "assigned",
      previousStatus: claim.status,
      newStatus: claim.status,
      actorUserId,
      note: data.note ?? null,
      metadata: { assignedUserId: data.assignedUserId },
    });
    return updated;
  });
}

export async function markClaimReady(
  businessId: number,
  actorUserId: number,
  claimId: number,
) {
  const claim = await loadClaim(businessId, claimId);
  assertTransition(claim.status, "ready_for_pickup");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(warrantyClaims)
      .set({ status: "ready_for_pickup", updatedAt: new Date() })
      .where(eq(warrantyClaims.id, claim.id))
      .returning();
    await insertClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      warrantyId: claim.warrantyId,
      eventType: "status_changed",
      previousStatus: claim.status,
      newStatus: "ready_for_pickup",
      actorUserId,
    });
    return updated;
  });
}

export async function recordClaimPickup(
  businessId: number,
  actorUserId: number,
  claimId: number,
) {
  const claim = await loadClaim(businessId, claimId);
  assertTransition(claim.status, "closed");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(warrantyClaims)
      .set({
        status: "closed",
        pickupDate: new Date(),
        closedDate: new Date(),
        resolutionType: claim.resolutionType ?? "repair",
        updatedAt: new Date(),
      })
      .where(eq(warrantyClaims.id, claim.id))
      .returning();
    // The repaired unit leaves the shop with the customer again.
    await setSerialRepairStatus(tx, businessId, claim, "sold");
    await insertClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      warrantyId: claim.warrantyId,
      eventType: "closed",
      previousStatus: claim.status,
      newStatus: "closed",
      actorUserId,
    });
    return updated;
  });
}

/**
 * Warranty replacement (D6): the replacement unit leaves shop stock through
 * the guarded decrement + an 'adjustment' movement (referenceType
 * 'warranty_replacement'), a NEW warranty row inherits the original expiry
 * (with a fresh warranty number) and the original row becomes 'replaced'.
 * NEVER a sale, NEVER a financial posting. Serial-tracked replacements link
 * the unit's serial to the original sale item.
 */
export async function replaceUnderWarranty(
  businessId: number,
  actorUserId: number,
  claimId: number,
  data: {
    replacementVariantId: number;
    replacementSerialNumber?: string | null;
    note?: string;
  },
) {
  const claim = await loadClaim(businessId, claimId);
  assertTransition(claim.status, "replaced");

  return db.transaction(async (tx) => {
    const [warranty] = await tx
      .select()
      .from(warrantiesTable)
      .where(
        and(
          eq(warrantiesTable.businessId, businessId),
          eq(warrantiesTable.id, claim.warrantyId),
        ),
      )
      .limit(1);
    if (!warranty) throw new NotFoundError("Warranty not found.");

    const [replacementVariant] = await tx
      .select({
        id: productVariants.id,
        productId: productVariants.productId,
        trackingType: products.trackingType,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(productVariants.businessId, businessId),
          eq(productVariants.id, data.replacementVariantId),
        ),
      )
      .limit(1);
    if (!replacementVariant)
      throw new NotFoundError("Replacement variant not found.");

    // Stock: guarded decrement at the claim's location (never negative).
    const [stockRow] = await tx
      .select()
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.businessId, businessId),
          eq(inventoryStock.variantId, data.replacementVariantId),
          eq(inventoryStock.locationId, claim.locationId),
        ),
      )
      .for("update");
    if (!stockRow || Number(stockRow.quantity ?? 0) < 1) {
      throw new ConflictError(
        "No replacement stock available at this location for the selected variant.",
      );
    }
    await tx
      .update(inventoryStock)
      .set({ quantity: sql`${inventoryStock.quantity} - 1` })
      .where(eq(inventoryStock.id, stockRow.id));
    await tx.insert(inventoryMovements).values({
      businessId,
      variantId: data.replacementVariantId,
      locationId: claim.locationId,
      movementType: "adjustment",
      quantity: -1,
      referenceType: "warranty_replacement",
      referenceId: claim.id,
    });

    // Serial-tracked replacement: bind the given serial to the original
    // sale item and mark it sold (it belongs to the customer now).
    let replacementSerialId: number | null = null;
    if (replacementVariant.trackingType === "serial") {
      if (!data.replacementSerialNumber) {
        throw new BadRequestError(
          "This replacement variant is serial-tracked — enter its serial number.",
        );
      }
      const [serial] = await tx
        .update(serialNumbers)
        .set({ status: "sold", soldAt: new Date(), saleItemId: warranty.saleItemId })
        .where(
          and(
            eq(serialNumbers.businessId, businessId),
            eq(serialNumbers.variantId, data.replacementVariantId),
            eq(serialNumbers.serialNumber, data.replacementSerialNumber),
            eq(serialNumbers.status, "in_stock"),
          ),
        )
        .returning({ id: serialNumbers.id });
      if (!serial) {
        throw new ConflictError(
          "That serial number is not available in stock for the replacement variant.",
        );
      }
      replacementSerialId = serial.id;
    }

    const newWarrantyNumber = formatWarrantyNumber(
      new Date().getFullYear(),
      await nextDocumentNumber(tx, businessId, "customer_warranty"),
    );
    const [newWarranty] = await tx
      .insert(warrantiesTable)
      .values({
        businessId,
        locationId: claim.locationId,
        warrantyNumber: newWarrantyNumber,
        saleId: warranty.saleId,
        saleItemId: warranty.saleItemId,
        customerId: warranty.customerId,
        productId: replacementVariant.productId,
        variantId: replacementVariant.id,
        serialId: replacementSerialId,
        serialNumber: data.replacementSerialNumber ?? null,
        quantity: 1,
        provider: warranty.provider,
        warrantyType: warranty.warrantyType,
        duration: warranty.duration,
        durationUnit: warranty.durationUnit,
        terms: warranty.terms,
        // D6: the replacement inherits the ORIGINAL expiry — the customer
        // does not get a fresh term by breaking their unit.
        startDate: warranty.startDate,
        expiryDate: warranty.expiryDate,
        status: "active",
      })
      .returning();
    if (!newWarranty) throw new Error("Failed to issue the replacement warranty.");

    const [updated] = await tx
      .update(warrantyClaims)
      .set({
        status: "replaced",
        resolutionType: "replacement",
        replacementVariantId: data.replacementVariantId,
        replacementSerialNumber: data.replacementSerialNumber ?? null,
        replacementDate: new Date(),
        newWarrantyId: newWarranty.id,
        resolvedDate: new Date(),
        resolutionNotes: data.note ?? claim.resolutionNotes,
        updatedAt: new Date(),
      })
      .where(eq(warrantyClaims.id, claim.id))
      .returning();

    // Original warranty closes for claims (its unit left the customer).
    await markWarrantyReplaced(tx, { businessId, warrantyId: warranty.id });
    // The defective unit's serial (if tracked) went back to the supplier
    // pipeline — mark it returned.
    await setSerialRepairStatus(tx, businessId, claim, "returned");

    await insertClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      warrantyId: claim.warrantyId,
      eventType: "replacement_recorded",
      previousStatus: claim.status,
      newStatus: "replaced",
      actorUserId,
      note: data.note ?? null,
      metadata: {
        replacementVariantId: data.replacementVariantId,
        newWarrantyId: newWarranty.id,
        newWarrantyNumber,
      },
    });
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "warranty.claim.replace",
      entityType: "warranty_claim",
      entityId: claim.id,
      metadata: { claimNumber: claim.claimNumber, newWarrantyId: newWarranty.id },
    });

    return updated;
  });
}

export async function closeClaim(
  businessId: number,
  actorUserId: number,
  claimId: number,
) {
  const claim = await loadClaim(businessId, claimId);
  assertTransition(claim.status, "closed");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(warrantyClaims)
      .set({
        status: "closed",
        closedDate: new Date(),
        resolutionType: claim.resolutionType ?? "repair",
        updatedAt: new Date(),
      })
      .where(eq(warrantyClaims.id, claim.id))
      .returning();
    await setSerialRepairStatus(tx, businessId, claim, "sold");
    await insertClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      warrantyId: claim.warrantyId,
      eventType: "closed",
      previousStatus: claim.status,
      newStatus: "closed",
      actorUserId,
    });
    return updated;
  });
}

export async function cancelClaim(
  businessId: number,
  actorUserId: number,
  claimId: number,
) {
  const claim = await loadClaim(businessId, claimId);
  assertTransition(claim.status, "cancelled");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(warrantyClaims)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(warrantyClaims.id, claim.id))
      .returning();
    await setSerialRepairStatus(tx, businessId, claim, "sold");
    await insertClaimEvent(tx, {
      businessId,
      claimId: claim.id,
      warrantyId: claim.warrantyId,
      eventType: "cancelled",
      previousStatus: claim.status,
      newStatus: "cancelled",
      actorUserId,
    });
    return updated;
  });
}

export async function addClaimNote(
  businessId: number,
  actorUserId: number,
  claimId: number,
  note: string,
) {
  const claim = await loadClaim(businessId, claimId);
  await insertClaimEvent(db, {
    businessId,
    claimId: claim.id,
    warrantyId: claim.warrantyId,
    eventType: "note_added",
    previousStatus: claim.status,
    newStatus: claim.status,
    actorUserId,
    note,
  });
  return { ok: true };
}

/** Claim-eligibility probe used by the creation wizard. */
export async function checkClaimEligibility(
  businessId: number,
  warrantyId: number,
) {
  const [warranty] = await db
    .select()
    .from(warrantiesTable)
    .where(
      and(
        eq(warrantiesTable.businessId, businessId),
        eq(warrantiesTable.id, warrantyId),
      ),
    )
    .limit(1);
  if (!warranty) throw new NotFoundError("Warranty not found.");
  const check = isWarrantyClaimable(warranty);
  const [openClaim] = await db
    .select({ claimNumber: warrantyClaims.claimNumber })
    .from(warrantyClaims)
    .where(
      and(
        eq(warrantyClaims.businessId, businessId),
        eq(warrantyClaims.warrantyId, warrantyId),
        inArray(warrantyClaims.status, [
          "submitted",
          "under_inspection",
          "approved",
          "repairing",
          "waiting_parts",
          "ready_for_pickup",
        ]),
      ),
    )
    .limit(1);
  return {
    eligible: check.ok && !openClaim,
    reason: check.reason ?? (openClaim ? `An unresolved claim (${openClaim.claimNumber}) exists.` : null),
    warranty,
  };
}
