import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { categories } from "../../db/schema/categories.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import {
  customerGroups,
  pricingPromotions,
  promotionCustomerGroups,
} from "../../db/schema/pricing.js";
import {
  BadRequestError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAudit } from "../../services/audit.js";
import { promotionStrictSchema } from "./promotions.validation.js";

/**
 * Auto-applied promotions CRUD (Phase 5, approved design §13.6). Promotions
 * are sale-time configuration — the checkout engine
 * (pricing.salePromotions.ts) consumes them; coupons (modules/promotions)
 * are untouched. Group eligibility lives in promotion_customer_groups:
 * NO rows = every customer (incl. walk-ins); rows = listed groups only.
 */

type PromotionRow = typeof pricingPromotions.$inferSelect;

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

async function assertGroupsOwnership(businessId: number, groupIds: number[]): Promise<void> {
  const unique = [...new Set(groupIds)];
  if (unique.length === 0) return;
  const owned = await db
    .select({ id: customerGroups.id })
    .from(customerGroups)
    .where(and(eq(customerGroups.businessId, businessId), inArray(customerGroups.id, unique)));
  if (owned.length !== unique.length) {
    throw new NotFoundError("One or more customer groups do not exist in this business.");
  }
}

async function replaceGroupEligibility(
  businessId: number,
  promotionId: number,
  groupIds: number[],
): Promise<void> {
  await db
    .delete(promotionCustomerGroups)
    .where(
      and(
        eq(promotionCustomerGroups.promotionId, promotionId),
        eq(promotionCustomerGroups.businessId, businessId),
      ),
    );
  if (groupIds.length > 0) {
    await db.insert(promotionCustomerGroups).values(
      groupIds.map((groupId) => ({ businessId, promotionId, groupId })),
    );
  }
}

async function loadGroupEligibility(
  businessId: number,
  promotionId: number,
): Promise<number[]> {
  const rows = await db
    .select({ groupId: promotionCustomerGroups.groupId })
    .from(promotionCustomerGroups)
    .where(
      and(
        eq(promotionCustomerGroups.businessId, businessId),
        eq(promotionCustomerGroups.promotionId, promotionId),
      ),
    );
  return rows.map((r) => r.groupId);
}

function scopeLabelOf(row: {
  variantId: number | null;
  productId: number | null;
  categoryId: number | null;
  sku: string | null;
  productName: string | null;
  categoryName: string | null;
}): string {
  return row.variantId != null
    ? (row.sku ?? `Variant ${row.variantId}`)
    : row.productId != null
      ? (row.productName ?? `Product ${row.productId}`)
      : row.categoryId != null
        ? (row.categoryName ?? `Category ${row.categoryId}`)
        : "Whole business";
}

export async function listPromotions(businessId: number) {
  const rows = await db
    .select({
      promotion: pricingPromotions,
      categoryName: categories.name,
      productName: products.name,
      sku: productVariants.sku,
    })
    .from(pricingPromotions)
    .leftJoin(
      categories,
      and(
        eq(categories.id, pricingPromotions.categoryId),
        eq(categories.businessId, pricingPromotions.businessId),
      ),
    )
    .leftJoin(
      products,
      and(
        eq(products.id, pricingPromotions.productId),
        eq(products.businessId, pricingPromotions.businessId),
      ),
    )
    .leftJoin(
      productVariants,
      and(
        eq(productVariants.id, pricingPromotions.variantId),
        eq(productVariants.businessId, pricingPromotions.businessId),
      ),
    )
    .where(eq(pricingPromotions.businessId, businessId))
    .orderBy(asc(pricingPromotions.id));
  if (rows.length === 0) return [];
  const eligibility = await db
    .select({
      promotionId: promotionCustomerGroups.promotionId,
      groupId: promotionCustomerGroups.groupId,
      groupName: customerGroups.name,
    })
    .from(promotionCustomerGroups)
    .innerJoin(
      customerGroups,
      and(
        eq(promotionCustomerGroups.groupId, customerGroups.id),
        eq(promotionCustomerGroups.businessId, customerGroups.businessId),
      ),
    )
    .where(
      and(
        eq(promotionCustomerGroups.businessId, businessId),
        inArray(
          promotionCustomerGroups.promotionId,
          rows.map((r) => r.promotion.id),
        ),
      ),
    );
  const groupsByPromo = new Map<number, { id: number; name: string }[]>();
  for (const row of eligibility) {
    const list = groupsByPromo.get(row.promotionId) ?? [];
    list.push({ id: row.groupId, name: row.groupName });
    groupsByPromo.set(row.promotionId, list);
  }
  return rows.map(({ promotion, categoryName, productName, sku }) => ({
    ...promotion,
    discountValue: Number(promotion.discountValue),
    minOrderValue: Number(promotion.minOrderValue),
    maxDiscountAmount:
      promotion.maxDiscountAmount == null
        ? null
        : Number(promotion.maxDiscountAmount),
    scopeLabel: scopeLabelOf({ ...promotion, categoryName, productName, sku }),
    customerGroups: groupsByPromo.get(promotion.id) ?? [],
  }));
}

export async function createPromotion(
  businessId: number,
  actorUserId: number | null,
  payload: {
    name: string;
    categoryId?: number | null | undefined;
    productId?: number | null | undefined;
    variantId?: number | null | undefined;
    discountType: "percentage" | "fixed";
    discountValue: number;
    startsAt?: Date | null | undefined;
    endsAt?: Date | null | undefined;
    minQuantity?: number | null | undefined;
    minOrderValue?: number | undefined;
    maxDiscountAmount?: number | null | undefined;
    canStackWithGroupDiscount?: boolean | undefined;
    canStackWithCoupons?: boolean | undefined;
    promoKind?: "discount" | "bogo" | "buy_x_get_y" | "mix_match" | "quantity_tier" | undefined;
    rule?: Record<string, unknown> | null | undefined;
    daysOfWeek?: number[] | null | undefined;
    startTime?: string | null | undefined;
    endTime?: string | null | undefined;
    locationId?: number | null | undefined;
    usageLimit?: number | null | undefined;
    perCustomerLimit?: number | null | undefined;
    priority?: number | undefined;
    isActive?: boolean | undefined;
    groupIds?: number[] | undefined;
  },
) {
  const scope = {
    categoryId: payload.categoryId ?? null,
    productId: payload.productId ?? null,
    variantId: payload.variantId ?? null,
  };
  await assertScopeOwnership(businessId, scope);
  const groupIds = payload.groupIds ?? [];
  await assertGroupsOwnership(businessId, groupIds);
  const [created] = await db
    .insert(pricingPromotions)
    .values({
      businessId,
      name: payload.name,
      ...scope,
      discountType: payload.discountType,
      discountValue: payload.discountValue,
      startsAt: payload.startsAt ?? null,
      endsAt: payload.endsAt ?? null,
      minQuantity: payload.minQuantity ?? null,
      minOrderValue: payload.minOrderValue ?? 0,
      maxDiscountAmount: payload.maxDiscountAmount ?? null,
      canStackWithGroupDiscount: payload.canStackWithGroupDiscount ?? false,
      canStackWithCoupons: payload.canStackWithCoupons ?? false,
      promoKind: (payload.promoKind as string | undefined) ?? "discount",
      rule: (payload.rule as Record<string, unknown> | null | undefined) ?? null,
      daysOfWeek: (payload.daysOfWeek as number[] | null | undefined) ?? null,
      startTime: (payload.startTime as string | null | undefined) ?? null,
      endTime: (payload.endTime as string | null | undefined) ?? null,
      locationId: (payload.locationId as number | null | undefined) ?? null,
      usageLimit: (payload.usageLimit as number | null | undefined) ?? null,
      perCustomerLimit: (payload.perCustomerLimit as number | null | undefined) ?? null,
      priority: (payload.priority as number | undefined) ?? 0,
      isActive: payload.isActive ?? true,
    })
    .returning();
  if (!created) throw new Error("Promotion insert returned no row.");
  await replaceGroupEligibility(businessId, created.id, groupIds);
  recordAudit({
    businessId,
    actorUserId,
    action: "pricing.promotion.create",
    entityType: "pricing_promotion",
    entityId: created.id,
    metadata: { name: created.name, discountType: created.discountType, value: created.discountValue },
  });
  return { ...created, customerGroups: groupIds.map((id) => ({ id })) };
}

export async function updatePromotion(
  businessId: number,
  actorUserId: number | null,
  promotionId: number,
  payload: Record<string, unknown> & { groupIds?: number[] | undefined },
) {
  const [existing] = await db
    .select()
    .from(pricingPromotions)
    .where(
      and(eq(pricingPromotions.id, promotionId), eq(pricingPromotions.businessId, businessId)),
    )
    .limit(1);
  if (!existing) throw new NotFoundError("Promotion not found.");

  const merged = {
    name: (payload.name as string | undefined) ?? existing.name,
    categoryId:
      payload.categoryId !== undefined ? (payload.categoryId as number | null) : existing.categoryId,
    productId:
      payload.productId !== undefined ? (payload.productId as number | null) : existing.productId,
    variantId:
      payload.variantId !== undefined ? (payload.variantId as number | null) : existing.variantId,
    discountType: (payload.discountType as string | undefined) ?? existing.discountType,
    discountValue:
      payload.discountValue !== undefined
        ? (payload.discountValue as number)
        : Number(existing.discountValue),
    startsAt: payload.startsAt !== undefined ? (payload.startsAt as Date | null) : existing.startsAt,
    endsAt: payload.endsAt !== undefined ? (payload.endsAt as Date | null) : existing.endsAt,
    minQuantity:
      payload.minQuantity !== undefined
        ? (payload.minQuantity as number | null)
        : existing.minQuantity,
    minOrderValue:
      payload.minOrderValue !== undefined
        ? (payload.minOrderValue as number)
        : Number(existing.minOrderValue),
    maxDiscountAmount:
      payload.maxDiscountAmount !== undefined
        ? (payload.maxDiscountAmount as number | null)
        : existing.maxDiscountAmount == null
          ? null
          : Number(existing.maxDiscountAmount),
    canStackWithGroupDiscount:
      (payload.canStackWithGroupDiscount as boolean | undefined) ??
      existing.canStackWithGroupDiscount,
    canStackWithCoupons:
      (payload.canStackWithCoupons as boolean | undefined) ?? existing.canStackWithCoupons,
    promoKind:
      (payload.promoKind as string | undefined) ??
      (existing.promoKind as string | undefined) ??
      "discount",
    rule:
      (payload.rule as Record<string, unknown> | null | undefined) ??
      (existing.rule as Record<string, unknown> | null | undefined) ??
      null,
    daysOfWeek:
      (payload.daysOfWeek as number[] | null | undefined) ??
      (existing.daysOfWeek as number[] | null | undefined) ??
      null,
    startTime:
      (payload.startTime as string | null | undefined) ?? existing.startTime ?? null,
    endTime:
      (payload.endTime as string | null | undefined) ?? existing.endTime ?? null,
    locationId:
      (payload.locationId as number | null | undefined) ?? existing.locationId ?? null,
    usageLimit:
      (payload.usageLimit as number | null | undefined) ?? existing.usageLimit ?? null,
    perCustomerLimit:
      (payload.perCustomerLimit as number | null | undefined) ??
      existing.perCustomerLimit ??
      null,
    priority: (payload.priority as number | undefined) ?? existing.priority ?? 0,
    isActive: (payload.isActive as boolean | undefined) ?? existing.isActive,
  };
  const parsed = promotionStrictSchema.safeParse(merged);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid promotion update: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  await assertScopeOwnership(businessId, merged);
  if (payload.groupIds !== undefined) {
    await assertGroupsOwnership(businessId, payload.groupIds);
  }
  const [updated] = await db
    .update(pricingPromotions)
    .set({
      name: merged.name,
      categoryId: merged.categoryId,
      productId: merged.productId,
      variantId: merged.variantId,
      discountType: merged.discountType,
      discountValue: merged.discountValue,
      startsAt: merged.startsAt,
      endsAt: merged.endsAt,
      minQuantity: merged.minQuantity,
      minOrderValue: merged.minOrderValue,
      maxDiscountAmount: merged.maxDiscountAmount,
      canStackWithGroupDiscount: merged.canStackWithGroupDiscount,
      canStackWithCoupons: merged.canStackWithCoupons,
      promoKind: merged.promoKind,
      rule: merged.rule,
      daysOfWeek: merged.daysOfWeek,
      startTime: merged.startTime,
      endTime: merged.endTime,
      locationId: merged.locationId,
      usageLimit: merged.usageLimit,
      perCustomerLimit: merged.perCustomerLimit,
      priority: merged.priority,
      isActive: merged.isActive,
      updatedAt: new Date(),
    })
    .where(
      and(eq(pricingPromotions.id, promotionId), eq(pricingPromotions.businessId, businessId)),
    )
    .returning();
  if (!updated) throw new Error("Promotion update returned no row.");
  let customerGroupsOut: { id: number }[] | undefined;
  if (payload.groupIds !== undefined) {
    await replaceGroupEligibility(businessId, promotionId, payload.groupIds);
    customerGroupsOut = payload.groupIds.map((id) => ({ id }));
  }
  recordAudit({
    businessId,
    actorUserId,
    action: "pricing.promotion.update",
    entityType: "pricing_promotion",
    entityId: promotionId,
    metadata: { name: updated.name, isActive: updated.isActive },
  });
  return {
    ...updated,
    ...(customerGroupsOut ? { customerGroups: customerGroupsOut } : {}),
  };
}

export async function deletePromotion(businessId: number, promotionId: number) {
  // Eligibility rows cascade; historical sale_items.price_adjustments keep
  // their content (no FK by design — snapshots are self-describing).
  const [deleted] = await db
    .delete(pricingPromotions)
    .where(
      and(eq(pricingPromotions.id, promotionId), eq(pricingPromotions.businessId, businessId)),
    )
    .returning();
  if (!deleted) throw new NotFoundError("Promotion not found.");
  return deleted;
}

export async function getPromotion(businessId: number, promotionId: number) {
  const [row] = await db
    .select({ promotion: pricingPromotions })
    .from(pricingPromotions)
    .where(
      and(eq(pricingPromotions.id, promotionId), eq(pricingPromotions.businessId, businessId)),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Promotion not found.");
  const groupIds = await loadGroupEligibility(businessId, promotionId);
  return { ...row.promotion, customerGroups: groupIds.map((id) => ({ id })) };
}

export type { PromotionRow };
