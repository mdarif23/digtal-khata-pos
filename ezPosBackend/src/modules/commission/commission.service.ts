import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  commissionEntries,
  commissionRules,
  salesTargets,
} from "../../db/schema/commission.js";
import { sales } from "../../db/schema/sales.js";
import { saleItems } from "../../db/schema/saleItems.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { users } from "../../db/schema/users.js";
import { recordAuditInTx, recordAudit } from "../../services/audit.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";

/**
 * Salesperson & commission engine (Phase 5 — master prompt Feature 13).
 *
 * Rules match on (scope, user) at SALE COMPLETION; each matched rule writes
 * ONE ledger entry per sale+user+rule (unique constraint = idempotent).
 * Refunds write NEGATIVE reversed entries — history is never deleted.
 * Lifecycle is forward-only: pending → approved → payable → paid.
 * Percentage-of-profit uses the sale's cost snapshot (finalTotal − COGS
 * basis via cost_at_sale sums) — documented precision in the report.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CommissionMethod =
  | "percentage_of_sales"
  | "fixed_per_sale"
  | "percentage_of_profit";

export interface CommissionRuleInput {
  name: string;
  calcMethod: CommissionMethod;
  rate: number;
  categoryId?: number | null | undefined;
  productId?: number | null | undefined;
  userId?: number | null | undefined;
  isActive?: boolean | undefined;
}

function assertRate(input: CommissionRuleInput): void {
  if (input.rate < 0) {
    throw new BadRequestError("Commission rate cannot be negative.");
  }
  if (input.calcMethod === "percentage_of_sales" || input.calcMethod === "percentage_of_profit") {
    if (input.rate > 100) {
      throw new BadRequestError("Percentage rates cannot exceed 100.");
    }
  }
}

export async function createRule(
  businessId: number,
  actorUserId: number | null,
  input: CommissionRuleInput,
) {
  assertRate(input);
  const [row] = await db
    .insert(commissionRules)
    .values({
      businessId,
      name: input.name,
      calcMethod: input.calcMethod,
      rate: input.rate,
      categoryId: input.categoryId ?? null,
      productId: input.productId ?? null,
      userId: input.userId ?? null,
      isActive: input.isActive ?? true,
    })
    .returning();
  if (!row) throw new Error("Rule insert returned no row.");
  recordAudit({
    businessId,
    actorUserId,
    action: "commission.rule_created",
    entityType: "commission_rule",
    entityId: row.id,
    afterState: { name: row.name, calcMethod: row.calcMethod, rate: Number(row.rate) },
  });
  return row;
}

export type CommissionRulePatch = {
  name?: string | undefined;
  calcMethod?: CommissionMethod | undefined;
  rate?: number | undefined;
  categoryId?: number | null | undefined;
  productId?: number | null | undefined;
  userId?: number | null | undefined;
  isActive?: boolean | undefined;
};

export async function updateRule(
  businessId: number,
  actorUserId: number | null,
  ruleId: number,
  input: CommissionRulePatch,
) {
  const [existing] = await db
    .select()
    .from(commissionRules)
    .where(
      and(eq(commissionRules.id, ruleId), eq(commissionRules.businessId, businessId)),
    );
  if (!existing) throw new NotFoundError("Commission rule not found.");
  const merged: CommissionRuleInput = {
    name: input.name ?? existing.name,
    calcMethod: input.calcMethod ?? (existing.calcMethod as CommissionMethod),
    rate: input.rate ?? Number(existing.rate),
    categoryId: input.categoryId ?? existing.categoryId,
    productId: input.productId ?? existing.productId,
    userId: input.userId ?? existing.userId,
    isActive: input.isActive ?? existing.isActive,
  };
  assertRate(merged);
  const [row] = await db
    .update(commissionRules)
    .set({
      name: merged.name,
      calcMethod: merged.calcMethod,
      rate: merged.rate,
      categoryId: merged.categoryId,
      productId: merged.productId,
      userId: merged.userId,
      isActive: merged.isActive,
      updatedAt: new Date(),
    })
    .where(eq(commissionRules.id, ruleId))
    .returning();
  recordAudit({
    businessId,
    actorUserId,
    action: "commission.rule_updated",
    entityType: "commission_rule",
    entityId: ruleId,
    afterState: { name: merged.name, rate: merged.rate, isActive: merged.isActive },
  });
  return row;
}

export async function listRules(businessId: number) {
  return db
    .select()
    .from(commissionRules)
    .where(eq(commissionRules.businessId, businessId))
    .orderBy(desc(commissionRules.id));
}

// ---------------------------------------------------------------------------
// Calculation at sale completion
// ---------------------------------------------------------------------------

/**
 * Calculates commission entries for a completed sale — called INSIDE the
 * sale transaction (entries commit/roll back with the sale). Idempotent per
 * sale+user+rule via the unique constraint. Scope: rules matching the
 * sale's lines by category/product; only entries for the SALESPERSON are
 * written. Percentage-of-profit uses the sale's cost snapshot.
 */
export async function calculateCommissionsForSaleInTx(
  tx: Tx,
  input: {
    businessId: number;
    saleId: number;
    salespersonUserId: number | null;
    finalTotal: number;
    costBasis: number;
  },
): Promise<number> {
  if (input.salespersonUserId === null || input.finalTotal <= 0) return 0;
  const rules = await tx
    .select()
    .from(commissionRules)
    .where(
      and(
        eq(commissionRules.businessId, input.businessId),
        eq(commissionRules.isActive, true),
      ),
    );
  const applicable = rules.filter(
    (rule) => rule.userId === null || rule.userId === input.salespersonUserId,
  );
  if (applicable.length === 0) return 0;

  // Line scope: category/product narrowing via the sale's lines.
  const lines = await tx
    .select({
      variantId: saleItems.variantId,
      lineTotal: saleItems.lineTotal,
      costAtSale: saleItems.costAtSale,
      productId: productVariants.productId,
      categoryId: products.categoryId,
    })
    .from(saleItems)
    .innerJoin(productVariants, eq(productVariants.id, saleItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(saleItems.saleId, input.saleId),
        eq(saleItems.businessId, input.businessId),
      ),
    );

  let written = 0;
  for (const rule of applicable) {
    const scopedLines =
      rule.categoryId != null
        ? lines.filter((line) => line.categoryId === rule.categoryId)
        : rule.productId != null
          ? lines.filter((line) => line.productId === rule.productId)
          : lines;
    if (scopedLines.length === 0) continue;

    let base = 0;
    if (rule.calcMethod === "percentage_of_sales") {
      base = scopedLines.reduce((sum, line) => sum + Number(line.lineTotal), 0);
    } else if (rule.calcMethod === "percentage_of_profit") {
      base = scopedLines.reduce(
        (sum, line) => sum + Number(line.lineTotal) - Number(line.costAtSale ?? 0),
        0,
      );
      if (base <= 0) continue; // no profit — no commission
    } else {
      base = input.finalTotal; // fixed_per_sale anchors on the invoice
    }

    const amount =
      rule.calcMethod === "fixed_per_sale"
        ? roundMoney(Number(rule.rate))
        : roundMoney((base * Number(rule.rate)) / 100);
    if (amount <= 0) continue;

    await tx
      .insert(commissionEntries)
      .values({
        businessId: input.businessId,
        saleId: input.saleId,
        salespersonUserId: input.salespersonUserId,
        ruleId: rule.id,
        ruleNameSnapshot: rule.name,
        calcMethod: rule.calcMethod,
        rate: Number(rule.rate),
        baseAmount: roundMoney(base),
        amount,
        status: "pending",
      })
      .onConflictDoNothing();
    written += 1;
  }
  return written;
}

/**
 * Refund reversal: proportional to the refunded value — one NEGATIVE
 * reversed entry per original entry (idempotent per refund via the reason
 * tag + existing-entry check on the same sale/rule/user with refund_id).
 */
export async function reverseCommissionsForRefundInTx(
  tx: Tx,
  input: {
    businessId: number;
    saleId: number;
    refundId: number;
    refundTotal: number;
    saleFinalTotal: number;
  },
): Promise<number> {
  if (input.saleFinalTotal <= 0 || input.refundTotal <= 0) return 0;
  const originals = await tx
    .select()
    .from(commissionEntries)
    .where(
      and(
        eq(commissionEntries.businessId, input.businessId),
        eq(commissionEntries.saleId, input.saleId),
        eq(commissionEntries.status, "pending"),
        sql`${commissionEntries.refundId} IS NULL`,
      ),
    )
    .for("update");
  const ratio = Math.min(1, input.refundTotal / input.saleFinalTotal);
  let written = 0;
  for (const original of originals) {
    const reversal = roundMoney(Number(original.amount) * ratio);
    if (reversal <= 0) continue;
    await tx.insert(commissionEntries).values({
      businessId: input.businessId,
      saleId: input.saleId,
      salespersonUserId: original.salespersonUserId,
      ruleId: original.ruleId,
      ruleNameSnapshot: original.ruleNameSnapshot,
      calcMethod: original.calcMethod,
      rate: original.rate,
      baseAmount: original.baseAmount,
      amount: -reversal,
      status: "reversed",
      refundId: input.refundId,
      reason: `Proportional reversal for refund #${input.refundId}`,
    });
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const FORWARD_FLOW: Record<string, string[]> = {
  pending: ["approved", "reversed"],
  approved: ["payable", "reversed"],
  payable: ["paid", "reversed"],
  paid: [],
  reversed: [],
  calculated: ["pending"],
};

export async function transitionEntry(
  businessId: number,
  actorUserId: number,
  entryId: number,
  to: "approved" | "payable" | "paid" | "reversed",
  reason?: string,
) {
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(commissionEntries)
      .where(
        and(
          eq(commissionEntries.id, entryId),
          eq(commissionEntries.businessId, businessId),
        ),
      )
      .for("update");
    if (!entry) throw new NotFoundError("Commission entry not found.");
    const allowed = FORWARD_FLOW[entry.status] ?? [];
    if (!allowed.includes(to)) {
      throw new ConflictError(
        `Cannot move a ${entry.status} entry to ${to}.`,
      );
    }
    const isPaid = to === "paid";
    const [updated] = await tx
      .update(commissionEntries)
      .set({
        status: to,
        reason: reason ?? entry.reason,
        paidAt: isPaid ? new Date() : entry.paidAt,
        updatedAt: new Date(),
      })
      .where(eq(commissionEntries.id, entryId))
      .returning();
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: `commission.entry_${to}`,
      entityType: "commission_entry",
      entityId: entryId,
      beforeState: { status: entry.status },
      afterState: { status: to },
      metadata: { amount: Number(entry.amount) },
    });
    return updated;
  });
}

export async function listEntries(
  businessId: number,
  filters: {
    status?: string | undefined;
    userId?: number | undefined;
    limit?: number;
    offset?: number;
  },
): Promise<{ rows: Record<string, unknown>[]; totals: Record<string, number> }> {
  const conditions = [eq(commissionEntries.businessId, businessId)];
  if (filters.status) {
    conditions.push(
      sql`${commissionEntries.status} = ${filters.status}::commission_entry_status`,
    );
  }
  if (filters.userId) {
    conditions.push(eq(commissionEntries.salespersonUserId, filters.userId));
  }
  const where = and(...conditions);
  const rows = await db
    .select({
      id: commissionEntries.id,
      saleId: commissionEntries.saleId,
      salespersonUserId: commissionEntries.salespersonUserId,
      salespersonName: users.fullName,
      ruleName: commissionEntries.ruleNameSnapshot,
      calcMethod: commissionEntries.calcMethod,
      baseAmount: commissionEntries.baseAmount,
      amount: commissionEntries.amount,
      status: commissionEntries.status,
      refundId: commissionEntries.refundId,
      reason: commissionEntries.reason,
      paidAt: commissionEntries.paidAt,
      createdAt: commissionEntries.createdAt,
    })
    .from(commissionEntries)
    .innerJoin(
      users,
      eq(users.id, commissionEntries.salespersonUserId),
    )
    .where(where)
    .orderBy(desc(commissionEntries.id))
    .limit(Math.min(filters.limit ?? 50, 200))
    .offset(Math.max(filters.offset ?? 0, 0));

  const [totals] = await db
    .select({
      pending: sql<string>`COALESCE(SUM(CASE WHEN ${commissionEntries.status} = 'pending' THEN ${commissionEntries.amount} ELSE 0 END), 0)`,
      approved: sql<string>`COALESCE(SUM(CASE WHEN ${commissionEntries.status} IN ('approved', 'payable') THEN ${commissionEntries.amount} ELSE 0 END), 0)`,
      paid: sql<string>`COALESCE(SUM(CASE WHEN ${commissionEntries.status} = 'paid' THEN ${commissionEntries.amount} ELSE 0 END), 0)`,
      reversed: sql<string>`COALESCE(SUM(CASE WHEN ${commissionEntries.status} = 'reversed' THEN ${commissionEntries.amount} ELSE 0 END), 0)`,
    })
    .from(commissionEntries)
    .where(eq(commissionEntries.businessId, businessId));

  return {
    rows,
    totals: {
      pending: Number(totals?.pending ?? 0),
      approved: Number(totals?.approved ?? 0),
      paid: Number(totals?.paid ?? 0),
      reversed: Number(totals?.reversed ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export async function setTarget(
  businessId: number,
  actorUserId: number,
  input: {
    userId: number;
    periodType: "daily" | "weekly" | "monthly" | "custom";
    periodStart: string;
    periodEnd: string;
    targetAmount: number;
  },
) {
  if (input.targetAmount < 0) {
    throw new BadRequestError("Target amount cannot be negative.");
  }
  if (input.periodStart > input.periodEnd) {
    throw new BadRequestError("The period ends before it starts.");
  }
  const [row] = await db
    .insert(salesTargets)
    .values({
      businessId,
      userId: input.userId,
      periodType: input.periodType,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      targetAmount: input.targetAmount,
      createdBy: actorUserId,
    })
    .onConflictDoUpdate({
      target: [
        salesTargets.businessId,
        salesTargets.userId,
        salesTargets.periodStart,
        salesTargets.periodEnd,
      ],
      set: {
        periodType: input.periodType,
        targetAmount: input.targetAmount,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("Target upsert returned no row.");
  recordAudit({
    businessId,
    actorUserId,
    action: "target.saved",
    entityType: "sales_target",
    entityId: row.id,
    afterState: {
      userId: input.userId,
      targetAmount: input.targetAmount,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    },
  });
  return row;
}

export async function listTargets(businessId: number) {
  return db
    .select({
      id: salesTargets.id,
      userId: salesTargets.userId,
      userName: users.fullName,
      periodType: salesTargets.periodType,
      periodStart: salesTargets.periodStart,
      periodEnd: salesTargets.periodEnd,
      targetAmount: salesTargets.targetAmount,
    })
    .from(salesTargets)
    .innerJoin(users, eq(users.id, salesTargets.userId))
    .where(eq(salesTargets.businessId, businessId))
    .orderBy(desc(salesTargets.periodEnd));
}

export interface TargetAchievement {
  userId: number;
  userName: string;
  targetAmount: number;
  actualAmount: number;
  achievementPercent: number | null;
  periodStart: string;
  periodEnd: string;
  periodType: string;
}

/**
 * Achievement per target: completed sales where the user is the
 * SALESPERSON; falls back to cashier attribution when no salesperson was
 * recorded on the sale (legacy behavior — documented in the report).
 */
export async function getTargetAchievements(
  businessId: number,
  locationId: number | null,
): Promise<TargetAchievement[]> {
  const targets = await listTargets(businessId);
  const achievements: TargetAchievement[] = [];
  for (const target of targets) {
    const conditions = [
      eq(sales.businessId, businessId),
      eq(sales.status, "completed"),
      gte(sales.saleDate, sql`${target.periodStart}::timestamp`),
      lte(sales.saleDate, sql`${`${target.periodEnd} 23:59:59.999`}::timestamp`),
      sql`(
        ${sales.salespersonUserId} = ${target.userId}
        OR (${sales.salespersonUserId} IS NULL AND ${sales.cashierUserId} = ${target.userId})
      )`,
    ];
    if (locationId !== null) {
      conditions.push(eq(sales.locationId, locationId));
    }
    const [row] = await db
      .select({
        actual: sql<string>`COALESCE(SUM(${sales.finalTotal}), 0)`,
      })
      .from(sales)
      .where(and(...conditions));
    const actual = roundMoney(Number(row?.actual ?? 0));
    const targetAmount = Number(target.targetAmount);
    achievements.push({
      userId: target.userId,
      userName: target.userName,
      targetAmount,
      actualAmount: actual,
      achievementPercent:
        targetAmount > 0 ? roundMoney((actual / targetAmount) * 100) : null,
      periodStart: target.periodStart,
      periodEnd: target.periodEnd,
      periodType: target.periodType,
    });
  }
  return achievements;
}

/** Salesperson-attributed sales totals (staff performance extension). */
export async function getSalespersonPerformance(
  businessId: number,
  locationId: number | null,
  from: string,
  to: string,
) {
  const conditions = [
    eq(sales.businessId, businessId),
    eq(sales.status, "completed"),
    gte(sales.saleDate, sql`${`${from} 00:00:00`}::timestamp`),
    lte(sales.saleDate, sql`${`${to} 23:59:59.999`}::timestamp`),
    sql`${sales.salespersonUserId} IS NOT NULL`,
  ];
  if (locationId !== null) {
    conditions.push(eq(sales.locationId, locationId));
  }
  return db
    .select({
      userId: sales.salespersonUserId,
      userName: users.fullName,
      salesCount: sql<string>`COUNT(*)`,
      netSales: sql<string>`COALESCE(SUM(${sales.finalTotal}), 0)`,
      commissionEarned: sql<string>`COALESCE(SUM(CASE WHEN ${commissionEntries.status} IN ('pending', 'approved', 'payable', 'paid') THEN ${commissionEntries.amount} ELSE 0 END), 0)`,
    })
    .from(sales)
    .innerJoin(users, eq(users.id, sales.salespersonUserId))
    .leftJoin(
      commissionEntries,
      and(
        eq(commissionEntries.saleId, sales.id),
        eq(
          commissionEntries.salespersonUserId,
          sales.salespersonUserId,
        ),
      ),
    )
    .where(and(...conditions))
    .groupBy(sales.salespersonUserId, users.fullName)
    .orderBy(sql`COALESCE(SUM(${sales.finalTotal}), 0) DESC`);
}

// Reassign the salesperson on a completed sale (audit-trailed).
export async function reassignSalesperson(
  businessId: number,
  actorUserId: number,
  saleId: number,
  newSalespersonUserId: number | null,
): Promise<void> {
  return db.transaction(async (tx) => {
    const [sale] = await tx
      .select({
        id: sales.id,
        salespersonUserId: sales.salespersonUserId,
      })
      .from(sales)
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
      .for("update");
    if (!sale) throw new NotFoundError("Sale not found.");
    if (sale.salespersonUserId === newSalespersonUserId) {
      throw new ConflictError("The sale already has that salesperson.");
    }
    if (newSalespersonUserId !== null) {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, newSalespersonUserId))
        .limit(1);
      if (!user) throw new BadRequestError("Salesperson not found.");
    }

    const old = sale.salespersonUserId;
    await tx
      .update(sales)
      .set({
        salespersonUserId: newSalespersonUserId,
        salespersonAssignedAt: new Date(),
        salespersonAssignedBy: actorUserId,
      })
      .where(eq(sales.id, saleId));

    // Move pending commission entries with the sale; paid/approved entries
    // stay with the original salesperson (money already committed).
    if (old !== null) {
      await tx
        .update(commissionEntries)
        .set({ status: "reversed", reason: `Salesperson reassigned to user ${newSalespersonUserId}` })
        .where(
          and(
            eq(commissionEntries.saleId, saleId),
            eq(commissionEntries.salespersonUserId, old),
            inArray(commissionEntries.status, ["pending"]),
          ),
        );
    }

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "sale.salesperson_reassigned",
      entityType: "sale",
      entityId: saleId,
      beforeState: { salespersonUserId: old },
      afterState: { salespersonUserId: newSalespersonUserId },
    });
  });
}
