import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "../../db/schema/index.js";
import { posSettings } from "../../db/schema/posSettings.js";
import { offlineAllocations, syncConflicts } from "../../db/schema/offline.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { customers } from "../../db/schema/customers.js";
import { sales } from "../../db/schema/sales.js";
import {
  registerSessions,
  registerTransactions,
  registers,
} from "../../db/schema/registers.js";
import { posTerminals } from "../../db/schema/posTerminals.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/handleError.js";
import { recordAudit } from "../../services/audit.js";
import {
  createSalePayloadSchema,
  type CreateSalePayload,
} from "../sales/schemas/sales.schema.js";
import * as salesService from "../sales/sales.service.js";
import * as cashRegistersService from "../cashRegisters/cashRegisters.service.js";
import { roundMoney } from "../../utils/roundMoney.js";

/**
 * Offline terminal support (Phase 3). A BOUND TERMINAL (requireTerminalContext)
 * with a live user session may:
 *  - ask for its offline grant: policies + this terminal's stock allocations;
 *  - refresh allocations for the variants it intends to sell offline;
 *  - sync offline ops (sale / customer / drawer / return) — idempotent by
 *    client-generated keys, with unsafe-to-auto-apply outcomes recorded as
 *    sync_conflicts for manager review instead of silent drops or overwrites.
 *
 * Inventory allocation model: an allowance is a SERVER-side ledger row
 * (offline_allocations). Two disconnected terminals can never draw on the
 * same units: each sees only stock minus every OTHER terminal's active
 * allowance. Serial-tracked products are always blocked offline.
 */

export interface OfflinePolicies {
  offlineAllocationTtlHours: number;
  offlineRefundCap: number | null;
}

export async function getPolicies(businessId: number): Promise<OfflinePolicies> {
  const [settings] = await db
    .select({
      offlineAllocationTtlHours: posSettings.offlineAllocationTtlHours,
      offlineRefundCap: posSettings.offlineRefundCap,
    })
    .from(posSettings)
    .where(eq(posSettings.businessId, businessId));
  return {
    offlineAllocationTtlHours: settings?.offlineAllocationTtlHours ?? 24,
    offlineRefundCap:
      settings?.offlineRefundCap === null || settings?.offlineRefundCap === undefined
        ? null
        : Number(settings.offlineRefundCap),
  };
}

export interface AllocationView {
  variantId: number;
  allocatedQty: number;
  consumedQty: number;
  remainingQty: number;
  policy: "allocated" | "blocked" | "open";
  expiresAt: string;
}

async function activeAllocations(
  businessId: number,
  terminalId: number,
): Promise<AllocationView[]> {
  // Expire stale rows first so the views never show dead allowances.
  await pool.query(
    `UPDATE offline_allocations SET status = 'expired', updated_at = now()
     WHERE terminal_id = $1 AND status = 'active' AND expires_at < now()`,
    [terminalId],
  );
  const rows = await db
    .select({
      variantId: offlineAllocations.variantId,
      allocatedQty: offlineAllocations.allocatedQty,
      consumedQty: offlineAllocations.consumedQty,
      policy: products.offlinePolicy,
      expiresAt: offlineAllocations.expiresAt,
    })
    .from(offlineAllocations)
    .innerJoin(
      productVariants,
      eq(productVariants.id, offlineAllocations.variantId),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(offlineAllocations.businessId, businessId),
        eq(offlineAllocations.terminalId, terminalId),
        eq(offlineAllocations.status, "active"),
      ),
    );
  return rows.map((row) => ({
    variantId: row.variantId,
    allocatedQty: row.allocatedQty,
    consumedQty: row.consumedQty,
    remainingQty: Math.max(0, row.allocatedQty - row.consumedQty),
    policy: row.policy as AllocationView["policy"],
    expiresAt: row.expiresAt.toISOString(),
  }));
}

export async function getOfflineSession(
  businessId: number,
  terminalId: number,
) {
  const [policies, allocations] = await Promise.all([
    getPolicies(businessId),
    activeAllocations(businessId, terminalId),
  ]);
  return { policies, allocations, serverTime: new Date().toISOString() };
}

/**
 * (Re)grants allowances for the requested variants. allowance =
 * stock − reserved − Σ(other terminals' active allowances), floored at 0 —
 * two disconnected terminals can therefore never draw on the same units.
 * Serial-tracked and policy='blocked' variants receive NO allocation.
 */
export async function grantAllocations(
  businessId: number,
  locationId: number,
  terminalId: number,
  variantIds: number[],
): Promise<AllocationView[]> {
  if (variantIds.length === 0) return activeAllocations(businessId, terminalId);
  const uniqueIds = [...new Set(variantIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (uniqueIds.length === 0) return activeAllocations(businessId, terminalId);

  const policies = await getPolicies(businessId);
  const ttlMs = Math.max(1, policies.offlineAllocationTtlHours) * 3600_000;
  const expiresAt = new Date(Date.now() + ttlMs);

  await pool.query(
    `UPDATE offline_allocations SET status = 'expired', updated_at = now()
     WHERE terminal_id = $1 AND status = 'active' AND expires_at < now()`,
    [terminalId],
  );

  const rows = await db
    .select({
      variantId: productVariants.id,
      trackingType: products.trackingType,
      policy: products.offlinePolicy,
      quantity: inventoryStock.quantity,
      reservedQuantity: inventoryStock.reservedQuantity,
      othersAllowance: sql<number>`COALESCE((
        SELECT SUM(oa.allocated_qty) FROM offline_allocations oa
        WHERE oa.business_id = ${businessId}
          AND oa.variant_id = ${productVariants.id}
          AND oa.status = 'active'
          AND oa.terminal_id <> ${terminalId}
      ), 0)`,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(
      inventoryStock,
      and(
        eq(inventoryStock.variantId, productVariants.id),
        eq(inventoryStock.businessId, businessId),
        eq(inventoryStock.locationId, locationId),
      ),
    )
    .where(
      and(
        eq(productVariants.businessId, businessId),
        inArray(productVariants.id, uniqueIds),
      ),
    );

  for (const row of rows) {
    const eligible = row.trackingType !== "serial" && row.policy !== "blocked";
    const allowance = eligible
      ? Math.max(
          0,
          Math.floor(Number(row.quantity ?? 0) - Number(row.reservedQuantity ?? 0) - Number(row.othersAllowance ?? 0)),
        )
      : 0;
    if (!eligible && allowance === 0) {
      // Blocked variants: no active row at all (fresh grant case) — skip
      // insert; an existing active row (policy changed) is expired below.
      await pool.query(
        `UPDATE offline_allocations SET status = 'expired', updated_at = now()
         WHERE terminal_id = $1 AND variant_id = $2 AND status = 'active'`,
        [terminalId, row.variantId],
      );
      continue;
    }
    await pool.query(
      `INSERT INTO offline_allocations
         (business_id, location_id, terminal_id, variant_id, allocated_qty, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)
       ON CONFLICT (terminal_id, variant_id) WHERE status = 'active'
       DO UPDATE SET allocated_qty = EXCLUDED.allocated_qty,
                     location_id = EXCLUDED.location_id,
                     expires_at = EXCLUDED.expires_at,
                     updated_at = now()`,
      [businessId, locationId, terminalId, row.variantId, allowance, expiresAt],
    );
  }

  recordAudit({
    businessId,
    actorUserId: null,
    action: "offline.allocations_granted",
    entityType: "pos_terminal",
    entityId: terminalId,
    metadata: { variantCount: uniqueIds.length, ttlHours: policies.offlineAllocationTtlHours },
  });
  return activeAllocations(businessId, terminalId);
}

// ---------------------------------------------------------------------------
// Op application
// ---------------------------------------------------------------------------

export interface OfflineOp {
  opId: string;
  type: "sale.create" | "customer.create" | "drawer.open" | "drawer.movement" | "drawer.close" | "return.create";
  recordedAt?: string;
  payload: unknown;
}

export interface OfflineOpResult {
  opId: string;
  status: "applied" | "duplicate" | "failed";
  saleId?: number;
  customerId?: number;
  sessionId?: number;
  conflictId?: number;
  error?: string;
}

interface OfflineContext {
  businessId: number;
  locationId: number;
  terminalId: number;
  terminalName: string;
  userId: number;
  /** True when the syncing user holds the wildcard (owner) permission. */
  callerIsOwner: boolean;
}

export async function applyOfflineOps(
  ctx: OfflineContext,
  ops: OfflineOp[],
): Promise<OfflineOpResult[]> {
  const results: OfflineOpResult[] = [];
  for (const op of ops) {
    try {
      switch (op.type) {
        case "sale.create":
          results.push(await applySaleOp(ctx, op));
          break;
        case "customer.create":
          results.push(await applyCustomerOp(ctx, op));
          break;
        case "drawer.open":
          results.push(await applyDrawerOpenOp(ctx, op));
          break;
        case "drawer.movement":
          results.push(await applyDrawerMovementOp(ctx, op));
          break;
        case "drawer.close":
          results.push(await applyDrawerCloseOp(ctx, op));
          break;
        case "return.create":
          results.push(await applyReturnOp(ctx, op));
          break;
        default:
          results.push({
            opId: op.opId,
            status: "failed",
            error: `Unknown op type: ${String((op as { type?: string }).type)}`,
          });
      }
    } catch (err) {
      results.push({
        opId: op.opId,
        status: "failed",
        error: err instanceof Error ? err.message : "Op application failed.",
      });
    }
  }
  return results;
}

async function createConflict(
  ctx: OfflineContext,
  opId: string,
  opType: string,
  reason: string,
  message: string,
  payload: unknown,
): Promise<number> {
  const [row] = await db
    .insert(syncConflicts)
    .values({
      businessId: ctx.businessId,
      terminalId: ctx.terminalId,
      opId,
      opType,
      reason,
      message,
      payload: (payload ?? {}) as Record<string, unknown>,
    })
    .returning({ id: syncConflicts.id });
  return row!.id;
}

/** Per-variant offline eligibility for a sale's lines. */
async function lineEligibility(
  businessId: number,
  variantIds: number[],
): Promise<Map<number, { policy: string; trackingType: string }>> {
  const rows = await db
    .select({
      variantId: productVariants.id,
      policy: products.offlinePolicy,
      trackingType: products.trackingType,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(eq(productVariants.businessId, businessId), inArray(productVariants.id, variantIds)),
    );
  return new Map(
    rows.map((r) => [
      r.variantId,
      { policy: r.policy, trackingType: r.trackingType ?? "none" },
    ]),
  );
}

async function applySaleOp(ctx: OfflineContext, op: OfflineOp): Promise<OfflineOpResult> {
  const payload = op.payload as { sale?: CreateSalePayload };
  if (!payload?.sale) throw new BadRequestError("sale.create requires a sale payload.");
  const parsed = createSalePayloadSchema.safeParse(payload.sale);
  if (!parsed.success) {
    throw new BadRequestError(`Invalid sale payload: ${JSON.stringify(parsed.error.flatten())}`);
  }
  const sale = parsed.data;

  const eligibility = await lineEligibility(
    ctx.businessId,
    sale.items.map((item) => item.variantId),
  );
  for (const item of sale.items) {
    const line = eligibility.get(item.variantId);
    if (!line) throw new NotFoundError(`Variant ${item.variantId} not found.`);
    if (line.trackingType === "serial") {
      // Hard rule: the same serial must never sell on two terminals.
      throw new ConflictError(
        `Serial-tracked variant ${item.variantId} cannot be sold offline.`,
      );
    }
    if (line.policy === "blocked") {
      throw new ConflictError(
        `Variant ${item.variantId} is blocked from offline selling.`,
      );
    }
  }

  // The sale physically happened — it is never dropped at sync time.
  // Oversell surfaces as negative stock + a conflict record for review.
  const result = await salesService.createSale(
    ctx.businessId,
    ctx.locationId,
    ctx.userId,
    sale,
    ctx.terminalId,
    { channel: "offline", allowNegativeStock: true },
  );

  // Batch ledger gaps (batches could not cover the sale) — the sale stands,
  // the gap is flagged for manager review. Negative stock gets its own
  // conflict below.
  let shortfallConflictId: number | undefined;
  const shortfalls = (result as { batchShortfalls?: { variantId: number; qty: number }[] })
    .batchShortfalls;
  if (shortfalls && shortfalls.length > 0) {
    shortfallConflictId = await createConflict(
      ctx,
      op.opId,
      op.type,
      "batch_shortfall",
      `Batch ledger could not cover the offline sale: ${shortfalls
        .map((s) => `variant ${s.variantId} short ${s.qty}`)
        .join("; ")}.`,
      { shortfalls },
    );
  }

  // Negative stock (oversell while offline) — the stock truth changed
  // against the sale's assumption: flag for review.
  const soldVariants = new Map<number, number>();
  for (const item of sale.items) {
    soldVariants.set(item.variantId, (soldVariants.get(item.variantId) ?? 0) + item.quantity);
  }
  for (const [variantId, qty] of soldVariants) {
    const [stockRow] = await db
      .select({ quantity: inventoryStock.quantity })
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.variantId, variantId),
          eq(inventoryStock.businessId, ctx.businessId),
          eq(inventoryStock.locationId, ctx.locationId),
        ),
      );
    if (stockRow && Number(stockRow.quantity) < 0) {
      await createConflict(
        ctx,
        op.opId,
        op.type,
        "negative_stock_open_mode",
        `Offline sale left variant ${variantId} at ${stockRow.quantity} units at this location (sold ${qty}).`,
        { variantId, quantityAfter: Number(stockRow.quantity) },
      );
    }
  }

  // Consume allocations and flag overages.
  for (const item of sale.items) {
    const line = eligibility.get(item.variantId)!;
    if (line.policy !== "allocated") continue;
    const updated = await pool.query(
      `UPDATE offline_allocations
       SET consumed_qty = consumed_qty + $1, updated_at = now()
       WHERE terminal_id = $2 AND variant_id = $3 AND status = 'active'
       RETURNING allocated_qty, consumed_qty`,
      [item.quantity, ctx.terminalId, item.variantId],
    );
    const row = updated.rows[0];
    if (row && Number(row.consumed_qty) > Number(row.allocated_qty)) {
      const conflictId = await createConflict(
        ctx,
        op.opId,
        op.type,
        "allocation_exceeded",
        `Terminal sold ${row.consumed_qty} of variant ${item.variantId} offline against an allowance of ${row.allocated_qty}.`,
        { variantId: item.variantId, allocated: row.allocated_qty, consumed: row.consumed_qty },
      );
      return {
        opId: op.opId,
        status: "applied",
        saleId: result.sale.id,
        conflictId,
      };
    }
  }
  if (shortfallConflictId !== undefined) {
    return {
      opId: op.opId,
      status: "applied",
      saleId: result.sale.id,
      conflictId: shortfallConflictId,
    };
  }
  return { opId: op.opId, status: "applied", saleId: result.sale.id };
}

async function applyCustomerOp(ctx: OfflineContext, op: OfflineOp): Promise<OfflineOpResult> {
  const payload = op.payload as {
    clientUuid?: string;
    name?: string;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
  };
  if (!payload?.clientUuid || !payload?.name) {
    throw new BadRequestError("customer.create requires clientUuid and name.");
  }
  const [existing] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.businessId, ctx.businessId),
        eq(customers.clientUuid, payload.clientUuid),
      ),
    );
  if (existing) {
    return { opId: op.opId, status: "duplicate", customerId: existing.id };
  }
  const [created] = await db
    .insert(customers)
    .values({
      businessId: ctx.businessId,
      name: payload.name,
      phone: payload.phone ?? null,
      email: payload.email ?? null,
      address: payload.address ?? null,
      clientUuid: payload.clientUuid,
    })
    .returning({ id: customers.id });
  if (!created) throw new Error("Customer op insert returned no row.");
  return { opId: op.opId, status: "applied", customerId: created.id };
}

async function applyDrawerOpenOp(ctx: OfflineContext, op: OfflineOp): Promise<OfflineOpResult> {
  const payload = op.payload as {
    clientSessionId?: string;
    registerId?: number;
    openingCash?: number;
    openedAt?: string;
  };
  if (!payload?.clientSessionId || !Number.isInteger(payload.registerId)) {
    throw new BadRequestError("drawer.open requires clientSessionId and registerId.");
  }
  const [existing] = await db
    .select({ id: registerSessions.id })
    .from(registerSessions)
    .where(eq(registerSessions.clientSessionId, payload.clientSessionId));
  if (existing) {
    return { opId: op.opId, status: "duplicate", sessionId: existing.id };
  }
  const [register] = await db
    .select({ id: registers.id })
    .from(registers)
    .where(
      and(
        eq(registers.id, payload.registerId!),
        eq(registers.businessId, ctx.businessId),
        eq(registers.locationId, ctx.locationId),
      ),
    );
  if (!register) throw new NotFoundError("Register not found at this location.");
  const openingCash = roundMoney(Number(payload.openingCash ?? 0));
  if (openingCash < 0) throw new BadRequestError("Opening cash cannot be negative.");
  try {
    const [session] = await db
      .insert(registerSessions)
      .values({
        businessId: ctx.businessId,
        registerId: payload.registerId!,
        userId: ctx.userId,
        terminalId: ctx.terminalId,
        openingCash,
        clientSessionId: payload.clientSessionId,
        ...(payload.openedAt ? { openedAt: new Date(payload.openedAt) } : {}),
      })
      .returning({ id: registerSessions.id });
    if (!session) throw new Error("Session insert returned no row.");
    return { opId: op.opId, status: "applied", sessionId: session.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23P01") {
      // exclude constraint: register or user already has an open session.
      throw new ConflictError(
        "This register (or user) already has an open session on the server.",
      );
    }
    throw err;
  }
}

async function findSessionByClientId(
  businessId: number,
  clientSessionId: string,
): Promise<{ id: number; userId: number; status: string } | null> {
  const [session] = await db
    .select({
      id: registerSessions.id,
      userId: registerSessions.userId,
      status: registerSessions.status,
    })
    .from(registerSessions)
    .where(
      and(
        eq(registerSessions.businessId, businessId),
        eq(registerSessions.clientSessionId, clientSessionId),
      ),
    );
  return session ?? null;
}

async function applyDrawerMovementOp(ctx: OfflineContext, op: OfflineOp): Promise<OfflineOpResult> {
  const payload = op.payload as {
    clientSessionId?: string;
    clientOpId?: string;
    type?: string;
    amount?: number;
    note?: string | null;
  };
  if (!payload?.clientSessionId || !payload?.clientOpId || !payload?.type) {
    throw new BadRequestError("drawer.movement requires clientSessionId, clientOpId and type.");
  }
  const [existing] = await db
    .select({ id: registerTransactions.id })
    .from(registerTransactions)
    .where(eq(registerTransactions.clientOpId, payload.clientOpId));
  if (existing) {
    return { opId: op.opId, status: "duplicate" };
  }
  const session = await findSessionByClientId(ctx.businessId, payload.clientSessionId);
  if (!session) throw new NotFoundError("Drawer session not found (open it first).");
  if (session.status !== "open") {
    throw new ConflictError("This drawer session is already closed.");
  }
  const amount = roundMoney(Number(payload.amount ?? 0));
  if (!(amount > 0)) throw new BadRequestError("Amount must be greater than zero.");
  const MANUAL_TYPES = ["cash_in", "cash_out", "safe_deposit", "safe_withdrawal", "adjustment_in", "adjustment_out"] as const;
  if (!(MANUAL_TYPES as readonly string[]).includes(payload.type)) {
    throw new BadRequestError(`Unsupported offline movement type: ${payload.type}`);
  }
  await db.insert(registerTransactions).values({
    businessId: ctx.businessId,
    sessionId: session.id,
    userId: ctx.userId,
    type: payload.type as (typeof MANUAL_TYPES)[number],
    amount,
    referenceType: "manual",
    clientOpId: payload.clientOpId,
    note: payload.note ?? null,
  });
  return { opId: op.opId, status: "applied", sessionId: session.id };
}

async function applyDrawerCloseOp(ctx: OfflineContext, op: OfflineOp): Promise<OfflineOpResult> {
  const payload = op.payload as {
    clientSessionId?: string;
    countedCash?: number;
    notes?: string | null;
  };
  if (!payload?.clientSessionId || payload?.countedCash === undefined) {
    throw new BadRequestError("drawer.close requires clientSessionId and countedCash.");
  }
  const session = await findSessionByClientId(ctx.businessId, payload.clientSessionId);
  if (!session) throw new NotFoundError("Drawer session not found.");
  if (session.status !== "open") {
    return { opId: op.opId, status: "duplicate", sessionId: session.id };
  }
  // The acting user closes; sessions of OTHER cashiers require the owner —
  // assertSessionMayBeOperated inside closeSession enforces the same rule
  // online and off.
  await cashRegistersService.closeSession(
    ctx.businessId,
    ctx.userId,
    ctx.callerIsOwner,
    session.id,
    roundMoney(Number(payload.countedCash)),
    payload.notes ?? undefined,
  );
  return { opId: op.opId, status: "applied", sessionId: session.id };
}

async function applyReturnOp(ctx: OfflineContext, op: OfflineOp): Promise<OfflineOpResult> {
  const payload = op.payload as {
    originalSaleId?: number;
    reason?: string;
    disposition?: string;
    notes?: string;
  };
  if (!Number.isInteger(payload?.originalSaleId)) {
    throw new BadRequestError("return.create requires originalSaleId.");
  }
  const policies = await getPolicies(ctx.businessId);
  if (policies.offlineRefundCap === null) {
    throw new ConflictError("Offline refunds are not enabled for this business.");
  }
  const [sale] = await db
    .select({ id: sales.id, finalTotal: sales.finalTotal })
    .from(sales)
    .where(
      and(eq(sales.id, payload.originalSaleId!), eq(sales.businessId, ctx.businessId)),
    );
  if (!sale) throw new NotFoundError("Original sale not found.");
  // The remaining refundable value is enforced server-side by applySaleRefund
  // (FOR UPDATE + already-refunded ceiling). The OFFLINE CAP uses the sale's
  // full value as the upper bound: above-cap offline refunds park as a
  // conflict for manager review — never silently applied, never lost.
  const saleValue = Number(sale.finalTotal ?? 0);
  if (saleValue > policies.offlineRefundCap) {
    const conflictId = await createConflict(
      ctx,
      op.opId,
      op.type,
      "refund_cap_exceeded",
      `Offline refund of ${saleValue.toFixed(2)} exceeds the business cap of ${policies.offlineRefundCap.toFixed(2)}.`,
      { originalSaleId: payload.originalSaleId },
    );
    return { opId: op.opId, status: "failed", conflictId, error: "Offline refund cap exceeded." };
  }
  try {
    await salesService.createMultipleRefunds(
      ctx.businessId,
      payload.originalSaleId!,
      {
        reason: (payload.reason as never) ?? "other",
        notes: payload.notes ?? "Created offline",
        disposition: (payload.disposition as never) ?? "restock",
        refundMethod: "cash",
      },
      ctx.userId,
    );
    return { opId: op.opId, status: "applied" };
  } catch (err) {
    if (err instanceof ConflictError) {
      // Already refunded / nothing left — the replayed op's work is done.
      return { opId: op.opId, status: "duplicate" };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Conflicts review
// ---------------------------------------------------------------------------

export async function listConflicts(businessId: number, limit = 100) {
  return db
    .select()
    .from(syncConflicts)
    .where(eq(syncConflicts.businessId, businessId))
    .orderBy(desc(syncConflicts.id))
    .limit(Math.min(Math.max(limit, 1), 200));
}

export async function resolveConflict(
  businessId: number,
  conflictId: number,
  action: "discard" | "apply",
  resolvedBy: number,
) {
  const [existing] = await db
    .select({ id: syncConflicts.id, status: syncConflicts.status })
    .from(syncConflicts)
    .where(and(eq(syncConflicts.id, conflictId), eq(syncConflicts.businessId, businessId)));
  if (!existing) throw new NotFoundError("Conflict not found.");
  if (existing.status !== "open") {
    throw new ConflictError("This conflict is already resolved.");
  }
  const [updated] = await db
    .update(syncConflicts)
    .set({
      status: action === "discard" ? "resolved_discarded" : "resolved_applied",
      resolvedBy,
      resolvedAt: new Date(),
    })
    .where(eq(syncConflicts.id, conflictId))
    .returning({ id: syncConflicts.id });
  if (!updated) throw new Error("Conflict resolution returned no row.");
  return { id: conflictId, status: action === "discard" ? "resolved_discarded" : "resolved_applied" };
}

/** Count of open conflicts — feeds the sync status card. */
export async function openConflictCount(businessId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(syncConflicts)
    .where(
      and(eq(syncConflicts.businessId, businessId), eq(syncConflicts.status, "open")),
    );
  return row?.count ?? 0;
}