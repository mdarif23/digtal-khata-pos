import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { taxRates } from "../../db/schema/taxRates.js";
import { productTaxes } from "../../db/schema/productTaxes.js";
import { products } from "../../db/schema/products.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { recordAuditInTx } from "../../services/audit.js";

/**
 * Tax rate configuration (Module 4). Rates are soft-deactivated, never
 * hard-deleted: sale_items.tax_detail snapshots may reference them and the
 * historical chain must stay inspectable.
 */

export interface TaxRatePayload {
  name: string;
  rate: number;
  isInclusive: boolean;
  locationId?: number | null | undefined;
  validFrom?: string | null | undefined;
  validTo?: string | null | undefined;
  isDefault?: boolean | undefined;
}

export async function listTaxRates(businessId: number, includeInactive: boolean) {
  const rows = await db
    .select()
    .from(taxRates)
    .where(
      includeInactive
        ? eq(taxRates.businessId, businessId)
        : and(
            eq(taxRates.businessId, businessId),
            eq(taxRates.isActive, true),
          ),
    )
    .orderBy(asc(taxRates.name));
  return rows.map((row) => ({ ...row, rate: Number(row.rate) }));
}

export async function createTaxRate(
  businessId: number,
  actorUserId: number | null,
  payload: TaxRatePayload,
) {
  const rate = roundMoney3(payload.rate);
  assertRateInRange(rate);
  if (payload.validFrom && payload.validTo && payload.validFrom > payload.validTo) {
    throw new BadRequestError("validFrom must not be after validTo.");
  }

  return db.transaction(async (tx) => {
    // Only one default per business: making this one default clears others.
    if (payload.isDefault) {
      await tx
        .update(taxRates)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(eq(taxRates.businessId, businessId), eq(taxRates.isDefault, true)),
        );
    }
    const [created] = await tx
      .insert(taxRates)
      .values({
        businessId,
        name: payload.name,
        rate,
        isInclusive: payload.isInclusive,
        locationId: payload.locationId ?? null,
        validFrom: payload.validFrom ?? null,
        validTo: payload.validTo ?? null,
        isDefault: payload.isDefault ?? false,
      })
      .returning();
    if (!created) throw new Error("Tax rate insert returned no row.");
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "tax_rate.created",
      entityType: "tax_rate",
      entityId: created.id,
      metadata: { name: created.name, rate, isInclusive: created.isInclusive },
    });
    return { ...created, rate: Number(created.rate) };
  });
}

export async function updateTaxRate(
  businessId: number,
  taxRateId: number,
  actorUserId: number | null,
  payload: {
    [K in keyof TaxRatePayload]?: TaxRatePayload[K] | undefined;
  } & { isActive?: boolean | undefined },
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.id, taxRateId), eq(taxRates.businessId, businessId)))
      .for("update");
    if (!existing) throw new NotFoundError("Tax rate not found.");

    if (payload.rate !== undefined) {
      const rate = roundMoney3(payload.rate);
      assertRateInRange(rate);
      payload = { ...payload, rate };
    }
    if (
      payload.validFrom !== undefined &&
      payload.validTo !== undefined &&
      payload.validFrom !== null &&
      payload.validTo !== null &&
      payload.validFrom > payload.validTo
    ) {
      throw new BadRequestError("validFrom must not be after validTo.");
    }
    if (payload.isDefault) {
      await tx
        .update(taxRates)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(eq(taxRates.businessId, businessId), eq(taxRates.isDefault, true)),
        );
    }

    const [updated] = await tx
      .update(taxRates)
      .set({
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.rate !== undefined ? { rate: payload.rate } : {}),
        ...(payload.isInclusive !== undefined
          ? { isInclusive: payload.isInclusive }
          : {}),
        ...(payload.locationId !== undefined
          ? { locationId: payload.locationId }
          : {}),
        ...(payload.validFrom !== undefined
          ? { validFrom: payload.validFrom }
          : {}),
        ...(payload.validTo !== undefined ? { validTo: payload.validTo } : {}),
        ...(payload.isDefault !== undefined
          ? { isDefault: payload.isDefault }
          : {}),
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(taxRates.id, taxRateId))
      .returning();
    if (!updated) throw new Error("Tax rate update returned no row.");
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "tax_rate.updated",
      entityType: "tax_rate",
      entityId: taxRateId,
      metadata: {
        name: updated.name,
        rate: Number(updated.rate),
        isActive: updated.isActive,
      },
    });
    return { ...updated, rate: Number(updated.rate) };
  });
}

/** Soft-deactivation — the only "delete". Deactivating the default clears it. */
export async function deactivateTaxRate(
  businessId: number,
  taxRateId: number,
  actorUserId: number | null,
) {
  const deactivated = await updateTaxRate(businessId, taxRateId, actorUserId, {
    isActive: false,
    isDefault: false,
  });
  return deactivated;
}

// --- product assignment ---------------------------------------------------

export async function getProductTaxRates(businessId: number, productId: number) {
  await assertProductInBusiness(businessId, productId);
  const rows = await db
    .select({
      taxRateId: taxRates.id,
      name: taxRates.name,
      rate: taxRates.rate,
      isInclusive: taxRates.isInclusive,
      isActive: taxRates.isActive,
    })
    .from(productTaxes)
    .innerJoin(taxRates, eq(taxRates.id, productTaxes.taxRateId))
    .where(
      and(eq(productTaxes.productId, productId), eq(taxRates.businessId, businessId)),
    )
    .orderBy(asc(taxRates.name));
  return rows.map((row) => ({ ...row, rate: Number(row.rate) }));
}

/** Replaces the product's tax assignment set atomically. */
export async function setProductTaxRates(
  businessId: number,
  productId: number,
  actorUserId: number | null,
  taxRateIds: number[],
) {
  await assertProductInBusiness(businessId, productId);
  const uniqueIds = [...new Set(taxRateIds)];
  if (uniqueIds.length > 0) {
    const valid = await db
      .select({ id: taxRates.id })
      .from(taxRates)
      .where(
        and(
          eq(taxRates.businessId, businessId),
          eq(taxRates.isActive, true),
        ),
      );
    const validIds = new Set(valid.map((v) => v.id));
    const invalid = uniqueIds.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      throw new BadRequestError(
        `Unknown or inactive tax rate(s): ${invalid.join(", ")}.`,
      );
    }
  }

  return db.transaction(async (tx) => {
    await tx
      .delete(productTaxes)
      .where(eq(productTaxes.productId, productId));
    if (uniqueIds.length > 0) {
      await tx
        .insert(productTaxes)
        .values(uniqueIds.map((taxRateId) => ({ productId, taxRateId })));
    }
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "product.taxes_assigned",
      entityType: "product",
      entityId: productId,
      metadata: { taxRateIds: uniqueIds },
    });
    return { productId, taxRateIds: uniqueIds };
  });
}

async function assertProductInBusiness(businessId: number, productId: number) {
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.businessId, businessId)))
    .limit(1);
  if (!product) throw new NotFoundError("Product not found.");
}

function roundMoney3(value: number): number {
  return Math.round(Number(value) * 1000) / 1000;
}

function assertRateInRange(rate: number) {
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new BadRequestError("The tax rate must be between 0 and 100.");
  }
}

/** Guard against accidental hard deletes — use deactivateTaxRate instead. */
export async function assertNoHardDeletePath(): Promise<never> {
  throw new ConflictError(
    "Tax rates cannot be hard-deleted. Deactivate the rate instead.",
  );
}
