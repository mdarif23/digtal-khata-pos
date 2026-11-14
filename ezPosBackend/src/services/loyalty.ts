import { and, asc, desc, eq, gt, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import {
  customerLoyaltyState,
  loyaltyEarnRules,
  loyaltyLedger,
  loyaltyPointsBatches,
  loyaltyPrograms,
  loyaltyTiers,
} from "../db/schema/loyalty.js";
import { sales } from "../db/schema/sales.js";
import { recordAuditInTx } from "./audit.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/handleError.js";
import { roundMoney } from "../utils/roundMoney.js";
import type { DbTransaction } from "../modules/purchases/purchase.types.js";

/**
 * Loyalty engine (Phase 2A — master prompt Feature 5).
 *
 * The ± ledger remains the single source of truth (balance = SUM(points));
 * consumers lock the customer's ledger rows FOR UPDATE so concurrent
 * checkouts cannot overspend. On top of that ledger:
 *  - EARNING composes program rate × rule multiplier × tier multiplier on
 *    the ELIGIBLE base the caller computes (exclusions, minimum spend are
 *    caller inputs derived from the sale lines), plus a flat campaign bonus.
 *  - EXPIRY is modeled with redeemable batches: each earn writes a batch
 *    (expires_at per the program's fixed-expiry policy); redemption consumes
 *    batches FIFO by soonest expiry; a sweep zeroes expired batches and
 *    writes 'expiry' ledger rows. Restored (refund) points never expire.
 *  - TIERS are derived: customer_loyalty_state tracks qualifying spend and
 *    the tier is re-evaluated transactionally after each earning sale.
 *  - REDEMPTION respects the program's min/max caps.
 */

type Tx = DbTransaction;

export interface LoyaltyProgramConfig {
  earnRate: number;
  redeemValue: number;
  isActive: boolean;
  expiryMode: "none" | "fixed";
  expiryDays: number | null;
  minRedemptionPoints: number;
  maxRedemptionPointsPerSale: number | null;
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
      expiryMode: loyaltyPrograms.expiryMode,
      expiryDays: loyaltyPrograms.expiryDays,
      minRedemptionPoints: loyaltyPrograms.minRedemptionPoints,
      maxRedemptionPointsPerSale: loyaltyPrograms.maxRedemptionPointsPerSale,
    })
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.businessId, businessId))
    .limit(1);
  if (!program) return null;
  return {
    earnRate: Number(program.earnRate),
    redeemValue: Number(program.redeemValue),
    isActive: program.isActive,
    expiryMode: program.expiryMode === "fixed" ? "fixed" : "none",
    expiryDays: program.expiryDays ?? null,
    minRedemptionPoints: Number(program.minRedemptionPoints),
    maxRedemptionPointsPerSale:
      program.maxRedemptionPointsPerSale === null
        ? null
        : Number(program.maxRedemptionPointsPerSale),
  };
}

export interface LoyaltyProgramInput {
  earnRate: number;
  redeemValue: number;
  isActive: boolean;
  expiryMode?: "none" | "fixed" | undefined;
  expiryDays?: number | null | undefined;
  minRedemptionPoints?: number | undefined;
  maxRedemptionPointsPerSale?: number | null | undefined;
}

export async function upsertLoyaltyProgram(
  businessId: number,
  actorUserId: number | null,
  input: LoyaltyProgramInput,
): Promise<LoyaltyProgramConfig> {
  if (input.earnRate < 0 || input.redeemValue < 0) {
    throw new BadRequestError("Loyalty rates cannot be negative.");
  }
  const expiryMode = input.expiryMode ?? "none";
  if (expiryMode === "fixed" && (!input.expiryDays || input.expiryDays <= 0)) {
    throw new BadRequestError(
      "Fixed expiry requires a positive expiry period in days.",
    );
  }
  if (
    input.minRedemptionPoints !== undefined &&
    input.minRedemptionPoints < 0
  ) {
    throw new BadRequestError("Minimum redemption cannot be negative.");
  }
  if (
    input.maxRedemptionPointsPerSale !== undefined &&
    input.maxRedemptionPointsPerSale !== null &&
    input.maxRedemptionPointsPerSale <= 0
  ) {
    throw new BadRequestError(
      "Maximum redemption per sale must be positive (or null for no cap).",
    );
  }
  const [row] = await db
    .insert(loyaltyPrograms)
    .values({
      businessId,
      earnRate: input.earnRate,
      redeemValue: input.redeemValue,
      isActive: input.isActive,
      expiryMode,
      expiryDays: expiryMode === "fixed" ? (input.expiryDays ?? null) : null,
      ...(input.minRedemptionPoints !== undefined
        ? { minRedemptionPoints: input.minRedemptionPoints }
        : {}),
      ...(input.maxRedemptionPointsPerSale !== undefined
        ? { maxRedemptionPointsPerSale: input.maxRedemptionPointsPerSale }
        : {}),
    })
    .onConflictDoUpdate({
      target: loyaltyPrograms.businessId,
      set: {
        earnRate: input.earnRate,
        redeemValue: input.redeemValue,
        isActive: input.isActive,
        expiryMode,
        expiryDays: expiryMode === "fixed" ? (input.expiryDays ?? null) : null,
        ...(input.minRedemptionPoints !== undefined
          ? { minRedemptionPoints: input.minRedemptionPoints }
          : {}),
        ...(input.maxRedemptionPointsPerSale !== undefined
          ? { maxRedemptionPointsPerSale: input.maxRedemptionPointsPerSale }
          : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) {
    throw new Error("Loyalty program upsert returned no row.");
  }
  return {
    earnRate: Number(row.earnRate),
    redeemValue: Number(row.redeemValue),
    isActive: row.isActive,
    expiryMode: row.expiryMode === "fixed" ? "fixed" : "none",
    expiryDays: row.expiryDays ?? null,
    minRedemptionPoints: Number(row.minRedemptionPoints),
    maxRedemptionPointsPerSale:
      row.maxRedemptionPointsPerSale === null
        ? null
        : Number(row.maxRedemptionPointsPerSale),
  };
}

// ---------------------------------------------------------------------------
// Earning rules
// ---------------------------------------------------------------------------

export interface EarnRuleConfig {
  isActive: boolean;
  minTransactionAmount: number;
  excludedCategoryIds: number[];
  excludedProductIds: number[];
  bonusPoints: number;
  multiplier: number;
  startsAt: Date | null;
  endsAt: Date | null;
}

export async function getEarnRule(
  businessId: number,
): Promise<EarnRuleConfig> {
  const [row] = await db
    .select()
    .from(loyaltyEarnRules)
    .where(eq(loyaltyEarnRules.businessId, businessId))
    .limit(1);
  if (!row) {
    return {
      isActive: false,
      minTransactionAmount: 0,
      excludedCategoryIds: [],
      excludedProductIds: [],
      bonusPoints: 0,
      multiplier: 1,
      startsAt: null,
      endsAt: null,
    };
  }
  return {
    isActive: row.isActive,
    minTransactionAmount: Number(row.minTransactionAmount),
    excludedCategoryIds: row.excludedCategoryIds ?? [],
    excludedProductIds: row.excludedProductIds ?? [],
    bonusPoints: Number(row.bonusPoints),
    multiplier: Number(row.multiplier),
    startsAt: row.startsAt ?? null,
    endsAt: row.endsAt ?? null,
  };
}

export async function upsertEarnRule(
  businessId: number,
  input: EarnRuleConfig,
): Promise<EarnRuleConfig> {
  if (input.multiplier < 0 || input.bonusPoints < 0 || input.minTransactionAmount < 0) {
    throw new BadRequestError(
      "Multiplier, bonus and minimum spend cannot be negative.",
    );
  }
  if (input.startsAt && input.endsAt && input.startsAt > input.endsAt) {
    throw new BadRequestError("The campaign window ends before it starts.");
  }
  await db
    .insert(loyaltyEarnRules)
    .values({
      businessId,
      isActive: input.isActive,
      minTransactionAmount: input.minTransactionAmount,
      excludedCategoryIds: input.excludedCategoryIds,
      excludedProductIds: input.excludedProductIds,
      bonusPoints: input.bonusPoints,
      multiplier: input.multiplier,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    })
    .onConflictDoUpdate({
      target: loyaltyEarnRules.businessId,
      set: {
        isActive: input.isActive,
        minTransactionAmount: input.minTransactionAmount,
        excludedCategoryIds: input.excludedCategoryIds,
        excludedProductIds: input.excludedProductIds,
        bonusPoints: input.bonusPoints,
        multiplier: input.multiplier,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        updatedAt: new Date(),
      },
    });
  return input;
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export async function listTiers(businessId: number) {
  return db
    .select()
    .from(loyaltyTiers)
    .where(eq(loyaltyTiers.businessId, businessId))
    .orderBy(desc(loyaltyTiers.rank));
}

export interface TierInput {
  name: string;
  minSpend: number;
  qualificationMonths?: number | null;
  earnMultiplier: number;
  rank: number;
  isActive: boolean;
}

export async function createTier(
  businessId: number,
  input: TierInput,
) {
  if (input.minSpend < 0 || input.earnMultiplier < 0) {
    throw new BadRequestError("Threshold and multiplier cannot be negative.");
  }
  const [row] = await db
    .insert(loyaltyTiers)
    .values({
      businessId,
      name: input.name,
      minSpend: input.minSpend,
      qualificationMonths: input.qualificationMonths ?? null,
      earnMultiplier: input.earnMultiplier,
      rank: input.rank,
      isActive: input.isActive,
    })
    .returning();
  if (!row) throw new Error("Tier insert returned no row.");
  return row;
}

export async function updateTier(
  businessId: number,
  tierId: number,
  input: TierInput,
) {
  const [row] = await db
    .update(loyaltyTiers)
    .set({
      name: input.name,
      minSpend: input.minSpend,
      qualificationMonths: input.qualificationMonths ?? null,
      earnMultiplier: input.earnMultiplier,
      rank: input.rank,
      isActive: input.isActive,
      updatedAt: new Date(),
    })
    .where(
      and(eq(loyaltyTiers.id, tierId), eq(loyaltyTiers.businessId, businessId)),
    )
    .returning();
  if (!row) throw new NotFoundError("Tier not found.");
  return row;
}

export async function deleteTier(businessId: number, tierId: number) {
  const [row] = await db
    .delete(loyaltyTiers)
    .where(
      and(eq(loyaltyTiers.id, tierId), eq(loyaltyTiers.businessId, businessId)),
    )
    .returning({ id: loyaltyTiers.id });
  if (!row) throw new NotFoundError("Tier not found.");
  return row;
}

/**
 * Re-evaluates the customer's tier from qualifying spend. Windowed tiers
 * (qualification_months) measure spend within the trailing window; lifetime
 * tiers measure the state's lifetime_spend. The HIGHEST-ranked active tier
 * whose threshold is met wins. Safe to call for every sale — no tiers
 * configured is a no-op.
 */
export async function evaluateLoyaltyTierInTx(
  tx: Tx,
  businessId: number,
  customerId: number,
): Promise<{ previousTierId: number | null; newTierId: number | null } | null> {
  const [state] = await tx
    .select()
    .from(customerLoyaltyState)
    .where(
      and(
        eq(customerLoyaltyState.businessId, businessId),
        eq(customerLoyaltyState.customerId, customerId),
      ),
    )
    .for("update");
  if (!state) return null;

  const tiers = await tx
    .select()
    .from(loyaltyTiers)
    .where(
      and(
        eq(loyaltyTiers.businessId, businessId),
        eq(loyaltyTiers.isActive, true),
      ),
    )
    .orderBy(desc(loyaltyTiers.rank));
  if (tiers.length === 0) return null;

  let newTierId: number | null = null;
  for (const tier of tiers) {
    let qualifying: number;
    if (tier.qualificationMonths === null) {
      qualifying = Number(state.lifetimeSpend);
    } else {
      const windowStart = new Date();
      windowStart.setMonth(windowStart.getMonth() - tier.qualificationMonths);
      const [spent] = await tx
        .select({ total: sql<string>`COALESCE(SUM(${sales.finalTotal}), 0)` })
        .from(sales)
        .where(
          and(
            eq(sales.businessId, businessId),
            eq(sales.customerId, customerId),
            gte(sales.saleDate, windowStart),
          ),
        );
      qualifying = Number(spent?.total ?? 0);
    }
    if (qualifying >= Number(tier.minSpend)) {
      newTierId = tier.id;
      break;
    }
  }

  const previousTierId = state.tierId;
  if (previousTierId !== newTierId) {
    await tx
      .update(customerLoyaltyState)
      .set({ tierId: newTierId, updatedAt: new Date() })
      .where(
        and(
          eq(customerLoyaltyState.businessId, businessId),
          eq(customerLoyaltyState.customerId, customerId),
        ),
      );
    if (newTierId !== null) {
      await recordAuditInTx(tx, {
        businessId,
        actorUserId: null,
        action: "loyalty.tier_changed",
        entityType: "customer",
        entityId: customerId,
        metadata: { previousTierId, newTierId },
      });
    }
  }
  return { previousTierId, newTierId };
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

async function insertLedgerRow(
  tx: Tx,
  input: {
    businessId: number;
    customerId: number;
    points: number;
    sourceType: string;
    sourceId: number | null;
    entryType: string;
    expiresAt: Date | null;
    actorUserId: number | null;
    note: string;
  },
): Promise<void> {
  // Row-level lock + JS sum — FOR UPDATE cannot wrap an aggregate.
  const lockRows = await tx
    .select({ points: loyaltyLedger.points })
    .from(loyaltyLedger)
    .where(
      and(
        eq(loyaltyLedger.businessId, input.businessId),
        eq(loyaltyLedger.customerId, input.customerId),
      ),
    )
    .for("update");
  const balanceBefore = lockRows.reduce(
    (sum, row) => sum + Number(row.points),
    0,
  );
  await tx.insert(loyaltyLedger).values({
    businessId: input.businessId,
    customerId: input.customerId,
    points: roundMoney(input.points),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    entryType: input.entryType,
    balanceAfter: roundMoney(balanceBefore + input.points),
    expiresAt: input.expiresAt,
    actorUserId: input.actorUserId,
    note: input.note,
  });
}

async function upsertStateInTx(
  tx: Tx,
  input: {
    businessId: number;
    customerId: number;
    earnedDelta?: number;
    redeemedDelta?: number;
    spendDelta?: number;
  },
): Promise<void> {
  await tx
    .insert(customerLoyaltyState)
    .values({
      businessId: input.businessId,
      customerId: input.customerId,
      lifetimeEarned: roundMoney(input.earnedDelta ?? 0),
      lifetimeRedeemed: roundMoney(input.redeemedDelta ?? 0),
      lifetimeSpend: roundMoney(input.spendDelta ?? 0),
    })
    .onConflictDoUpdate({
      target: [customerLoyaltyState.businessId, customerLoyaltyState.customerId],
      set: {
        lifetimeEarned: sql`${customerLoyaltyState.lifetimeEarned} + ${roundMoney(input.earnedDelta ?? 0)}`,
        lifetimeRedeemed: sql`${customerLoyaltyState.lifetimeRedeemed} + ${roundMoney(input.redeemedDelta ?? 0)}`,
        lifetimeSpend: sql`${customerLoyaltyState.lifetimeSpend} + ${roundMoney(input.spendDelta ?? 0)}`,
        updatedAt: new Date(),
      },
    });
}

function batchExpiryFor(program: LoyaltyProgramConfig): Date | null {
  if (program.expiryMode !== "fixed" || !program.expiryDays) return null;
  return new Date(Date.now() + program.expiryDays * 86_400_000);
}

// ---------------------------------------------------------------------------
// Earn / redeem / reverse / restore / adjust
// ---------------------------------------------------------------------------

export interface EarnInput {
  businessId: number;
  customerId: number;
  /** Eligible spend AFTER exclusions/minimums — computed by the caller. */
  eligibleBase: number;
  sourceId: number;
  actorUserId?: number | null;
  /** Whether the eligible base met the rule's minimum (false → no earn). */
  meetsMinimum?: boolean;
}

/**
 * Earns points on the eligible base: rate × rule multiplier × tier
 * multiplier + bonus. Creates the expiry batch and the ledger row, updates
 * lifetime counters and re-evaluates the tier. No program → no-op.
 */
export async function earnLoyaltyPointsInTx(
  tx: Tx,
  input: EarnInput,
): Promise<{ points: number; bonus: number; tierMultiplier: number } | null> {
  const program = await getLoyaltyProgram(input.businessId);
  if (!program || !program.isActive || program.earnRate <= 0) return null;
  const base = roundMoney(input.eligibleBase);
  if (base <= 0) return null;

  const rule = await getEarnRule(input.businessId);
  const now = new Date();
  const ruleActive =
    rule.isActive &&
    (!rule.startsAt || rule.startsAt <= now) &&
    (!rule.endsAt || rule.endsAt >= now) &&
    (input.meetsMinimum ?? base >= rule.minTransactionAmount);
  const ruleMultiplier = ruleActive ? rule.multiplier : 1;

  // Tier multiplier: re-evaluate first so tier changes made between sales
  // (new tiers, edited thresholds) apply immediately at earn time.
  await evaluateLoyaltyTierInTx(tx, input.businessId, input.customerId);
  const [state] = await tx
    .select({ tierId: customerLoyaltyState.tierId })
    .from(customerLoyaltyState)
    .where(
      and(
        eq(customerLoyaltyState.businessId, input.businessId),
        eq(customerLoyaltyState.customerId, input.customerId),
      ),
    )
    .limit(1);
  let tierMultiplier = 1;
  if (state?.tierId) {
    const [tier] = await tx
      .select({ earnMultiplier: loyaltyTiers.earnMultiplier })
      .from(loyaltyTiers)
      .where(eq(loyaltyTiers.id, state.tierId))
      .limit(1);
    if (tier) tierMultiplier = Number(tier.earnMultiplier);
  }

  const basePoints = roundMoney(base * program.earnRate * ruleMultiplier * tierMultiplier);
  const bonus = ruleActive ? roundMoney(rule.bonusPoints) : 0;
  if (basePoints <= 0 && bonus <= 0) return null;

  const expiresAt = batchExpiryFor(program);
  const note = `Earned on sale #${input.sourceId}`;

  if (basePoints > 0) {
    const [ledgerRow] = await tx
      .insert(loyaltyLedger)
      .values({
        businessId: input.businessId,
        customerId: input.customerId,
        points: basePoints,
        sourceType: "sale_earn",
        sourceId: input.sourceId,
        entryType: "earned",
        expiresAt,
        actorUserId: input.actorUserId ?? null,
        note,
      })
      .returning({ id: loyaltyLedger.id });
    await tx.insert(loyaltyPointsBatches).values({
      businessId: input.businessId,
      customerId: input.customerId,
      pointsOriginal: basePoints,
      pointsRemaining: basePoints,
      expiresAt,
      sourceType: "sale_earn",
      ledgerId: ledgerRow?.id ?? null,
    });
  }
  if (bonus > 0) {
    // Bonus points follow the same expiry policy (documented behavior).
    const [bonusRow] = await tx
      .insert(loyaltyLedger)
      .values({
        businessId: input.businessId,
        customerId: input.customerId,
        points: bonus,
        sourceType: "sale_earn",
        sourceId: input.sourceId,
        entryType: "bonus",
        expiresAt,
        actorUserId: input.actorUserId ?? null,
        note: `Campaign bonus on sale #${input.sourceId}`,
      })
      .returning({ id: loyaltyLedger.id });
    await tx.insert(loyaltyPointsBatches).values({
      businessId: input.businessId,
      customerId: input.customerId,
      pointsOriginal: bonus,
      pointsRemaining: bonus,
      expiresAt,
      sourceType: "sale_earn",
      ledgerId: bonusRow?.id ?? null,
    });
  }

  await upsertStateInTx(tx, {
    businessId: input.businessId,
    customerId: input.customerId,
    earnedDelta: basePoints + bonus,
    spendDelta: base,
  });
  await evaluateLoyaltyTierInTx(tx, input.businessId, input.customerId);
  return { points: basePoints, bonus, tierMultiplier };
}

/**
 * Redeems points as payment: locks the ledger, enforces the program's min/
 * max redemption caps, consumes expiry batches FIFO (soonest first, never-
 * expiring last), then writes the negative ledger row. Insufficient balance
 * aborts the whole sale (the caller's transaction).
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
  let pointsSpent = roundMoney(amount / program.redeemValue);
  if (pointsSpent <= 0) {
    throw new BadRequestError("Loyalty payment converts to zero points.");
  }
  if (
    program.maxRedemptionPointsPerSale !== null &&
    pointsSpent > program.maxRedemptionPointsPerSale
  ) {
    throw new ConflictError(
      `Redemption is capped at ${program.maxRedemptionPointsPerSale} points per sale (requested ${pointsSpent}).`,
    );
  }

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
  if (pointsSpent > balance) pointsSpent = balance;
  if (
    program.minRedemptionPoints > 0 &&
    pointsSpent < program.minRedemptionPoints
  ) {
    throw new ConflictError(
      `Redemption requires at least ${program.minRedemptionPoints} points (requested ${pointsSpent}).`,
    );
  }

  // Consume expiry batches FIFO — soonest expiry first, never-expiring last.
  let remaining = pointsSpent;
  const batches = await tx
    .select()
    .from(loyaltyPointsBatches)
    .where(
      and(
        eq(loyaltyPointsBatches.businessId, input.businessId),
        eq(loyaltyPointsBatches.customerId, input.customerId),
        gt(loyaltyPointsBatches.pointsRemaining, 0),
      ),
    )
    .orderBy(
      sql`${loyaltyPointsBatches.expiresAt} ASC NULLS LAST`,
      asc(loyaltyPointsBatches.earnedAt),
    )
    .for("update");
  for (const batch of batches) {
    if (remaining <= 0) break;
    const available = Number(batch.pointsRemaining);
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    await tx
      .update(loyaltyPointsBatches)
      .set({
        pointsRemaining: roundMoney(available - take),
        updatedAt: new Date(),
      })
      .where(eq(loyaltyPointsBatches.id, batch.id));
    remaining = roundMoney(remaining - take);
  }
  if (remaining > 0.01) {
    // Ledger/batch drift — fail safe rather than silently over-consume.
    throw new ConflictError(
      "Loyalty batches are inconsistent with the ledger; redeem a smaller amount.",
    );
  }

  await insertLedgerRow(tx, {
    businessId: input.businessId,
    customerId: input.customerId,
    points: -pointsSpent,
    sourceType: "redeem",
    sourceId: input.sourceId,
    entryType: "redeemed",
    expiresAt: null,
    actorUserId: input.actorUserId ?? null,
    note: `Redeemed on sale #${input.sourceId}`,
  });
  await upsertStateInTx(tx, {
    businessId: input.businessId,
    customerId: input.customerId,
    redeemedDelta: pointsSpent,
  });
  return { pointsSpent };
}

/**
 * Reverses the points earned on refunded value (refundTotal × earnRate).
 * The reversal CONSUMES the earn batches FIFO (same consumption as
 * redemption) — otherwise the daily expiry sweep would expire the SAME
 * points again after the refund (earn 100 → refund −100 with the batch
 * still at 100 → sweep −100 → balance −100). When the batches run short
 * the clawback still records in full — the customer owes the points back.
 * The balance may go negative when points were already spent; redemption
 * still cannot overdraw.
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

  // Consume expiry batches FIFO — soonest expiry first, never-expiring
  // last, mirroring redeemLoyaltyPointsInTx so ledger and batches stay
  // consistent and the sweep only ever expires points still held.
  let remaining = points;
  const batches = await tx
    .select()
    .from(loyaltyPointsBatches)
    .where(
      and(
        eq(loyaltyPointsBatches.businessId, input.businessId),
        eq(loyaltyPointsBatches.customerId, input.customerId),
        gt(loyaltyPointsBatches.pointsRemaining, 0),
      ),
    )
    .orderBy(
      sql`${loyaltyPointsBatches.expiresAt} ASC NULLS LAST`,
      asc(loyaltyPointsBatches.earnedAt),
    )
    .for("update");
  for (const batch of batches) {
    if (remaining <= 0) break;
    const available = Number(batch.pointsRemaining);
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    await tx
      .update(loyaltyPointsBatches)
      .set({
        pointsRemaining: roundMoney(available - take),
        updatedAt: new Date(),
      })
      .where(eq(loyaltyPointsBatches.id, batch.id));
    remaining = roundMoney(remaining - take);
  }
  // remaining > 0 here means the customer had already redeemed those
  // points — the ledger clawback below records the debt honestly; do NOT
  // fail the refund over the batch gap.

  await insertLedgerRow(tx, {
    businessId: input.businessId,
    customerId: input.customerId,
    points: -points,
    sourceType: "refund_reversal",
    sourceId: input.sourceId,
    entryType: "reversed",
    expiresAt: null,
    actorUserId: null,
    note: `Reversed for refund on sale #${input.sourceId}`,
  });
  return points;
}

/**
 * Restores the points REDEEMED on a refunded sale, proportionally to the
 * refunded value (master prompt F5-F: "Restore previously redeemed points
 * when appropriate"). Restored points never expire. Deduplication is the
 * caller's responsibility (refunds already are idempotent per refund id —
 * the sourceId here is the REFUND id, not the sale id, so each refund
 * restores exactly once).
 */
export async function restoreRedeemedPointsInTx(
  tx: Tx,
  input: {
    businessId: number;
    customerId: number;
    saleId: number;
    refundId: number;
    refundTotal: number;
    saleFinalTotal: number;
  },
): Promise<number> {
  const program = await getLoyaltyProgram(input.businessId);
  if (!program || !program.isActive || input.saleFinalTotal <= 0) return 0;
  const [redeemed] = await tx
    .select({
      points: sql<string>`COALESCE(SUM(${loyaltyLedger.points}), 0)`,
    })
    .from(loyaltyLedger)
    .where(
      and(
        eq(loyaltyLedger.businessId, input.businessId),
        eq(loyaltyLedger.customerId, input.customerId),
        eq(loyaltyLedger.sourceType, "redeem"),
        eq(loyaltyLedger.sourceId, input.saleId),
      ),
    );
  const redeemedPoints = Math.abs(Number(redeemed?.points ?? 0));
  if (redeemedPoints <= 0) return 0;
  const ratio = Math.min(1, input.refundTotal / input.saleFinalTotal);
  const restore = roundMoney(redeemedPoints * ratio);
  if (restore <= 0) return 0;

  await insertLedgerRow(tx, {
    businessId: input.businessId,
    customerId: input.customerId,
    points: restore,
    sourceType: "restore",
    sourceId: input.refundId,
    entryType: "reversed",
    expiresAt: null,
    actorUserId: null,
    note: `Restored redeemed points for refund on sale #${input.saleId}`,
  });
  // Restored points land in a never-expiring batch.
  await tx.insert(loyaltyPointsBatches).values({
    businessId: input.businessId,
    customerId: input.customerId,
    pointsOriginal: restore,
    pointsRemaining: restore,
    expiresAt: null,
    sourceType: "restore",
  });
  return restore;
}

/**
 * Manual balance correction (permission loyalty.adjust, reason mandatory).
 * Positive adjustments never expire. source_type='manual' finally becomes
 * reachable.
 */
export async function adjustLoyaltyPointsInTx(
  tx: Tx,
  input: {
    businessId: number;
    customerId: number;
    points: number; // signed
    reason: string;
    actorUserId: number;
  },
): Promise<number> {
  if (input.points === 0) {
    throw new BadRequestError("Adjustment cannot be zero.");
  }
  await insertLedgerRow(tx, {
    businessId: input.businessId,
    customerId: input.customerId,
    points: input.points,
    sourceType: "manual",
    sourceId: null,
    entryType: "adjusted",
    expiresAt: null,
    actorUserId: input.actorUserId,
    note: input.reason.slice(0, 500),
  });
  if (input.points > 0) {
    await tx.insert(loyaltyPointsBatches).values({
      businessId: input.businessId,
      customerId: input.customerId,
      pointsOriginal: input.points,
      pointsRemaining: input.points,
      expiresAt: null,
      sourceType: "manual",
    });
  }
  await upsertStateInTx(tx, {
    businessId: input.businessId,
    customerId: input.customerId,
    earnedDelta: input.points > 0 ? input.points : 0,
    redeemedDelta: input.points < 0 ? -input.points : 0,
  });
  return input.points;
}

/**
 * Records a customer sale's spend toward tier qualification — called for
 * EVERY completed customer sale (not only earning ones): tiers qualify on
 * total purchases. Re-evaluates the tier transactionally. Refunds do not
 * reduce lifetime spend in v1 (documented).
 */
export async function recordLoyaltySpendInTx(
  tx: Tx,
  input: { businessId: number; customerId: number; amount: number },
): Promise<void> {
  if (input.amount <= 0) return;
  await upsertStateInTx(tx, {
    businessId: input.businessId,
    customerId: input.customerId,
    spendDelta: roundMoney(input.amount),
  });
  await evaluateLoyaltyTierInTx(tx, input.businessId, input.customerId);
}

/**
 * Expiry sweep: zeroes every batch whose expires_at has passed, writes one
 * aggregated 'expiry' ledger row per customer, and notifies via return
 * value. Idempotent — a batch is zeroed exactly once.
 */
export async function runLoyaltyExpirySweep(
  businessId: number | null = null,
): Promise<{ customersAffected: number; pointsExpired: number }> {
  const conditions = [
    gt(loyaltyPointsBatches.pointsRemaining, 0),
    isNotNull(loyaltyPointsBatches.expiresAt),
    lt(loyaltyPointsBatches.expiresAt, new Date()),
  ];
  if (businessId !== null) {
    conditions.push(eq(loyaltyPointsBatches.businessId, businessId));
  }
  const expired = await db
    .select()
    .from(loyaltyPointsBatches)
    .where(and(...conditions))
    .for("update", { skipLocked: true });
  if (expired.length === 0) {
    return { customersAffected: 0, pointsExpired: 0 };
  }

  let pointsExpired = 0;
  const byCustomer = new Map<string, number>();
  for (const batch of expired) {
    const remaining = Number(batch.pointsRemaining);
    if (remaining <= 0) continue;
    pointsExpired += remaining;
    const key = `${batch.businessId}:${batch.customerId}`;
    byCustomer.set(key, (byCustomer.get(key) ?? 0) + remaining);
  }

  await db.transaction(async (tx) => {
    for (const batch of expired) {
      await tx
        .update(loyaltyPointsBatches)
        .set({ pointsRemaining: 0, updatedAt: new Date() })
        .where(
          and(
            eq(loyaltyPointsBatches.id, batch.id),
            gt(loyaltyPointsBatches.pointsRemaining, 0),
          ),
        );
    }
    for (const [key, points] of byCustomer) {
      const [businessIdStr, customerIdStr] = key.split(":");
      await insertLedgerRow(tx, {
        businessId: Number(businessIdStr),
        customerId: Number(customerIdStr),
        points: -points,
        sourceType: "expiry",
        sourceId: null,
        entryType: "expired",
        expiresAt: null,
        actorUserId: null,
        note: "Points expired",
      });
    }
  });
  return { customersAffected: byCustomer.size, pointsExpired: roundMoney(pointsExpired) };
}

/**
 * Eligible earn base from the sale's persisted lines: the sum of line
 * totals whose product/category is not excluded by the earning rule.
 * The caller still applies the paid-vs-due semantics (dues never earn).
 */
export async function computeEligibleEarnBaseInTx(
  tx: Tx,
  input: {
    businessId: number;
    saleId: number;
    excludedProductIds: number[];
    excludedCategoryIds: number[];
  },
): Promise<number> {
  const { saleItems } = await import("../db/schema/saleItems.js");
  const { productVariants } = await import("../db/schema/productVariants.js");
  const { products } = await import("../db/schema/products.js");
  const conditions = [
    eq(saleItems.saleId, input.saleId),
    eq(saleItems.businessId, input.businessId),
  ];
  if (input.excludedProductIds.length > 0) {
    conditions.push(
      sql`(${productVariants.productId} NOT IN (${sql.join(
        input.excludedProductIds.map((id) => sql`${id}`),
        sql`, `,
      )}))`,
    );
  }
  if (input.excludedCategoryIds.length > 0) {
    conditions.push(
      sql`(${products.categoryId} IS NULL OR ${products.categoryId} NOT IN (${sql.join(
        input.excludedCategoryIds.map((id) => sql`${id}`),
        sql`, `,
      )}))`,
    );
  }
  const [row] = await tx
    .select({
      total: sql<string>`COALESCE(SUM(${saleItems.lineTotal}), 0)`,
    })
    .from(saleItems)
    .innerJoin(productVariants, eq(productVariants.id, saleItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(...conditions));
  return roundMoney(Number(row?.total ?? 0));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

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

export interface LoyaltyOverview {
  balance: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  expiringSoon: number;
  tier: { id: number; name: string; earnMultiplier: number } | null;
}

/** Customer-facing loyalty page data (master prompt F5-G). */
export async function getLoyaltyOverview(
  businessId: number,
  customerId: number,
): Promise<LoyaltyOverview> {
  const [balance, stateRows, expiring] = await Promise.all([
    getLoyaltyBalance(businessId, customerId),
    db
      .select({
        lifetimeEarned: customerLoyaltyState.lifetimeEarned,
        lifetimeRedeemed: customerLoyaltyState.lifetimeRedeemed,
        tierId: customerLoyaltyState.tierId,
      })
      .from(customerLoyaltyState)
      .where(
        and(
          eq(customerLoyaltyState.businessId, businessId),
          eq(customerLoyaltyState.customerId, customerId),
        ),
      )
      .limit(1),
    db
      .select({
        total: sql<string>`COALESCE(SUM(${loyaltyPointsBatches.pointsRemaining}), 0)`,
      })
      .from(loyaltyPointsBatches)
      .where(
        and(
          eq(loyaltyPointsBatches.businessId, businessId),
          eq(loyaltyPointsBatches.customerId, customerId),
          gt(loyaltyPointsBatches.pointsRemaining, 0),
          isNotNull(loyaltyPointsBatches.expiresAt),
          lt(
            loyaltyPointsBatches.expiresAt,
            new Date(Date.now() + 30 * 86_400_000),
          ),
        ),
      ),
  ]);
  const state = stateRows[0];
  let tier: LoyaltyOverview["tier"] = null;
  if (state?.tierId) {
    const [tierRow] = await db
      .select({
        id: loyaltyTiers.id,
        name: loyaltyTiers.name,
        earnMultiplier: loyaltyTiers.earnMultiplier,
      })
      .from(loyaltyTiers)
      .where(eq(loyaltyTiers.id, state.tierId))
      .limit(1);
    if (tierRow) {
      tier = {
        id: tierRow.id,
        name: tierRow.name,
        earnMultiplier: Number(tierRow.earnMultiplier),
      };
    }
  }
  return {
    balance,
    lifetimeEarned: Number(state?.lifetimeEarned ?? 0),
    lifetimeRedeemed: Number(state?.lifetimeRedeemed ?? 0),
    expiringSoon: Number(expiring[0]?.total ?? 0),
    tier,
  };
}
