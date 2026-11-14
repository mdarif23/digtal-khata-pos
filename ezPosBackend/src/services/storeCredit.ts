import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { customerCredits } from "../db/schema/customerCredits.js";
import { ConflictError } from "../utils/handleError.js";
import { roundMoney } from "../utils/roundMoney.js";
import { notifyInTx } from "./notifications.js";
import type { DbTransaction } from "../modules/purchases/purchase.types.js";

/**
 * Store credit / customer account ledger (Module 5; P3 Phase 1 F4 adds
 * expiry). Positive rows grant credit, negative rows consume it; the balance
 * is computed by a deterministic REPLAY of the ledger (not a raw SUM) so a
 * grant's expiry can be honored without a parallel balance column:
 *
 *  - Rows replay in (created_at, id) order.
 *  - A positive row opens a grant carrying its expires_at (NULL = never).
 *  - A negative row (sale_payment consumption OR a prior 'expiry' sweep row)
 *    consumes FIFO against open grants ordered by expiry first (NULLS LAST),
 *    then creation — the same oldest-expiry-first order loyalty redemption
 *    uses.
 *  - Available = remaining value on grants not yet expired; expired-but-
 *    unconsumed = remaining on expired grants.
 *
 * Invariants (property-tested):
 *  1. Conservation — Σ(all rows) === Σ remaining across all grants at every
 *     step; the replay only ALLOCATES value, never creates or destroys it.
 *  2. Idempotent expiry — the sweep turns expired-unconsumed value into one
 *     explicit negative 'expiry' row; because the replay counts that row as
 *     consumption, re-running the sweep finds nothing left to expire.
 *  3. Serialized spend — consumers lock the customer's rows FOR UPDATE
 *     inside their transaction, so two concurrent checkouts (or a sweep racing
 *     a checkout) cannot overspend or double-expire the same credit.
 */

type Tx = DbTransaction | typeof db;

interface CreditLedgerRow {
  id: number;
  amount: number;
  expiresAt: Date | null;
  createdAt: Date;
}

interface ReplayResult {
  /** Spendable value: remaining on grants that have not expired. */
  available: number;
  /** Remaining value on grants whose expires_at has passed. */
  expiredUnconsumed: number;
  /** Σ of every row ever written — conservation anchor. */
  totalWritten: number;
}

export function replayCreditLedger(rows: CreditLedgerRow[]): ReplayResult {
  const sorted = [...rows].sort((a, b) => {
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    return t !== 0 ? t : a.id - b.id;
  });
  // Open grants in arrival order; consumption walks them expiry-first.
  const grants: { remaining: number; expiresAt: Date | null }[] = [];
  for (const row of sorted) {
    const amount = Number(row.amount);
    if (amount > 0) {
      grants.push({ remaining: amount, expiresAt: row.expiresAt });
      continue;
    }
    let consume = -amount;
    const order = grants
      .map((g, idx) => ({ g, idx }))
      .sort((a, b) => {
        const ae = a.g.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
        const be = b.g.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
        return ae !== be ? ae - be : a.idx - b.idx;
      });
    for (const { g } of order) {
      if (consume <= 0) break;
      if (g.remaining <= 0) continue;
      const take = Math.min(g.remaining, consume);
      g.remaining = roundMoney(g.remaining - take);
      consume = roundMoney(consume - take);
    }
  }
  const now = Date.now();
  let available = 0;
  let expiredUnconsumed = 0;
  for (const g of grants) {
    if (g.remaining <= 0) continue;
    if (g.expiresAt !== null && g.expiresAt.getTime() <= now) {
      expiredUnconsumed = roundMoney(expiredUnconsumed + g.remaining);
    } else {
      available = roundMoney(available + g.remaining);
    }
  }
  return {
    available,
    expiredUnconsumed,
    totalWritten: roundMoney(
      sorted.reduce((sum, row) => sum + Number(row.amount), 0),
    ),
  };
}

async function loadCreditRows(
  executor: Tx,
  businessId: number,
  customerId: number,
): Promise<CreditLedgerRow[]> {
  return executor
    .select({
      id: customerCredits.id,
      amount: customerCredits.amount,
      expiresAt: customerCredits.expiresAt,
      createdAt: customerCredits.createdAt,
    })
    .from(customerCredits)
    .where(
      and(
        eq(customerCredits.businessId, businessId),
        eq(customerCredits.customerId, customerId),
      ),
    );
}

/**
 * Spendable store-credit balance (expires-at aware). Every read path —
 * customer card, payment-modal pre-check, credit summary — goes through the
 * same replay, so no display can disagree with what a sale can spend.
 */
export async function getStoreCreditBalance(
  businessId: number,
  customerId: number,
): Promise<number> {
  const rows = await loadCreditRows(db, businessId, customerId);
  return replayCreditLedger(rows).available;
}

export async function grantStoreCreditInTx(
  tx: DbTransaction,
  input: {
    businessId: number;
    customerId: number;
    amount: number;
    sourceType: "refund" | "sale_payment" | "manual";
    sourceId?: number | null;
    actorUserId?: number | null;
    note?: string | null;
    /** P3 Phase 1 (F4): when this grant expires; NULL = never. */
    expiresAt?: Date | null;
  },
): Promise<void> {
  const amount = roundMoney(input.amount);
  if (amount <= 0) {
    throw new ConflictError("Store credit grants must be positive.");
  }
  await tx.insert(customerCredits).values({
    businessId: input.businessId,
    customerId: input.customerId,
    amount,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    actorUserId: input.actorUserId ?? null,
    note: input.note ?? null,
    expiresAt: input.expiresAt ?? null,
  });
}

/**
 * Locks the customer's ledger, replays it (expired value is NOT spendable —
 * even before the sweep has converted it into an 'expiry' row), verifies the
 * available balance, and records the spend. An overdraft aborts the whole
 * sale.
 */
export async function consumeStoreCreditInTx(
  tx: DbTransaction,
  input: {
    businessId: number;
    customerId: number;
    amount: number;
    sourceType: "refund" | "sale_payment" | "manual";
    sourceId?: number | null;
    actorUserId?: number | null;
    note?: string | null;
  },
): Promise<void> {
  const amount = roundMoney(input.amount);
  if (amount <= 0) {
    throw new ConflictError("Store credit spends must be positive.");
  }
  // Lock every ledger row for this customer so the replayed balance cannot
  // change between the check and the consumption insert (also serializes
  // against the expiry sweep). Lock FIRST, then read the locked state.
  const locked = await tx
    .select({ id: customerCredits.id })
    .from(customerCredits)
    .where(
      and(
        eq(customerCredits.businessId, input.businessId),
        eq(customerCredits.customerId, input.customerId),
      ),
    )
    .for("update");
  const rows =
    locked.length > 0
      ? await loadCreditRows(tx, input.businessId, input.customerId)
      : [];
  const { available } = replayCreditLedger(rows);
  if (available < amount - 0.01) {
    throw new ConflictError(
      `Insufficient store credit: available ৳${available.toFixed(2)}, tried to use ৳${amount.toFixed(2)}.`,
    );
  }
  await tx.insert(customerCredits).values({
    businessId: input.businessId,
    customerId: input.customerId,
    amount: -amount,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    actorUserId: input.actorUserId ?? null,
    note: input.note ?? null,
  });
}

/**
 * P3 Phase 1 (F4): converts expired-but-unconsumed grant value into one
 * explicit negative 'expiry' ledger row per customer. Idempotent by
 * construction — the replay counts prior 'expiry' rows as consumption, so a
 * repeated sweep finds nothing left to expire. Concurrent sweeps (or a sweep
 * racing a checkout) serialize on the customer's row locks; candidates are
 * processed in deterministic (businessId, customerId) order so two sweeps
 * take locks in the same sequence (no deadlock window).
 */
export async function runStoreCreditExpirySweep(
  businessId: number | null = null,
): Promise<{ customersAffected: number; storeCreditExpired: number }> {
  const expiredCandidateFilter =
    businessId === null
      ? sql`${customerCredits.amount} > 0 AND ${customerCredits.expiresAt} IS NOT NULL AND ${customerCredits.expiresAt} < now()`
      : sql`${customerCredits.amount} > 0 AND ${customerCredits.expiresAt} IS NOT NULL AND ${customerCredits.expiresAt} < now() AND ${customerCredits.businessId} = ${businessId}`;
  const candidates = await db
    .select({
      businessId: customerCredits.businessId,
      customerId: customerCredits.customerId,
    })
    .from(customerCredits)
    .where(expiredCandidateFilter)
    .groupBy(customerCredits.businessId, customerCredits.customerId)
    .orderBy(customerCredits.businessId, customerCredits.customerId);

  let customersAffected = 0;
  let storeCreditExpired = 0;

  for (const candidate of candidates) {
    const expiredNow = await db.transaction(async (tx) => {
      // Lock first, THEN load rows inside the lock — the replay must see the
      // locked state, not a pre-lock snapshot.
      const locked = await tx
        .select({ id: customerCredits.id })
        .from(customerCredits)
        .where(
          and(
            eq(customerCredits.businessId, candidate.businessId),
            eq(customerCredits.customerId, candidate.customerId),
          ),
        )
        .for("update");
      if (locked.length === 0) return 0;
      const rows = await loadCreditRows(
        tx,
        candidate.businessId,
        candidate.customerId,
      );
      const { expiredUnconsumed } = replayCreditLedger(rows);
      if (expiredUnconsumed <= 0) return 0;
      await tx.insert(customerCredits).values({
        businessId: candidate.businessId,
        customerId: candidate.customerId,
        amount: -expiredUnconsumed,
        sourceType: "expiry",
        sourceId: null,
        note: "Store credit expired (sweep)",
      });
      await notifyInTx(tx, {
        businessId: candidate.businessId,
        kind: "store_credit_expired",
        severity: "info",
        title: "Store credit expired",
        body: `৳${expiredUnconsumed.toFixed(2)} of store credit expired and is no longer redeemable.`,
        payload: { customerId: candidate.customerId, amount: expiredUnconsumed },
        dedupeKey: `store_credit_expiry:${candidate.customerId}`,
      });
      return expiredUnconsumed;
    });
    if (expiredNow > 0) {
      customersAffected += 1;
      storeCreditExpired = roundMoney(storeCreditExpired + expiredNow);
    }
  }

  return { customersAffected, storeCreditExpired };
}
