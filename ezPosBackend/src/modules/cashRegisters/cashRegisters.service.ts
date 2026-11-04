import { and, asc, desc, eq, sql } from "drizzle-orm";
import { publishRealtime } from "../realtime/realtime.service.js";
import { notifyRegisterDiscrepancy } from "../../services/notifications.js";
import { db } from "../../db/schema/index.js";
import { registerSessions } from "../../db/schema/registers.js";
import { registerTransactions } from "../../db/schema/registers.js";
import { registers } from "../../db/schema/registers.js";
import { locations } from "../../db/schema/locations.js";
import { users } from "../../db/schema/users.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";

type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const CASH_MOVEMENT_DELTA = sql`CASE
  WHEN ${registerTransactions.type} IN ('cash_out', 'cash_refund', 'safe_deposit', 'adjustment_out')
    THEN -${registerTransactions.amount}
  ELSE ${registerTransactions.amount}
END`;

/** Manual (form-driven) movement types — direction carried by the type. */
export type ManualMovementType =
  | "cash_in"
  | "cash_out"
  | "safe_deposit"
  | "safe_withdrawal"
  | "adjustment_in"
  | "adjustment_out";

interface SessionSummary {
  id: number;
  registerId: number;
  registerName: string;
  locationId: number;
  locationName: string;
  userName: string;
  status: string;
  openingCash: number;
  expectedCash: number;
  countedCash: number | null;
  difference: number | null;
  notes: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
}

/** Expected cash = opening + sales + cash in + safe withdrawals + adjustments in − cash out − cash refunds − safe deposits − adjustments out. */
async function computeExpectedCash(
  tx: Tx,
  sessionId: number,
  openingCash: number,
): Promise<number> {
  const [row] = await tx
    .select({
      delta: sql<string>`COALESCE(SUM(${CASH_MOVEMENT_DELTA}), 0)`,
    })
    .from(registerTransactions)
    .where(eq(registerTransactions.sessionId, sessionId));
  return roundMoney(openingCash + Number(row?.delta ?? 0));
}

function toSummary(
  row: {
    id: number;
    registerId: number;
    registerName: string;
    locationId: number;
    locationName: string;
    userName: string;
    status: string;
    openingCash: number;
    expectedCash: number | null;
    countedCash: number | null;
    difference: number | null;
    notes: string | null;
    openedAt: Date | null;
    closedAt: Date | null;
  },
  expectedOverride?: number,
): SessionSummary {
  return {
    id: row.id,
    registerId: row.registerId,
    registerName: row.registerName,
    locationId: row.locationId,
    locationName: row.locationName,
    userName: row.userName,
    status: row.status,
    openingCash: Number(row.openingCash),
    expectedCash: expectedOverride ?? Number(row.expectedCash ?? 0),
    countedCash: row.countedCash === null ? null : Number(row.countedCash),
    difference: row.difference === null ? null : Number(row.difference),
    notes: row.notes,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
  };
}

const sessionSelect = {
  id: registerSessions.id,
  registerId: registerSessions.registerId,
  registerName: registers.name,
  locationId: locations.id,
  locationName: locations.name,
  userName: users.fullName,
  status: registerSessions.status,
  openingCash: registerSessions.openingCash,
  expectedCash: registerSessions.expectedCash,
  countedCash: registerSessions.countedCash,
  difference: registerSessions.difference,
  notes: registerSessions.notes,
  openedAt: registerSessions.openedAt,
  closedAt: registerSessions.closedAt,
};

function sessionBaseQuery() {
  // Composite FKs already guarantee register/location/session rows share
  // the same business, so the joins need no extra business predicate.
  return db
    .select(sessionSelect)
    .from(registerSessions)
    .innerJoin(registers, eq(registers.id, registerSessions.registerId))
    .innerJoin(locations, eq(locations.id, registers.locationId))
    .innerJoin(users, eq(users.id, registerSessions.userId));
}

/** Registers at the caller's (server-verified) location, with open sessions. */
export async function listRegisters(
  businessId: number,
  locationId: number,
): Promise<
  {
    id: number;
    name: string;
    status: string;
    openSession: {
      id: number;
      userName: string;
      openingCash: number;
      openedAt: Date | null;
    } | null;
  }[]
> {
  const rows = await db
    .select({
      id: registers.id,
      name: registers.name,
      status: registers.status,
      sessionId: registerSessions.id,
      sessionUser: users.fullName,
      sessionOpening: registerSessions.openingCash,
      sessionOpenedAt: registerSessions.openedAt,
    })
    .from(registers)
    .leftJoin(
      registerSessions,
      and(
        eq(registerSessions.registerId, registers.id),
        eq(registerSessions.status, "open"),
      ),
    )
    .leftJoin(users, eq(users.id, registerSessions.userId))
    .where(
      and(
        eq(registers.businessId, businessId),
        eq(registers.locationId, locationId),
      ),
    )
    .orderBy(asc(registers.id));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    openSession:
      row.sessionId !== null
        ? {
            id: row.sessionId,
            userName: row.sessionUser ?? "",
            openingCash: Number(row.sessionOpening ?? 0),
            openedAt: row.sessionOpenedAt,
          }
        : null,
  }));
}

export async function createRegister(
  businessId: number,
  locationId: number,
  name: string,
): Promise<{ id: number; name: string; status: string }> {
  const [existing] = await db
    .select({ id: registers.id })
    .from(registers)
    .where(
      and(
        eq(registers.businessId, businessId),
        eq(registers.locationId, locationId),
        eq(registers.name, name),
      ),
    );
  if (existing) {
    throw new ConflictError("A register with this name already exists here.");
  }
  const [created] = await db
    .insert(registers)
    .values({ businessId, locationId, name })
    .returning({ id: registers.id, name: registers.name, status: registers.status });
  if (!created) {
    throw new Error("Register insert returned no row.");
  }
  return created;
}

export async function updateRegister(
  businessId: number,
  registerId: number,
  input: { name?: string; status?: "active" | "inactive" },
): Promise<{ id: number; name: string; status: string }> {
  const [existing] = await db
    .select()
    .from(registers)
    .where(
      and(eq(registers.id, registerId), eq(registers.businessId, businessId)),
    );
  if (!existing) {
    throw new NotFoundError("Register not found.");
  }
  if (input.status === "inactive" && existing.status === "active") {
    const [open] = await db
      .select({ id: registerSessions.id })
      .from(registerSessions)
      .where(
        and(
          eq(registerSessions.registerId, registerId),
          eq(registerSessions.status, "open"),
        ),
      );
    if (open) {
      throw new ConflictError(
        "Close the open session before deactivating this register.",
      );
    }
  }
  const [updated] = await db
    .update(registers)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(registers.id, registerId))
    .returning({
      id: registers.id,
      name: registers.name,
      status: registers.status,
    });
  if (!updated) {
    throw new Error("Register update returned no row.");
  }
  return updated;
}

/** Opens a session: one open drawer per register and per cashier. */
export async function openSession(
  businessId: number,
  userId: number,
  locationId: number,
  registerId: number,
  openingCash: number,
): Promise<SessionSummary> {
  if (openingCash < 0) {
    throw new BadRequestError("Opening cash cannot be negative.");
  }
  const summary = await db.transaction(async (tx) => {
    const [register] = await tx
      .select()
      .from(registers)
      .where(
        and(
          eq(registers.id, registerId),
          eq(registers.businessId, businessId),
        ),
      )
      .for("update");
    if (!register) {
      throw new NotFoundError("Register not found.");
    }
    if (register.locationId !== locationId) {
      // The register belongs to another location of this business — do not
      // reveal which; the location-scoped list is the only way to find one.
      throw new NotFoundError("Register not found.");
    }
    if (register.status !== "active") {
      throw new BadRequestError("This register is deactivated.");
    }
    const [registerOpen] = await tx
      .select({ id: registerSessions.id })
      .from(registerSessions)
      .where(
        and(
          eq(registerSessions.registerId, registerId),
          eq(registerSessions.status, "open"),
        ),
      )
      .for("update", { of: registerSessions });
    if (registerOpen) {
      throw new ConflictError(
        "This register already has an open session. Close it first.",
      );
    }
    const [userOpen] = await tx
      .select({ id: registerSessions.id })
      .from(registerSessions)
      .where(
        and(
          eq(registerSessions.userId, userId),
          eq(registerSessions.businessId, businessId),
          eq(registerSessions.status, "open"),
        ),
      )
      .for("update", { of: registerSessions });
    if (userOpen) {
      throw new ConflictError(
        "You already have an open register session. Close it first.",
      );
    }

    const [session] = await tx
      .insert(registerSessions)
      .values({
        businessId,
        registerId,
        userId,
        openingCash: roundMoney(openingCash),
      })
      .returning();
    if (!session) {
      throw new Error("Session insert returned no row.");
    }

    const [row] = await tx
      .select(sessionSelect)
      .from(registerSessions)
      .innerJoin(
        registers,
        and(
          eq(registers.id, registerSessions.registerId),
          eq(registers.businessId, businessId),
        ),
      )
      .innerJoin(
        locations,
        and(
          eq(locations.id, registers.locationId),
          eq(locations.businessId, businessId),
        ),
      )
      .innerJoin(users, eq(users.id, registerSessions.userId))
      .where(eq(registerSessions.id, session.id));
    if (!row) {
      throw new Error("Session lookup failed.");
    }
    return toSummary(row, Number(session.openingCash));
  });
  publishRealtime(businessId, locationId, {
    kind: "register.changed",
    locationId,
  });
  return summary;
}

/** The caller's own open session, if any. */
export async function getCurrentSession(
  businessId: number,
  userId: number,
): Promise<SessionSummary | null> {
  const [row] = await sessionBaseQuery()
    .where(
      and(
        eq(registerSessions.businessId, businessId),
        eq(registerSessions.userId, userId),
        eq(registerSessions.status, "open"),
      ),
    )
    .limit(1);
  if (!row) return null;
  const expected = await computeExpectedCash(db, row.id, Number(row.openingCash));
  return toSummary(row, expected);
}

function assertSessionMayBeOperated(
  session: { userId: number; status: string },
  callerUserId: number,
  callerIsOwner: boolean,
): void {
  if (session.status !== "open") {
    throw new ConflictError("This session is already closed.");
  }
  if (session.userId !== callerUserId && !callerIsOwner) {
    throw new ForbiddenError(
      "You can only operate your own register session.",
    );
  }
}

export async function addCashMovement(
  businessId: number,
  callerUserId: number,
  callerIsOwner: boolean,
  sessionId: number,
  type: ManualMovementType,
  amount: number,
  note?: string,
): Promise<SessionSummary> {
  if (amount <= 0) {
    throw new BadRequestError("Amount must be greater than zero.");
  }
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(registerSessions)
      .where(
        and(
          eq(registerSessions.id, sessionId),
          eq(registerSessions.businessId, businessId),
        ),
      )
      .for("update");
    if (!session) {
      throw new NotFoundError("Session not found.");
    }
    assertSessionMayBeOperated(session, callerUserId, callerIsOwner);

    await tx.insert(registerTransactions).values({
      businessId,
      sessionId,
      userId: callerUserId,
      type,
      amount: roundMoney(amount),
      referenceType: "manual",
      note: note ?? null,
    });

    const expected = await computeExpectedCash(tx, sessionId, Number(session.openingCash));
    return {
      id: session.id,
      registerId: session.registerId,
      registerName: "",
      locationId: 0,
      locationName: "",
      userName: "",
      status: session.status,
      openingCash: Number(session.openingCash),
      expectedCash: expected,
      countedCash: null,
      difference: null,
      notes: session.notes,
      openedAt: session.openedAt,
      closedAt: session.closedAt,
    };
  });
}

export interface RegisterTransactionView {
  id: number;
  type: string;
  amount: number;
  referenceType: string | null;
  referenceId: number | null;
  note: string | null;
  userName: string;
  createdAt: Date | null;
}

export async function getSessionDetail(
  businessId: number,
  callerUserId: number,
  callerIsOwner: boolean,
  hasSettingsView: boolean,
  sessionId: number,
): Promise<SessionSummary & { transactions: RegisterTransactionView[] }> {
  const [row] = await sessionBaseQuery()
    .where(
      and(
        eq(registerSessions.businessId, businessId),
        eq(registerSessions.id, sessionId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new NotFoundError("Session not found.");
  }
  // Cashiers may only inspect their own sessions; settings.view holders
  // and owners may inspect any session at the business.
  const sessionUserIdRow = await db
    .select({ userId: registerSessions.userId })
    .from(registerSessions)
    .where(eq(registerSessions.id, sessionId));
  const ownerId = sessionUserIdRow[0]?.userId;
  if (ownerId !== undefined && ownerId !== callerUserId && !callerIsOwner && !hasSettingsView) {
    throw new ForbiddenError("You can only view your own register sessions.");
  }
  const transactions = await db
    .select({
      id: registerTransactions.id,
      type: registerTransactions.type,
      amount: registerTransactions.amount,
      referenceType: registerTransactions.referenceType,
      referenceId: registerTransactions.referenceId,
      note: registerTransactions.note,
      userName: users.fullName,
      createdAt: registerTransactions.createdAt,
    })
    .from(registerTransactions)
    .innerJoin(users, eq(users.id, registerTransactions.userId))
    .where(eq(registerTransactions.sessionId, sessionId))
    .orderBy(desc(registerTransactions.id));

  const expected =
    row.status === "open"
      ? await computeExpectedCash(db, row.id, Number(row.openingCash))
      : Number(row.expectedCash ?? 0);

  return {
    ...toSummary(row, expected),
    transactions: transactions.map((t) => ({
      ...t,
      amount: Number(t.amount),
    })),
  };
}

/** Closes the drawer: computes expected vs counted and stores the variance. */
export async function closeSession(
  businessId: number,
  callerUserId: number,
  callerIsOwner: boolean,
  sessionId: number,
  countedCash: number,
  notes?: string,
): Promise<SessionSummary> {
  if (countedCash < 0) {
    throw new BadRequestError("Counted cash cannot be negative.");
  }
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(registerSessions)
      .where(
        and(
          eq(registerSessions.id, sessionId),
          eq(registerSessions.businessId, businessId),
        ),
      )
      .for("update");
    if (!session) {
      throw new NotFoundError("Session not found.");
    }
    assertSessionMayBeOperated(session, callerUserId, callerIsOwner);

    const expected = await computeExpectedCash(
      tx,
      sessionId,
      Number(session.openingCash),
    );
    const counted = roundMoney(countedCash);
    const difference = roundMoney(counted - expected);

    await tx
      .update(registerSessions)
      .set({
        status: "closed",
        expectedCash: expected,
        countedCash: counted,
        difference,
        notes: notes ?? session.notes,
        closedAt: new Date(),
      })
      .where(eq(registerSessions.id, sessionId));

    const [row] = await tx
      .select(sessionSelect)
      .from(registerSessions)
      .innerJoin(
        registers,
        and(
          eq(registers.id, registerSessions.registerId),
          eq(registers.businessId, businessId),
        ),
      )
      .innerJoin(
        locations,
        and(
          eq(locations.id, registers.locationId),
          eq(locations.businessId, businessId),
        ),
      )
      .innerJoin(users, eq(users.id, registerSessions.userId))
      .where(eq(registerSessions.id, sessionId));
    if (!row) {
      throw new Error("Session lookup failed after close.");
    }
    const closed = toSummary(row, expected);
    const closeDelta =
      closed.countedCash === null
        ? null
        : roundMoney(closed.countedCash - closed.expectedCash);
    if (closeDelta !== null && Math.abs(closeDelta) > 0.01) {
      await notifyRegisterDiscrepancy(tx, {
        businessId,
        sessionId: row.id,
        registerName: closed.registerName || `Register ${closed.registerId}`,
        difference: closeDelta,
      });
    }
    publishRealtime(businessId, closed.locationId, {
      kind: "register.changed",
      locationId: closed.locationId,
    });
    return closed;
  });
}

/**
 * Auto-records the cash portion of a sale into the seller's open register
 * session (same transaction as the sale — atomic). No-op when the seller
 * has no open session at this location or the cash amount is zero.
 */
export async function recordCashSaleInTx(
  tx: Tx,
  businessId: number,
  userId: number,
  locationId: number,
  cashAmount: number,
  saleId: number,
): Promise<void> {
  if (cashAmount <= 0) return;
  const session = await findOpenSessionForAttribution(
    tx,
    businessId,
    userId,
    locationId,
  );
  if (!session) return;
  await tx.insert(registerTransactions).values({
    businessId,
    sessionId: session.id,
    userId,
    type: "sale",
    amount: roundMoney(cashAmount),
    referenceType: "sale",
    referenceId: saleId,
  });
}

/**
 * Auto-records a counter cash refund into the refunding user's open register
 * session (same transaction as the refund — atomic). The drawer physically
 * pays the customer, so expected cash must decrease. No-op when the actor
 * has no open session at the sale's location — consistent with cash-sale
 * attribution.
 */
export async function recordCashRefundInTx(
  tx: Tx,
  businessId: number,
  userId: number | null,
  locationId: number | null,
  cashAmount: number,
  refundId: number,
): Promise<void> {
  if (cashAmount <= 0 || userId === null || locationId === null) return;
  const session = await findOpenSessionForAttribution(
    tx,
    businessId,
    userId,
    locationId,
  );
  if (!session) return;
  await tx.insert(registerTransactions).values({
    businessId,
    sessionId: session.id,
    userId,
    type: "cash_refund",
    amount: roundMoney(cashAmount),
    referenceType: "sale_refund",
    referenceId: refundId,
  });
}

/**
 * Auto-records a cash due collection (customer invoice payment taken at the
 * counter) into the collector's open register session — same transaction as
 * the payment row. The source record is the sale_payment itself; the
 * reference unique index makes retries idempotent.
 */
export async function recordDueCollectionInTx(
  tx: Tx,
  businessId: number,
  userId: number | null,
  locationId: number | null,
  cashAmount: number,
  paymentId: number,
): Promise<void> {
  if (cashAmount <= 0 || userId === null || locationId === null) return;
  const session = await findOpenSessionForAttribution(
    tx,
    businessId,
    userId,
    locationId,
  );
  if (!session) return;
  await tx.insert(registerTransactions).values({
    businessId,
    sessionId: session.id,
    userId,
    type: "cash_in",
    amount: roundMoney(cashAmount),
    referenceType: "sale_payment",
    referenceId: paymentId,
  });
}

/**
 * The actor's open session, but only when its register sits at the given
 * location (a session opened at another location must never absorb this
 * business's cash). Row-locks the session so concurrent attributions
 * serialize on the drawer.
 */
async function findOpenSessionForAttribution(
  tx: Tx,
  businessId: number,
  userId: number,
  locationId: number,
): Promise<{ id: number } | null> {
  const [session] = await tx
    .select({
      id: registerSessions.id,
      registerLocationId: registers.locationId,
    })
    .from(registerSessions)
    .innerJoin(
      registers,
      eq(registers.id, registerSessions.registerId),
    )
    .where(
      and(
        eq(registerSessions.businessId, businessId),
        eq(registerSessions.userId, userId),
        eq(registerSessions.status, "open"),
      ),
    )
    .for("update", { of: registerSessions });
  if (!session || session.registerLocationId !== locationId) {
    return null;
  }
  return { id: session.id };
}

// ----------------------------------------------------
// REGISTER SESSION REPORT (Phase 5)
// ----------------------------------------------------

export interface RegisterSessionReportRow {
  sessionId: number;
  registerName: string;
  locationName: string;
  userName: string;
  status: string;
  openingCash: number;
  expectedCash: number;
  countedCash: number | null;
  difference: number | null;
  cashSales: number;
  cashIn: number;
  cashOut: number;
  cashRefunds: number;
  safeWithdrawals: number;
  safeDeposits: number;
  adjustmentsIn: number;
  adjustmentsOut: number;
  openedAt: Date | null;
  closedAt: Date | null;
}

/**
 * Register shift summaries for a period (closed sessions by close date, plus
 * still-open sessions for live views). Totals aggregate the variance — the
 * over/short money the business cares about.
 */
export async function getRegisterSessionReport(
  businessId: number,
  from: string,
  to: string,
): Promise<{
  rows: RegisterSessionReportRow[];
  totals: {
    sessionCount: number;
    expectedCash: number;
    countedCash: number;
    difference: number;
    cashSales: number;
    cashRefunds: number;
  };
}> {
  const rows = await sessionBaseQuery()
    .where(
      and(
        eq(registerSessions.businessId, businessId),
        sql`(
          (${registerSessions.status} = 'closed' AND ${registerSessions.closedAt} >= ${`${from} 00:00:00`}::timestamp
            AND ${registerSessions.closedAt} <= ${`${to} 23:59:59.999`}::timestamp)
          OR ${registerSessions.status} = 'open'
        )`,
      ),
    )
    .orderBy(desc(registerSessions.id))
    .limit(500);

  const movementTotals = await db
    .select({
      sessionId: registerTransactions.sessionId,
      type: registerTransactions.type,
      total: sql<string>`COALESCE(SUM(${registerTransactions.amount}), 0)`,
    })
    .from(registerTransactions)
    .where(eq(registerTransactions.businessId, businessId))
    .groupBy(registerTransactions.sessionId, registerTransactions.type);
  const movementsBySession = new Map<
    number,
    {
      sales: number;
      cashIn: number;
      cashOut: number;
      cashRefunds: number;
      safeWithdrawals: number;
      safeDeposits: number;
      adjustmentsIn: number;
      adjustmentsOut: number;
    }
  >();
  for (const row of movementTotals) {
    const entry = movementsBySession.get(row.sessionId) ?? {
      sales: 0,
      cashIn: 0,
      cashOut: 0,
      cashRefunds: 0,
      safeWithdrawals: 0,
      safeDeposits: 0,
      adjustmentsIn: 0,
      adjustmentsOut: 0,
    };
    const total = Number(row.total);
    switch (row.type) {
      case "sale":
        entry.sales = total;
        break;
      case "cash_in":
        entry.cashIn = total;
        break;
      case "cash_out":
        entry.cashOut = total;
        break;
      case "cash_refund":
        entry.cashRefunds = total;
        break;
      case "safe_withdrawal":
        entry.safeWithdrawals = total;
        break;
      case "safe_deposit":
        entry.safeDeposits = total;
        break;
      case "adjustment_in":
        entry.adjustmentsIn = total;
        break;
      case "adjustment_out":
        entry.adjustmentsOut = total;
        break;
    }
    movementsBySession.set(row.sessionId, entry);
  }

  const reportRows: RegisterSessionReportRow[] = rows.map((row) => {
    const movements = movementsBySession.get(row.id) ?? {
      sales: 0,
      cashIn: 0,
      cashOut: 0,
      cashRefunds: 0,
      safeWithdrawals: 0,
      safeDeposits: 0,
      adjustmentsIn: 0,
      adjustmentsOut: 0,
    };
    return {
      sessionId: row.id,
      registerName: row.registerName,
      locationName: row.locationName,
      userName: row.userName,
      status: row.status,
      openingCash: Number(row.openingCash),
      expectedCash: Number(row.expectedCash ?? 0),
      countedCash: row.countedCash === null ? null : Number(row.countedCash),
      difference: row.difference === null ? null : Number(row.difference),
      cashSales: movements.sales,
      cashIn: movements.cashIn,
      cashOut: movements.cashOut,
      cashRefunds: movements.cashRefunds,
      safeWithdrawals: movements.safeWithdrawals,
      safeDeposits: movements.safeDeposits,
      adjustmentsIn: movements.adjustmentsIn,
      adjustmentsOut: movements.adjustmentsOut,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
    };
  });

  const totals = reportRows.reduce(
    (acc, row) => ({
      sessionCount: acc.sessionCount + 1,
      expectedCash: acc.expectedCash + (row.status === "closed" ? row.expectedCash : 0),
      countedCash: acc.countedCash + (row.countedCash ?? 0),
      difference: acc.difference + (row.difference ?? 0),
      cashSales: acc.cashSales + (row.status === "closed" ? row.cashSales : 0),
      cashRefunds: acc.cashRefunds + (row.status === "closed" ? row.cashRefunds : 0),
    }),
    { sessionCount: 0, expectedCash: 0, countedCash: 0, difference: 0, cashSales: 0, cashRefunds: 0 },
  );

  return { rows: reportRows, totals };
}
