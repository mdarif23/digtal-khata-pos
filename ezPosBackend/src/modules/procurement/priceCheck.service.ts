import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { priceObservations } from "../../db/schema/priceObservations.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { suppliers } from "../../db/schema/suppliers.js";
import { units } from "../../db/schema/units.js";
import { recordAuditInTx } from "../../services/audit.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import type {
  CreateObservationInput,
  ListObservationsQuery,
  UpdateObservationInput,
} from "./schemas/priceCheck.schema.js";

/**
 * Quick Price Check (Smart Procurement Phase 2): manually recorded
 * supplier quotations from wholesale market visits.
 *
 * Observations live ONLY in price_observations — they are never purchases
 * and never feed actual purchase price aggregates. Everywhere they are
 * displayed they are labeled as quotations with their observation date.
 */

export interface ObservationRow {
  id: number;
  variantId: number;
  productName: string;
  sku: string | null;
  unitName: string | null;
  supplierId: number | null;
  supplierName: string | null;
  quotedPrice: number;
  packageQuantity: number | null;
  unitPrice: number | null;
  observationDate: string;
  notes: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

function toUnitPrice(quotedPrice: number, packageQuantity: number | null): number | null {
  if (packageQuantity === null || packageQuantity <= 0) return null;
  return Number((quotedPrice / packageQuantity).toFixed(2));
}

async function assertVariantInBusiness(businessId: number, variantId: number) {
  const [variant] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.id, variantId),
        eq(productVariants.businessId, businessId),
      ),
    )
    .limit(1);
  if (!variant) {
    throw new BadRequestError("Variant not found in this business.");
  }
}

async function assertSupplierInBusiness(businessId: number, supplierId: number) {
  const [supplier] = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(
      and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)),
    )
    .limit(1);
  if (!supplier) {
    throw new BadRequestError("Supplier not found in this business.");
  }
}

export async function createObservation(
  businessId: number,
  actorUserId: number,
  input: CreateObservationInput,
): Promise<{ id: number }> {
  await assertVariantInBusiness(businessId, input.variantId);
  await assertSupplierInBusiness(businessId, input.supplierId);
  const packageQuantity = input.packageQuantity ?? null;
  const observationDate = input.observationDate ?? new Date().toISOString().slice(0, 10);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(priceObservations)
      .values({
        businessId,
        variantId: input.variantId,
        supplierId: input.supplierId,
        quotedPrice: input.quotedPrice,
        packageQuantity,
        observationDate,
        notes: input.notes ?? null,
        createdByUserId: actorUserId,
      })
      .returning({ id: priceObservations.id });
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "price_check.created",
      entityType: "price_observation",
      entityId: row!.id,
      metadata: {
        variantId: input.variantId,
        supplierId: input.supplierId,
        quotedPrice: input.quotedPrice,
        packageQuantity,
        observationDate,
      },
    });
    return { id: row!.id };
  });
}

export async function listObservations(
  businessId: number,
  params: ListObservationsQuery,
): Promise<Paginated<ObservationRow>> {
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;
  const searchFilter = params.search ? `%${params.search}%` : null;

  const conditions = [eq(priceObservations.businessId, businessId)];
  if (params.variantId) {
    conditions.push(eq(priceObservations.variantId, params.variantId));
  }
  if (params.supplierId) {
    conditions.push(eq(priceObservations.supplierId, params.supplierId));
  }
  if (params.from) {
    conditions.push(sql`${priceObservations.observationDate} >= ${params.from}::date`);
  }
  if (params.to) {
    conditions.push(sql`${priceObservations.observationDate} <= ${params.to}::date`);
  }
  if (searchFilter) {
    conditions.push(
      or(
        ilike(products.name, searchFilter),
        ilike(productVariants.sku, searchFilter),
      )!,
    );
  }

  const rows = await db
    .select({
      id: priceObservations.id,
      variantId: priceObservations.variantId,
      productName: products.name,
      sku: productVariants.sku,
      unitName: units.name,
      supplierId: priceObservations.supplierId,
      supplierName: suppliers.name,
      quotedPrice: priceObservations.quotedPrice,
      packageQuantity: priceObservations.packageQuantity,
      observationDate: priceObservations.observationDate,
      notes: priceObservations.notes,
      createdAt: priceObservations.createdAt,
      updatedAt: priceObservations.updatedAt,
    })
    .from(priceObservations)
    .innerJoin(
      productVariants,
      and(
        eq(productVariants.id, priceObservations.variantId),
        eq(productVariants.businessId, priceObservations.businessId),
      ),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(units, eq(units.id, products.unitId))
    .leftJoin(suppliers, eq(suppliers.id, priceObservations.supplierId))
    .where(and(...conditions))
    .orderBy(desc(priceObservations.observationDate), desc(priceObservations.id))
    .limit(limit)
    .offset(offset);

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(priceObservations)
    .innerJoin(
      productVariants,
      and(
        eq(productVariants.id, priceObservations.variantId),
        eq(productVariants.businessId, priceObservations.businessId),
      ),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(...conditions));

  return {
    data: rows.map((row) => ({
      ...row,
      quotedPrice: Number(row.quotedPrice),
      packageQuantity:
        row.packageQuantity === null ? null : Number(row.packageQuantity),
      unitPrice: toUnitPrice(Number(row.quotedPrice), row.packageQuantity === null ? null : Number(row.packageQuantity)),
    })),
    total: countRow?.total ?? 0,
    page,
    limit,
  };
}

export async function updateObservation(
  businessId: number,
  actorUserId: number,
  id: number,
  input: UpdateObservationInput,
): Promise<ObservationRow> {
  const [existing] = await db
    .select({ id: priceObservations.id })
    .from(priceObservations)
    .where(
      and(eq(priceObservations.id, id), eq(priceObservations.businessId, businessId)),
    )
    .limit(1);
  if (!existing) throw new NotFoundError("Price observation not found.");

  if (input.supplierId !== undefined) {
    await assertSupplierInBusiness(businessId, input.supplierId);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(priceObservations)
      .set({
        ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
        ...(input.quotedPrice !== undefined ? { quotedPrice: input.quotedPrice } : {}),
        ...(input.packageQuantity !== undefined
          ? { packageQuantity: input.packageQuantity }
          : {}),
        ...(input.observationDate !== undefined
          ? { observationDate: input.observationDate }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(priceObservations.id, id),
          eq(priceObservations.businessId, businessId),
        ),
      );
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "price_check.updated",
      entityType: "price_observation",
      entityId: id,
      metadata: { ...input },
    });
  });

  return fetchOne(businessId, id);
}

export async function deleteObservation(
  businessId: number,
  actorUserId: number,
  id: number,
): Promise<void> {
  const [existing] = await db
    .select({ id: priceObservations.id })
    .from(priceObservations)
    .where(
      and(eq(priceObservations.id, id), eq(priceObservations.businessId, businessId)),
    )
    .limit(1);
  if (!existing) throw new NotFoundError("Price observation not found.");

  await db.transaction(async (tx) => {
    await tx
      .delete(priceObservations)
      .where(
        and(
          eq(priceObservations.id, id),
          eq(priceObservations.businessId, businessId),
        ),
      );
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "price_check.deleted",
      entityType: "price_observation",
      entityId: id,
      metadata: {},
    });
  });
}

async function fetchOne(businessId: number, id: number): Promise<ObservationRow> {
  const [row] = await db
    .select({
      id: priceObservations.id,
      variantId: priceObservations.variantId,
      productName: products.name,
      sku: productVariants.sku,
      unitName: units.name,
      supplierId: priceObservations.supplierId,
      supplierName: suppliers.name,
      quotedPrice: priceObservations.quotedPrice,
      packageQuantity: priceObservations.packageQuantity,
      observationDate: priceObservations.observationDate,
      notes: priceObservations.notes,
      createdAt: priceObservations.createdAt,
      updatedAt: priceObservations.updatedAt,
    })
    .from(priceObservations)
    .innerJoin(
      productVariants,
      and(
        eq(productVariants.id, priceObservations.variantId),
        eq(productVariants.businessId, priceObservations.businessId),
      ),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(units, eq(units.id, products.unitId))
    .leftJoin(suppliers, eq(suppliers.id, priceObservations.supplierId))
    .where(
      and(eq(priceObservations.id, id), eq(priceObservations.businessId, businessId)),
    )
    .orderBy(asc(priceObservations.id))
    .limit(1);
  if (!row) throw new NotFoundError("Price observation not found.");
  const packageQuantity =
    row.packageQuantity === null ? null : Number(row.packageQuantity);
  return {
    ...row,
    quotedPrice: Number(row.quotedPrice),
    packageQuantity,
    unitPrice: toUnitPrice(Number(row.quotedPrice), packageQuantity),
  };
}
