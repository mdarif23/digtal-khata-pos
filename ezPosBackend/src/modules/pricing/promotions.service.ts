import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { categories } from "../../db/schema/categories.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import {
  customerGroups,
  pricingPromotions,
  promotionBundleComponents,
  promotionCustomerGroups,
  promotionUsage,
} from "../../db/schema/pricing.js";
import {
  BadRequestError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAudit } from "../../services/audit.js";
import { getBusinessTimezone } from "../../services/ledger.js";
import { businessLocalToUtcWall } from "../../utils/money.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { promotionStrictSchema } from "./promotions.validation.js";
import { dhakaNow } from "./pricing.salePromotions.js";

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

// ---------------------------------------------------------------------------
// Bundle components (Bundle & Combo Phase 1): the component multiset of a
// `bundle` promotion. Components must belong to the business (composite FK
// + explicit ownership assert) and cannot repeat within one bundle.
// ---------------------------------------------------------------------------

interface ComponentInput {
  variantId: number;
  quantity: number;
}

export interface PromotionComponent {
  variantId: number;
  quantity: number;
  sku: string | null;
  productName: string | null;
  sellingPrice: number;
}

async function assertComponentsOwnership(
  businessId: number,
  components: ComponentInput[],
): Promise<void> {
  if (components.length === 0) {
    throw new BadRequestError("A bundle needs at least one component.");
  }
  const variantIds = [...new Set(components.map((c) => c.variantId))];
  if (variantIds.length !== components.length) {
    throw new BadRequestError(
      "A bundle cannot list the same variant twice — merge its quantities.",
    );
  }
  const owned = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.businessId, businessId),
        inArray(productVariants.id, variantIds),
      ),
    );
  if (owned.length !== variantIds.length) {
    throw new NotFoundError(
      "One or more bundle components do not exist in this business.",
    );
  }
}

async function replaceComponents(
  businessId: number,
  promotionId: number,
  components: ComponentInput[],
): Promise<void> {
  await db
    .delete(promotionBundleComponents)
    .where(
      and(
        eq(promotionBundleComponents.promotionId, promotionId),
        eq(promotionBundleComponents.businessId, businessId),
      ),
    );
  if (components.length > 0) {
    await db.insert(promotionBundleComponents).values(
      components.map((c) => ({
        businessId,
        promotionId,
        variantId: c.variantId,
        quantity: c.quantity,
      })),
    );
  }
}

async function loadComponents(
  businessId: number,
  promotionIds: number[],
): Promise<Map<number, PromotionComponent[]>> {
  const byPromo = new Map<number, PromotionComponent[]>();
  if (promotionIds.length === 0) return byPromo;
  const rows = await db
    .select({
      promotionId: promotionBundleComponents.promotionId,
      variantId: promotionBundleComponents.variantId,
      quantity: promotionBundleComponents.quantity,
      sku: productVariants.sku,
      productName: products.name,
      sellingPrice: productVariants.sellingPrice,
    })
    .from(promotionBundleComponents)
    .innerJoin(
      productVariants,
      and(
        eq(productVariants.id, promotionBundleComponents.variantId),
        eq(productVariants.businessId, promotionBundleComponents.businessId),
      ),
    )
    .innerJoin(
      products,
      and(
        eq(products.id, productVariants.productId),
        eq(products.businessId, productVariants.businessId),
      ),
    )
    .where(
      and(
        eq(promotionBundleComponents.businessId, businessId),
        inArray(promotionBundleComponents.promotionId, promotionIds),
      ),
    );
  for (const row of rows) {
    const list = byPromo.get(row.promotionId) ?? [];
    list.push({
      variantId: row.variantId,
      quantity: Number(row.quantity),
      sku: row.sku,
      productName: row.productName,
      sellingPrice: Number(row.sellingPrice),
    });
    byPromo.set(row.promotionId, list);
  }
  return byPromo;
}

/** Normal total of a component list (display/savings preview; the engine
 * prices from live cart lines at sale time). */
function componentTotalOf(components: PromotionComponent[]): number {
  return roundMoney(
    components.reduce((sum, c) => sum + c.sellingPrice * c.quantity, 0),
  );
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
  const componentsByPromo = await loadComponents(
    businessId,
    rows.map((r) => r.promotion.id),
  );
  return rows.map(({ promotion, categoryName, productName, sku }) => {
    const components = componentsByPromo.get(promotion.id) ?? [];
    return {
      ...promotion,
      discountValue: Number(promotion.discountValue),
      minOrderValue: Number(promotion.minOrderValue),
      maxDiscountAmount:
        promotion.maxDiscountAmount == null
          ? null
          : Number(promotion.maxDiscountAmount),
      scopeLabel: scopeLabelOf({ ...promotion, categoryName, productName, sku }),
      customerGroups: groupsByPromo.get(promotion.id) ?? [],
      components,
      ...(components.length > 0
        ? { componentTotal: componentTotalOf(components) }
        : {}),
    };
  });
}

/**
 * I3-6: a date-only 'YYYY-MM-DD' boundary is interpreted on the BUSINESS
 * calendar (starts → 00:00:00, ends → 23:59:59.999) instead of being pinned
 * to the browser's local midnight. Full ISO timestamps pass through.
 */
async function resolveDateBound(
  businessId: number,
  value: Date | string | null | undefined,
  boundary: "start" | "end",
): Promise<Date | null | undefined> {
  if (value == null || value instanceof Date) return value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(value);
  const tz = await getBusinessTimezone(db, businessId);
  const wall = businessLocalToUtcWall(
    value,
    boundary === "start" ? "00:00:00" : "23:59:59.999",
    tz,
  );
  // The session is UTC-pinned (see businessLocalToUtcWall) — the wall
  // string is exactly the UTC instant of the business-local boundary.
  return new Date(`${wall.replace(" ", "T")}Z`);
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
    startsAt?: Date | string | null | undefined;
    endsAt?: Date | string | null | undefined;
    minQuantity?: number | null | undefined;
    minOrderValue?: number | undefined;
    maxDiscountAmount?: number | null | undefined;
    canStackWithGroupDiscount?: boolean | undefined;
    canStackWithCoupons?: boolean | undefined;
    promoKind?:
      | "discount"
      | "bogo"
      | "buy_x_get_y"
      | "mix_match"
      | "quantity_tier"
      | "bundle"
      | "spend_get"
      | undefined;
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
    components?: ComponentInput[] | undefined;
  },
) {
  const scope = {
    categoryId: payload.categoryId ?? null,
    productId: payload.productId ?? null,
    variantId: payload.variantId ?? null,
  };
  const isBundle = (payload.promoKind as string | undefined) === "bundle";
  // Rule-target kinds carry their pricing in `rule`; the generic discount
  // columns are vestigial for them and normalized out of the payload.
  const isRewardTargetKind =
    isBundle || (payload.promoKind as string | undefined) === "spend_get";
  if (payload.components !== undefined && !isBundle) {
    throw new BadRequestError(
      "Bundle components only apply to 'bundle' promotions.",
    );
  }
  await assertScopeOwnership(businessId, scope);
  const groupIds = payload.groupIds ?? [];
  await assertGroupsOwnership(businessId, groupIds);
  const discountType = isRewardTargetKind
    ? ("fixed" as const)
    : payload.discountType;
  const discountValue = isRewardTargetKind ? 0 : payload.discountValue;
  if (isBundle) {
    await assertComponentsOwnership(businessId, payload.components ?? []);
  }
  const [created] = await db
    .insert(pricingPromotions)
    .values({
      businessId,
      name: payload.name,
      ...scope,
      discountType,
      discountValue,
      startsAt: (await resolveDateBound(businessId, payload.startsAt, "start")) ?? null,
      endsAt: (await resolveDateBound(businessId, payload.endsAt, "end")) ?? null,
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
  if (isBundle) {
    await replaceComponents(businessId, created.id, payload.components ?? []);
  }
  recordAudit({
    businessId,
    actorUserId,
    action: "pricing.promotion.create",
    entityType: "pricing_promotion",
    entityId: created.id,
    metadata: {
      name: created.name,
      discountType: created.discountType,
      value: created.discountValue,
      ...(isBundle ? { promoKind: "bundle", components: payload.components ?? [] } : {}),
    },
  });
  return { ...created, customerGroups: groupIds.map((id) => ({ id })) };
}

export async function updatePromotion(
  businessId: number,
  actorUserId: number | null,
  promotionId: number,
  payload: Record<string, unknown> & {
    groupIds?: number[] | undefined;
    components?: ComponentInput[] | undefined;
  },
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
    startsAt:
      payload.startsAt !== undefined
        ? ((await resolveDateBound(businessId, payload.startsAt as Date | string | null, "start")) ?? null)
        : existing.startsAt,
    endsAt:
      payload.endsAt !== undefined
        ? ((await resolveDateBound(businessId, payload.endsAt as Date | string | null, "end")) ?? null)
        : existing.endsAt,
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
    // H3-2: these seven fields must use the `!== undefined` merge (like
    // categoryId/startsAt above) — the `??` chain treated an explicit null
    // (the FE edit dialog sends null/[] for cleared fields) as "not
    // provided" and resurrected the old value, so switching promoKind away
    // from bogo kept the stale rule and flash windows could never be
    // cleared.
    rule:
      payload.rule !== undefined
        ? (payload.rule as Record<string, unknown> | null)
        : ((existing.rule as Record<string, unknown> | null | undefined) ??
          null),
    daysOfWeek:
      payload.daysOfWeek !== undefined
        ? (payload.daysOfWeek as number[] | null)
        : ((existing.daysOfWeek as number[] | null | undefined) ?? null),
    startTime:
      payload.startTime !== undefined
        ? (payload.startTime as string | null)
        : (existing.startTime ?? null),
    endTime:
      payload.endTime !== undefined
        ? (payload.endTime as string | null)
        : (existing.endTime ?? null),
    locationId:
      payload.locationId !== undefined
        ? (payload.locationId as number | null)
        : (existing.locationId ?? null),
    usageLimit:
      payload.usageLimit !== undefined
        ? (payload.usageLimit as number | null)
        : (existing.usageLimit ?? null),
    perCustomerLimit:
      payload.perCustomerLimit !== undefined
        ? (payload.perCustomerLimit as number | null)
        : (existing.perCustomerLimit ?? null),
    priority: (payload.priority as number | undefined) ?? existing.priority ?? 0,
    isActive: (payload.isActive as boolean | undefined) ?? existing.isActive,
  };
  // Rule-target kinds carry their price in `rule`; normalize the vestigial
  // discount columns after the merge so switching kinds cannot leave stale
  // data.
  const mergedIsBundle = merged.promoKind === "bundle";
  if (mergedIsBundle || merged.promoKind === "spend_get") {
    merged.discountType = "fixed";
    merged.discountValue = 0;
  }
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
  if (payload.components !== undefined && !mergedIsBundle) {
    throw new BadRequestError(
      "Bundle components only apply to 'bundle' promotions.",
    );
  }
  if (payload.components !== undefined) {
    await assertComponentsOwnership(businessId, payload.components);
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
  let componentsOut: PromotionComponent[] | undefined;
  if (payload.components !== undefined) {
    await replaceComponents(businessId, promotionId, payload.components);
  } else if (!mergedIsBundle && (existing.promoKind as string | undefined) === "bundle") {
    // Kind switched away from bundle — the component rows lose their
    // meaning, so they are dropped instead of lingering.
    await replaceComponents(businessId, promotionId, []);
  }
  if (mergedIsBundle) {
    const loaded = await loadComponents(businessId, [promotionId]);
    componentsOut = loaded.get(promotionId) ?? [];
  }
  recordAudit({
    businessId,
    actorUserId,
    action: "pricing.promotion.update",
    entityType: "pricing_promotion",
    entityId: promotionId,
    metadata: {
      name: updated.name,
      isActive: updated.isActive,
      ...(payload.components !== undefined
        ? { components: payload.components }
        : {}),
    },
  });
  return {
    ...updated,
    ...(customerGroupsOut ? { customerGroups: customerGroupsOut } : {}),
    ...(componentsOut ? { components: componentsOut } : {}),
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
  const components = await loadComponents(businessId, [promotionId]);
  const componentList = components.get(promotionId) ?? [];
  return {
    ...row.promotion,
    customerGroups: groupIds.map((id) => ({ id })),
    components: componentList,
    ...(componentList.length > 0
      ? { componentTotal: componentTotalOf(componentList) }
      : {}),
  };
}

/**
 * POS-facing active bundles (Bundle & Combo Phase 2): the bundle-kind
 * promotions that could apply RIGHT NOW, with their components so the POS
 * can offer one-tap "add bundle" and complete-the-bundle actions. Gated
 * pos.view (promotions are store configuration — cashiers never hold
 * promotions.view). Mirrors the engine's window/location/usage filters
 * (flash windows evaluated in Asia/Dhaka) so a card never advertises a
 * bundle that cannot apply; cart-dependent conditions (minimums, group
 * restrictions, stacking consent) stay the engine's job at quote time.
 */
export async function listActiveBundlePromotions(
  businessId: number,
  locationId: number | null,
) {
  const rows = await db
    .select()
    .from(pricingPromotions)
    .where(
      and(
        eq(pricingPromotions.businessId, businessId),
        eq(pricingPromotions.isActive, true),
        eq(pricingPromotions.promoKind, "bundle"),
      ),
    );
  if (rows.length === 0) return [];

  const now = new Date();
  const dhaka = dhakaNow(now);
  const candidateIds: number[] = [];
  for (const row of rows) {
    if (row.startsAt && row.startsAt > now) continue;
    if (row.endsAt && row.endsAt < now) continue;
    if (row.locationId != null && row.locationId !== locationId) continue;
    if (
      row.daysOfWeek != null &&
      Array.isArray(row.daysOfWeek) &&
      row.daysOfWeek.length > 0 &&
      !row.daysOfWeek.includes(dhaka.dayOfWeek)
    ) {
      continue;
    }
    if (row.startTime != null && row.endTime != null) {
      const inWindow =
        row.startTime <= row.endTime
          ? dhaka.hhmm >= row.startTime && dhaka.hhmm <= row.endTime
          : dhaka.hhmm >= row.startTime || dhaka.hhmm <= row.endTime; // overnight
      if (!inWindow) continue;
    }
    candidateIds.push(row.id);
  }
  if (candidateIds.length === 0) return [];

  // Fully redeemed bundles are not advertised (per-customer limits are
  // cart/customer-dependent — the engine governs those at quote time).
  const usageRows = await db
    .select({
      promotionId: promotionUsage.promotionId,
      total: sql<string>`COUNT(*)`,
    })
    .from(promotionUsage)
    .where(
      and(
        eq(promotionUsage.businessId, businessId),
        inArray(promotionUsage.promotionId, candidateIds),
      ),
    )
    .groupBy(promotionUsage.promotionId);
  const usageTotals = new Map<number, number>();
  for (const row of usageRows) usageTotals.set(row.promotionId, Number(row.total));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const liveIds = candidateIds.filter((id) => {
    const limit = byId.get(id)?.usageLimit;
    return limit == null || (usageTotals.get(id) ?? 0) < limit;
  });
  if (liveIds.length === 0) return [];

  const componentsByPromo = await loadComponents(businessId, liveIds);
  const out: {
    id: number;
    name: string;
    rule: Record<string, unknown> | null;
    endsAt: Date | null;
    components: PromotionComponent[];
    normalTotal: number;
  }[] = [];
  for (const id of liveIds) {
    const row = byId.get(id)!;
    const components = componentsByPromo.get(id) ?? [];
    if (components.length === 0) continue; // malformed config — never advertise
    out.push({
      id: row.id,
      name: row.name,
      rule: (row.rule ?? null) as Record<string, unknown> | null,
      endsAt: row.endsAt,
      components,
      normalTotal: componentTotalOf(components),
    });
  }
  return out;
}

export type { PromotionRow };
