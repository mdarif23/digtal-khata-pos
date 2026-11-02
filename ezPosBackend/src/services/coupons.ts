import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { coupons, couponRedemptions } from "../db/schema/coupons.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/handleError.js";
import { roundMoney } from "../utils/roundMoney.js";
import type { DbTransaction } from "../modules/purchases/purchase.types.js";

/**
 * Coupons (Module 6): validation and redemption. The evaluation result is
 * used by BOTH the checkout quote (so the cashier sees the exact discount
 * before charging) and createSale (server-validated, redemption recorded
 * in the sale transaction — reuse race-free via the usage-limit counter).
 */

export interface CouponEvaluation {
  couponId: number;
  code: string;
  discountAmount: number;
  description: string | null;
}

interface CouponRow {
  id: number;
  code: string;
  description: string | null;
  discountType: string;
  value: number;
  minOrderAmount: number;
  maxDiscountAmount: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  usedCount: number;
  isActive: boolean;
}

async function findCouponByCode(
  tx: DbTransaction | typeof db,
  businessId: number,
  code: string,
): Promise<CouponRow | null> {
  const [row] = await tx
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.businessId, businessId),
        eq(sql`upper(${coupons.code})`, code.trim().toUpperCase()),
      ),
    )
    .limit(1);
  return (row as CouponRow | undefined) ?? null;
}

/**
 * Evaluates a coupon against the cart's after-item-discount total. Throws
 * a customer-actionable BadRequestError on every invalid condition, so the
 * quote endpoint and createSale share identical rules.
 */
export async function evaluateCouponInTx(
  tx: DbTransaction | typeof db,
  input: {
    businessId: number;
    code: string;
    afterDiscountTotal: number;
    customerId: number | null;
    /** When true (redemption), the coupon row is locked FOR UPDATE. */
    forRedemption?: boolean;
  },
): Promise<CouponEvaluation> {
  const code = input.code.trim();
  if (code.length === 0) {
    throw new BadRequestError("Enter a coupon code.");
  }
  const couponQuery = findCouponByCode(tx, input.businessId, code);
  const coupon = input.forRedemption
    ? await (async () => {
        // Lock the row for the redemption path (usage-limit race).
        const found = await couponQuery;
        if (!found) throw new NotFoundError("Coupon not found.");
        const [locked] = await tx
          .select()
          .from(coupons)
          .where(eq(coupons.id, found.id))
          .for("update");
        return locked as CouponRow;
      })()
    : await couponQuery;
  if (!coupon) throw new NotFoundError("Coupon not found.");

  if (!coupon.isActive) {
    throw new BadRequestError("This coupon is no longer active.");
  }
  const now = new Date();
  if (coupon.startsAt !== null && coupon.startsAt.getTime() > now.getTime()) {
    throw new BadRequestError(
      `This coupon starts on ${coupon.startsAt.toLocaleDateString()}.`,
    );
  }
  if (coupon.endsAt !== null && coupon.endsAt.getTime() < now.getTime()) {
    throw new BadRequestError("This coupon has expired.");
  }
  if (
    coupon.usageLimit !== null &&
    coupon.usedCount >= coupon.usageLimit
  ) {
    throw new BadRequestError("This coupon has reached its usage limit.");
  }
  if (
    input.customerId !== null &&
    coupon.perCustomerLimit !== null &&
    coupon.perCustomerLimit > 0
  ) {
    const [used] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(couponRedemptions)
      .where(
        and(
          eq(couponRedemptions.couponId, coupon.id),
          eq(couponRedemptions.customerId, input.customerId),
        ),
      );
    if (Number(used?.count ?? 0) >= coupon.perCustomerLimit) {
      throw new BadRequestError(
        "You have already used this coupon the maximum number of times.",
      );
    }
  }
  const total = roundMoney(input.afterDiscountTotal);
  if (total < Number(coupon.minOrderAmount)) {
    throw new BadRequestError(
      `This coupon requires a minimum order of ৳${Number(coupon.minOrderAmount).toFixed(2)}.`,
    );
  }

  let discount =
    coupon.discountType === "percentage"
      ? roundMoney((total * Number(coupon.value)) / 100)
      : roundMoney(Number(coupon.value));
  if (discount > total) discount = total;
  if (coupon.maxDiscountAmount !== null) {
    discount = Math.min(discount, Number(coupon.maxDiscountAmount));
  }
  if (discount <= 0) {
    throw new BadRequestError("This coupon does not reduce this order.");
  }
  return {
    couponId: coupon.id,
    code: coupon.code,
    discountAmount: discount,
    description: coupon.description,
  };
}

/** Records the redemption and bumps the usage counter (redemption path). */
export async function recordCouponRedemptionInTx(
  tx: DbTransaction,
  input: {
    businessId: number;
    couponId: number;
    saleId: number;
    customerId: number | null;
    discountAmount: number;
  },
): Promise<void> {
  await tx.insert(couponRedemptions).values({
    businessId: input.businessId,
    couponId: input.couponId,
    saleId: input.saleId,
    customerId: input.customerId,
    discountAmount: roundMoney(input.discountAmount),
  });
  await tx
    .update(coupons)
    .set({ usedCount: sql`${coupons.usedCount} + 1`, updatedAt: new Date() })
    .where(eq(coupons.id, input.couponId));
}

// --- CRUD -------------------------------------------------------------------

export interface CouponPayload {
  code: string;
  description?: string | null | undefined;
  discountType: "percentage" | "fixed";
  value: number;
  minOrderAmount?: number | null | undefined;
  maxDiscountAmount?: number | null | undefined;
  startsAt?: string | null | undefined;
  endsAt?: string | null | undefined;
  usageLimit?: number | null | undefined;
  perCustomerLimit?: number | null | undefined;
  isActive?: boolean | undefined;
}

export async function listCoupons(businessId: number) {
  return db
    .select()
    .from(coupons)
    .where(eq(coupons.businessId, businessId))
    .orderBy(desc(coupons.id))
    .limit(200);
}

async function assertValidPayload(payload: CouponPayload) {
  if (payload.value < 0) throw new BadRequestError("Value cannot be negative.");
  if (payload.discountType === "percentage" && payload.value > 100) {
    throw new BadRequestError("Percentage discounts cannot exceed 100.");
  }
  if (
    payload.startsAt &&
    payload.endsAt &&
    new Date(payload.startsAt) > new Date(payload.endsAt)
  ) {
    throw new BadRequestError("startsAt must not be after endsAt.");
  }
}

export async function createCoupon(
  businessId: number,
  payload: CouponPayload,
) {
  await assertValidPayload(payload);
  try {
    const [created] = await db
      .insert(coupons)
      .values({
        businessId,
        code: payload.code.trim().toUpperCase(),
        description: payload.description ?? null,
        discountType: payload.discountType,
        value: roundMoney(payload.value),
        minOrderAmount: roundMoney(payload.minOrderAmount ?? 0),
        maxDiscountAmount:
          payload.maxDiscountAmount !== null &&
          payload.maxDiscountAmount !== undefined
            ? roundMoney(payload.maxDiscountAmount)
            : null,
        startsAt: payload.startsAt ? new Date(payload.startsAt) : null,
        endsAt: payload.endsAt ? new Date(payload.endsAt) : null,
        usageLimit: payload.usageLimit ?? null,
        perCustomerLimit: payload.perCustomerLimit ?? null,
        isActive: payload.isActive ?? true,
      })
      .returning();
    if (!created) throw new Error("Coupon insert returned no row.");
    return created;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      throw new ConflictError("A coupon with this code already exists.");
    }
    throw err;
  }
}

export async function updateCoupon(
  businessId: number,
  couponId: number,
  payload: { [K in keyof CouponPayload]?: CouponPayload[K] | undefined },
) {
  const [existing] = await db
    .select({ id: coupons.id })
    .from(coupons)
    .where(and(eq(coupons.id, couponId), eq(coupons.businessId, businessId)))
    .limit(1);
  if (!existing) throw new NotFoundError("Coupon not found.");
  const merged: CouponPayload = {
    code: "merged",
    discountType: "fixed",
    value: 0,
    ...payload,
  } as CouponPayload;
  await assertValidPayload(merged);
  const [updated] = await db
    .update(coupons)
    .set({
      ...(payload.description !== undefined
        ? { description: payload.description }
        : {}),
      ...(payload.value !== undefined ? { value: roundMoney(payload.value) } : {}),
      ...(payload.minOrderAmount !== undefined
        ? { minOrderAmount: roundMoney(payload.minOrderAmount ?? 0) }
        : {}),
      ...(payload.maxDiscountAmount !== undefined
        ? {
            maxDiscountAmount:
              payload.maxDiscountAmount === null
                ? null
                : roundMoney(payload.maxDiscountAmount),
          }
        : {}),
      ...(payload.startsAt !== undefined
        ? { startsAt: payload.startsAt ? new Date(payload.startsAt) : null }
        : {}),
      ...(payload.endsAt !== undefined
        ? { endsAt: payload.endsAt ? new Date(payload.endsAt) : null }
        : {}),
      ...(payload.usageLimit !== undefined
        ? { usageLimit: payload.usageLimit }
        : {}),
      ...(payload.perCustomerLimit !== undefined
        ? { perCustomerLimit: payload.perCustomerLimit }
        : {}),
      ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
      updatedAt: new Date(),
    })
    .where(eq(coupons.id, couponId))
    .returning();
  if (!updated) throw new Error("Coupon update returned no row.");
  return updated;
}
