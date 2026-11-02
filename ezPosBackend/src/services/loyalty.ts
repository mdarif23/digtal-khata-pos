import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { loyaltyLedger, loyaltyPrograms } from "../db/schema/loyalty.js";
import { BadRequestError, ConflictError } from "../utils/handleError.js";
import { roundMoney } from "../utils/roundMoney.js";
import type { DbTransaction } from "../modules/purchases/purchase.types.js";

/**
 * Loyalty points (Module 7): earn on paid sales, redeem at checkout, and
 * reverse on refunds — one ledger, balance = SUM(points). The program is
 * opt-in per business: with no active program, nothing earns and points
 * cannot be used as payment (no silent defaults).
 */

type Tx = DbTransaction;

export interface LoyaltyProgramConfig {
  earnRate: number;
  redeemValue: number;
  isActive: boolean;
}

/** The business's program, or null when none exists (loyalty disabled). */
export async function getLoyaltyProgram(
  businessId: number,
): Promise<LoyaltyProgramConfig | null> {
  const [program] = await db
    .select({
      earnRate: loyaltyPrograms.earnRate,
      redeemValue: loyaltyPrograms.redeemValue,
      isActive: loyaltyPrograms.isActive,
    })
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.businessId, businessId))
    .limit(1);
  if (!program) return null;
  return {
    earnRate: Number(program.earnRate),
    redeemValue: Number(program.redeemValue),
    isActive: program.isActive,
  };
}

export async function upsertLoyaltyProgram(
  businessId: number,
  actorUserId: number | null,
  input: { earnRate: number; redeemValue: number; isActive: boolean },
): Promise<LoyaltyProgramConfig> {
  if (input.earnRate < 0 || input.redeemValue < 0) {
    throw new BadRequestError("Loyalty rates cannot be negative.");
  }
  await db
    .insert(loyaltyPrograms)
    .values({
      businessId,
      earnRate: input.earnRate,
      redeemValue: input.redeemValue,
      isActive: input.isActive,
    })
    .onConflictDoUpdate({
      target: loyaltyPrograms.businessId,
      set: {
        earnRate: input.earnRate,
        redeemValue: input.redeemValue,
        isActive: input.isActive,
        updatedAt: new Date(),
      },
    });
  return {
    earnRate: input.earnRate,
    redeemValue: input.redeemValue,
    isActive: input.isActive,
  };
}

export async function getLoyaltyBalance(
  businessId: number,
  customerId: number,
): Promise<number> {
  const rows = await db
    .select({ points: loyaltyLedger.points })
    .from(loyaltyLedger)
    .where(
      and(
        eq(loyaltyLedger.businessId, businessId),
        eq(loyaltyLedger.customerId, customerId),
      ),
    );
  return roundMoney(rows.reduce((sum, row) => sum + Number(row.points), 0));
}

export async function getLoyaltyHistory(
  businessId: number,
  customerId: number,
  limit = 50,
) {
  return db
    .select()
    .from(loyaltyLedger)
    .where(
      and(
        eq(loyaltyLedger.businessId, businessId),
        eq(loyaltyLedger.customerId, customerId),
      ),
    )
    .orderBy(desc(loyaltyLedger.id))
    .limit(limit);
}

/** Earns points for the amount actually paid. No program → no-op. */
export async function earnLoyaltyPointsInTx(
  tx: Tx,
  input: {
    businessId: number;
    customerId: number;
    paidAmount: number;
    sourceId: number;
    actorUserId?: number | null;
  },
): Promise<number> {
  const program = await getLoyaltyProgram(input.businessId);
  if (!program || !program.isActive || program.earnRate <= 0) return 0;
  const points = roundMoney(input.paidAmount * program.earnRate);
  if (points <= 0) return 0;
  await tx.insert(loyaltyLedger).values({
    businessId: input.businessId,
    customerId: input.customerId,
    points,
    sourceType: "sale_earn",
    sourceId: input.sourceId,
    actorUserId: input.actorUserId ?? null,
    note: `Earned on sale #${input.sourceId}`,
  });
  return points;
}

/**
 * Redeems points as payment: locks the customer's ledger, verifies the
 * balance, converts currency → points at the program's redeem value.
 * The negative ledger row lands inside the sale transaction, so an
 * insufficient balance aborts the whole sale.
 */
export async function redeemLoyaltyPointsInTx(
  tx: Tx,
  input: {
    businessId: number;
    customerId: number;
    amount: number; // currency value being paid with points
    sourceId: number;
    actorUserId?: number | null;
  },
): Promise<{ pointsSpent: number }> {
  const program = await getLoyaltyProgram(input.businessId);
  if (!program || !program.isActive || program.redeemValue <= 0) {
    throw new BadRequestError(
      "Loyalty redemption is not available for this business.",
    );
  }
  const amount = roundMoney(input.amount);
  if (amount <= 0) {
    throw new BadRequestError("Loyalty payment amount must be positive.");
  }
  const pointsSpent = roundMoney(amount / program.redeemValue);

  // Lock the ledger rows — concurrent checkouts serialize here.
  const rows = await tx
    .select({ points: loyaltyLedger.points })
    .from(loyaltyLedger)
    .where(
      and(
        eq(loyaltyLedger.businessId, input.businessId),
        eq(loyaltyLedger.customerId, input.customerId),
      ),
    )
    .for("update");
  const balance = roundMoney(
    rows.reduce((sum, row) => sum + Number(row.points), 0),
  );
  if (balance < pointsSpent - 0.01) {
    throw new ConflictError(
      `Insufficient loyalty points: balance ${balance}, needed ${pointsSpent}.`,
    );
  }
  await tx.insert(loyaltyLedger).values({
    businessId: input.businessId,
    customerId: input.customerId,
    points: -pointsSpent,
    sourceType: "redeem",
    sourceId: input.sourceId,
    actorUserId: input.actorUserId ?? null,
    note: `Redeemed on sale #${input.sourceId}`,
  });
  return { pointsSpent };
}

/**
 * Reverses the points earned on refunded value (refundTotal × earnRate).
 * The balance may go negative when points were already spent — the clawback
 * is recorded honestly; redemption still cannot overdraw.
 */
export async function reverseLoyaltyPointsInTx(
  tx: Tx,
  input: {
    businessId: number;
    customerId: number;
    refundedAmount: number;
    sourceId: number;
  },
): Promise<number> {
  const program = await getLoyaltyProgram(input.businessId);
  if (!program || !program.isActive || program.earnRate <= 0) return 0;
  const points = roundMoney(input.refundedAmount * program.earnRate);
  if (points <= 0) return 0;
  await tx.insert(loyaltyLedger).values({
    businessId: input.businessId,
    customerId: input.customerId,
    points: -points,
    sourceType: "refund_reversal",
    sourceId: input.sourceId,
    note: `Reversed for refund on sale #${input.sourceId}`,
  });
  return points;
}
