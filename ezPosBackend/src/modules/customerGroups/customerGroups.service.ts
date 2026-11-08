import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { customers } from "../../db/schema/customers.js";
import { customerGroupPricing, customerGroups } from "../../db/schema/pricing.js";
import { categories } from "../../db/schema/categories.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAudit } from "../../services/audit.js";
import { groupPricingStrictSchema } from "./customerGroups.validation.js";

/**
 * Customer groups + group pricing (Phase 4, report §13.3-13.5). Groups are
 * created lazily (no backfill); membership is a live reference on
 * customers.customer_group_id; group pricing rows are configuration — the
 * sale-time layer (pricing.salePricing.ts) consumes them at checkout.
 */

type GroupRow = typeof customerGroups.$inferSelect;

function isGroupConflictError(err: unknown): boolean {
  const levels: unknown[] = [err, (err as { cause?: unknown } | null)?.cause];
  for (const level of levels) {
    const e = level as { code?: string; constraint?: string } | null;
    if (e?.code === "23505" && String(e.constraint ?? "").includes("customer_groups")) {
      return true;
    }
  }
  return false;
}

async function assertScopeOwnership(
  businessId: number,
  scope: {
    categoryId?: number | null | undefined;
    productId?: number | null | undefined;
    variantId?: number | null | undefined;
  },
): Promise<void> {
  if (scope.categoryId != null) {
    const [row] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, scope.categoryId), eq(categories.businessId, businessId)))
      .limit(1);
    if (!row) throw new NotFoundError("Category does not exist.");
  }
  if (scope.productId != null) {
    const [row] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, scope.productId), eq(products.businessId, businessId)))
      .limit(1);
    if (!row) throw new NotFoundError("Product does not exist.");
  }
  if (scope.variantId != null) {
    const [row] = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(eq(productVariants.id, scope.variantId), eq(productVariants.businessId, businessId)),
      )
      .limit(1);
    if (!row) throw new NotFoundError("Variant does not exist.");
  }
}

// --- Groups ------------------------------------------------------------------

export async function listGroups(businessId: number) {
  const rows = await db
    .select({
      group: customerGroups,
      memberCount: sql<number>`(SELECT count(*)::int FROM ${customers} WHERE ${customers.customerGroupId} = ${customerGroups.id})`,
      pricingCount: sql<number>`(SELECT count(*)::int FROM ${customerGroupPricing} WHERE ${customerGroupPricing.groupId} = ${customerGroups.id} AND ${customerGroupPricing.isActive} = true)`,
    })
    .from(customerGroups)
    .where(eq(customerGroups.businessId, businessId))
    .orderBy(asc(customerGroups.id));
  return rows.map(({ group, memberCount, pricingCount }) => ({
    ...group,
    memberCount,
    pricingCount,
  }));
}

async function clearDefaultGroup(businessId: number): Promise<void> {
  await db
    .update(customerGroups)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(customerGroups.businessId, businessId), eq(customerGroups.isDefault, true)));
}

export async function createGroup(
  businessId: number,
  actorUserId: number | null,
  payload: { name: string; description: string | null; isDefault: boolean },
) {
  if (payload.isDefault) await clearDefaultGroup(businessId);
  try {
    const [created] = await db
      .insert(customerGroups)
      .values({
        businessId,
        name: payload.name,
        description: payload.description,
        isDefault: payload.isDefault,
      })
      .returning();
    if (!created) throw new Error("Group insert returned no row.");
    recordAudit({
      businessId,
      actorUserId,
      action: "pricing.customer_group.create",
      entityType: "customer_group",
      entityId: created.id,
      metadata: { name: created.name, isDefault: created.isDefault },
    });
    return created;
  } catch (err) {
    if (isGroupConflictError(err)) {
      throw new ConflictError(
        "A group with this name already exists (or a default group is already set).",
      );
    }
    throw err;
  }
}

export async function updateGroup(
  businessId: number,
  actorUserId: number | null,
  groupId: number,
  payload: {
    name?: string | undefined;
    description?: string | null | undefined;
    isDefault?: boolean | undefined;
    isActive?: boolean | undefined;
  },
) {
  const [existing] = await db
    .select()
    .from(customerGroups)
    .where(and(eq(customerGroups.id, groupId), eq(customerGroups.businessId, businessId)))
    .limit(1);
  if (!existing) throw new NotFoundError("Customer group not found.");

  if (payload.isDefault === true && !existing.isDefault) {
    await clearDefaultGroup(businessId);
  }
  try {
    const [updated] = await db
      .update(customerGroups)
      .set({
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.isDefault !== undefined ? { isDefault: payload.isDefault } : {}),
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(customerGroups.id, groupId), eq(customerGroups.businessId, businessId)))
      .returning();
    if (!updated) throw new Error("Group update returned no row.");
    recordAudit({
      businessId,
      actorUserId,
      action: "pricing.customer_group.update",
      entityType: "customer_group",
      entityId: groupId,
      metadata: { name: updated.name, isActive: updated.isActive, isDefault: updated.isDefault },
    });
    return updated;
  } catch (err) {
    if (isGroupConflictError(err)) {
      throw new ConflictError("A group with this name already exists.");
    }
    throw err;
  }
}

export async function deleteGroup(businessId: number, groupId: number) {
  // Membership references SET NULL; group pricing rows cascade; historical
  // sales.customer_group_id snapshots are untouched (no FK by design).
  const [deleted] = await db
    .delete(customerGroups)
    .where(and(eq(customerGroups.id, groupId), eq(customerGroups.businessId, businessId)))
    .returning();
  if (!deleted) throw new NotFoundError("Customer group not found.");
  return deleted;
}

// --- Membership ---------------------------------------------------------------

export async function assignMembers(
  businessId: number,
  actorUserId: number | null,
  groupId: number,
  customerIds: number[],
) {
  const [group] = await db
    .select({ id: customerGroups.id, name: customerGroups.name, isActive: customerGroups.isActive })
    .from(customerGroups)
    .where(and(eq(customerGroups.id, groupId), eq(customerGroups.businessId, businessId)))
    .limit(1);
  if (!group) throw new NotFoundError("Customer group not found.");
  if (!group.isActive) {
    throw new BadRequestError("Cannot assign members to an inactive group.");
  }

  const uniqueIds = [...new Set(customerIds)];
  const owned = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.businessId, businessId),
        inArray(customers.id, uniqueIds),
      ),
    );
  if (owned.length !== uniqueIds.length) {
    throw new NotFoundError("One or more customers do not exist in this business.");
  }

  const updated = await db
    .update(customers)
    .set({ customerGroupId: groupId, updatedAt: new Date() })
    .where(and(eq(customers.businessId, businessId), inArray(customers.id, uniqueIds)))
    .returning({ id: customers.id });
  recordAudit({
    businessId,
    actorUserId,
    action: "pricing.customer_group.assign_members",
    entityType: "customer_group",
    entityId: groupId,
    metadata: { assigned: updated.length, group: group.name },
  });
  return { assigned: updated.length };
}

export async function removeMember(
  businessId: number,
  groupId: number,
  customerId: number,
) {
  const updated = await db
    .update(customers)
    .set({ customerGroupId: null, updatedAt: new Date() })
    .where(
      and(
        eq(customers.businessId, businessId),
        eq(customers.id, customerId),
        eq(customers.customerGroupId, groupId),
      ),
    )
    .returning({ id: customers.id });
  if (updated.length === 0) {
    throw new NotFoundError("Customer is not a member of this group.");
  }
  return { removed: updated.length };
}

export async function listGroupMembers(businessId: number, groupId: number) {
  const [group] = await db
    .select({ id: customerGroups.id })
    .from(customerGroups)
    .where(and(eq(customerGroups.id, groupId), eq(customerGroups.businessId, businessId)))
    .limit(1);
  if (!group) throw new NotFoundError("Customer group not found.");
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      email: customers.email,
    })
    .from(customers)
    .where(
      and(eq(customers.businessId, businessId), eq(customers.customerGroupId, groupId)),
    )
    .orderBy(asc(customers.name))
    .limit(500);
  return rows;
}

// --- Group pricing -------------------------------------------------------------

export async function listGroupPricing(businessId: number, groupId: number) {
  const [group] = await db
    .select({ id: customerGroups.id })
    .from(customerGroups)
    .where(and(eq(customerGroups.id, groupId), eq(customerGroups.businessId, businessId)))
    .limit(1);
  if (!group) throw new NotFoundError("Customer group not found.");
  const rows = await db
    .select({
      pricing: customerGroupPricing,
      categoryName: categories.name,
      productName: products.name,
      sku: productVariants.sku,
    })
    .from(customerGroupPricing)
    .leftJoin(
      categories,
      and(
        eq(categories.id, customerGroupPricing.categoryId),
        eq(categories.businessId, customerGroupPricing.businessId),
      ),
    )
    .leftJoin(
      products,
      and(
        eq(products.id, customerGroupPricing.productId),
        eq(products.businessId, customerGroupPricing.businessId),
      ),
    )
    .leftJoin(
      productVariants,
      and(
        eq(productVariants.id, customerGroupPricing.variantId),
        eq(productVariants.businessId, customerGroupPricing.businessId),
      ),
    )
    .where(
      and(
        eq(customerGroupPricing.businessId, businessId),
        eq(customerGroupPricing.groupId, groupId),
      ),
    )
    .orderBy(asc(customerGroupPricing.id));
  return rows.map(({ pricing, categoryName, productName, sku }) => ({
    ...pricing,
    discountValue: Number(pricing.discountValue),
    minPurchaseAmount: Number(pricing.minPurchaseAmount),
    maxDiscountAmount:
      pricing.maxDiscountAmount == null ? null : Number(pricing.maxDiscountAmount),
    scopeLabel:
      pricing.variantId != null
        ? (sku ?? `Variant ${pricing.variantId}`)
        : pricing.productId != null
          ? (productName ?? `Product ${pricing.productId}`)
          : pricing.categoryId != null
            ? (categoryName ?? `Category ${pricing.categoryId}`)
            : "Whole cart",
  }));
}

export async function createGroupPricing(
  businessId: number,
  actorUserId: number | null,
  groupId: number,
  payload: {
    categoryId: number | null;
    productId: number | null;
    variantId: number | null;
    discountType: "percentage" | "fixed";
    discountValue: number;
    minPurchaseAmount: number;
    minQuantity: number | null;
    maxDiscountAmount: number | null;
    validFrom: string | null;
    validTo: string | null;
    stacksWithPromotions: boolean;
    isActive: boolean;
  },
) {
  const [group] = await db
    .select({ id: customerGroups.id })
    .from(customerGroups)
    .where(and(eq(customerGroups.id, groupId), eq(customerGroups.businessId, businessId)))
    .limit(1);
  if (!group) throw new NotFoundError("Customer group not found.");
  await assertScopeOwnership(businessId, payload);
  const [created] = await db
    .insert(customerGroupPricing)
    .values({
      businessId,
      groupId,
      categoryId: payload.categoryId,
      productId: payload.productId,
      variantId: payload.variantId,
      discountType: payload.discountType,
      discountValue: payload.discountValue,
      minPurchaseAmount: payload.minPurchaseAmount,
      minQuantity: payload.minQuantity,
      maxDiscountAmount: payload.maxDiscountAmount,
      validFrom: payload.validFrom,
      validTo: payload.validTo,
      stacksWithPromotions: payload.stacksWithPromotions,
      isActive: payload.isActive,
    })
    .returning();
  if (!created) throw new Error("Group pricing insert returned no row.");
  recordAudit({
    businessId,
    actorUserId,
    action: "pricing.customer_group_pricing.create",
    entityType: "customer_group_pricing",
    entityId: created.id,
    metadata: { groupId, discountType: created.discountType, value: created.discountValue },
  });
  return created;
}

export async function updateGroupPricing(
  businessId: number,
  actorUserId: number | null,
  groupId: number,
  pricingId: number,
  payload: {
    categoryId?: number | null | undefined;
    productId?: number | null | undefined;
    variantId?: number | null | undefined;
    discountType?: "percentage" | "fixed" | undefined;
    discountValue?: number | undefined;
    minPurchaseAmount?: number | undefined;
    minQuantity?: number | null | undefined;
    maxDiscountAmount?: number | null | undefined;
    validFrom?: string | null | undefined;
    validTo?: string | null | undefined;
    stacksWithPromotions?: boolean | undefined;
    isActive?: boolean | undefined;
  },
) {
  const [existing] = await db
    .select()
    .from(customerGroupPricing)
    .where(
      and(
        eq(customerGroupPricing.id, pricingId),
        eq(customerGroupPricing.groupId, groupId),
        eq(customerGroupPricing.businessId, businessId),
      ),
    )
    .limit(1);
  if (!existing) throw new NotFoundError("Group pricing rule not found.");

  const merged = {
    categoryId: payload.categoryId !== undefined ? payload.categoryId : existing.categoryId,
    productId: payload.productId !== undefined ? payload.productId : existing.productId,
    variantId: payload.variantId !== undefined ? payload.variantId : existing.variantId,
    discountType: payload.discountType ?? existing.discountType,
    discountValue:
      payload.discountValue !== undefined
        ? payload.discountValue
        : Number(existing.discountValue),
    minPurchaseAmount:
      payload.minPurchaseAmount !== undefined
        ? payload.minPurchaseAmount
        : Number(existing.minPurchaseAmount),
    minQuantity:
      payload.minQuantity !== undefined ? payload.minQuantity : existing.minQuantity,
    maxDiscountAmount:
      payload.maxDiscountAmount !== undefined
        ? payload.maxDiscountAmount
        : existing.maxDiscountAmount == null
          ? null
          : Number(existing.maxDiscountAmount),
    validFrom: payload.validFrom !== undefined ? payload.validFrom : existing.validFrom,
    validTo: payload.validTo !== undefined ? payload.validTo : existing.validTo,
    stacksWithPromotions:
      payload.stacksWithPromotions !== undefined
        ? payload.stacksWithPromotions
        : existing.stacksWithPromotions,
    isActive: payload.isActive ?? existing.isActive,
  };
  const parsed = groupPricingStrictSchema.safeParse(merged);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid group pricing update: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  await assertScopeOwnership(businessId, merged);
  const [updated] = await db
    .update(customerGroupPricing)
    .set({
      categoryId: merged.categoryId,
      productId: merged.productId,
      variantId: merged.variantId,
      discountType: merged.discountType,
      discountValue: merged.discountValue,
      minPurchaseAmount: merged.minPurchaseAmount,
      minQuantity: merged.minQuantity,
      maxDiscountAmount: merged.maxDiscountAmount,
      validFrom: merged.validFrom,
      validTo: merged.validTo,
      stacksWithPromotions: merged.stacksWithPromotions,
      isActive: merged.isActive,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(customerGroupPricing.id, pricingId),
        eq(customerGroupPricing.groupId, groupId),
        eq(customerGroupPricing.businessId, businessId),
      ),
    )
    .returning();
  if (!updated) throw new Error("Group pricing update returned no row.");
  recordAudit({
    businessId,
    actorUserId,
    action: "pricing.customer_group_pricing.update",
    entityType: "customer_group_pricing",
    entityId: pricingId,
    metadata: { groupId, isActive: updated.isActive },
  });
  return updated;
}

export async function deleteGroupPricing(
  businessId: number,
  groupId: number,
  pricingId: number,
) {
  const [deleted] = await db
    .delete(customerGroupPricing)
    .where(
      and(
        eq(customerGroupPricing.id, pricingId),
        eq(customerGroupPricing.groupId, groupId),
        eq(customerGroupPricing.businessId, businessId),
      ),
    )
    .returning();
  if (!deleted) throw new NotFoundError("Group pricing rule not found.");
  return deleted;
}
