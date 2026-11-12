import { and, asc, desc, eq, sql } from "drizzle-orm";
import { publishRealtime } from "../realtime/realtime.service.js";
import { notifyRegisterDiscrepancy } from "../../services/notifications.js";
import { recordAuditInTx, recordAudit } from "../../services/audit.js";
import { consumeApprovalInTx } from "../../services/managerApproval.js";
import { db } from "../../db/schema/index.js";
import { registerSessions } from "../../db/schema/registers.js";
import { registerTransactions } from "../../db/schema/registers.js";
import { registers } from "../../db/schema/registers.js";
import {
  registerDenominationConfigs,
  registerReconciliations,
  type DenominationCount,
} from "../../db/schema/registers.js";
import { locations } from "../../db/schema/locations.js";
import { users } from "../../db/schema/users.js";
import { posTerminals } from "../../db/schema/posTerminals.js";
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

/** Default denomination sheet offered when a business has not configured one. */
export const DEFAULT_DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

/**
 * Validates a counted denomination sheet (Phase 1). The rendered total must
 * equal the single-amount the user entered — the sheet documents the count,
 * it never replaces it.
 */
export function validateDenominationSheet(
  sheet: DenominationCount[] | null | undefined,
  expectedTotal: number,
): DenominationCount[] | null {
  if (sheet === undefined || sheet === null) return null;
  if (!Array.isArray(sheet) || sheet.length === 0 || sheet.length > 30) {
    throw new BadRequestError(
      "Denomination sheet must contain between 1 and 30 rows.",
    );
  }
  const seen = new Set<number>();
  let sum = 0;
  for (const row of sheet) {
    if (
      !row ||
      typeof row.value !== "number" ||
      !Number.isFinite(row.value) ||
      row.value <= 0
    ) {
      throw new BadRequestError("Denomination values must be positive numbers.");
    }
    if (!Number.isInteger(row.count) || row.count < 0) {
      throw new BadRequestError("Denomination counts must be zero or more.");
    }
    if (seen.has(row.value)) {
      throw new BadRequestError(
        `Denomination ${row.value} appears more than once.`,
      );
    }
    seen.add(row.value);
    sum += row.value * row.count;
  }
  if (roundMoney(sum) !== roundMoney(expectedTotal)) {
    throw new BadRequestError(
      `The denomination sheet totals ৳${roundMoney(sum)} but ৳${roundMoney(expectedTotal)} was entered.`,
    );
  }
  return sheet;
}

interface SessionSummary {
  id: number;
  registerId: number;
  registerName: string;
  locationId: number;
  locationName: string;
  userName: string;
  terminalId: number | null;
  terminalName: string | null;
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
    terminalId: number | null;
    terminalName: string | null;
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
    terminalId: row.terminalId,
    terminalName: row.terminalName,
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
  terminalId: registerSessions.terminalId,
  terminalName: posTerminals.name,
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
    .innerJoin(users, eq(users.id, registerSessions.userId))
    .leftJoin(posTerminals, eq(posTerminals.id, registerSessions.terminalId));
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
  terminalId: number | null = null,
  allowMultipleSessions = false,
  opts: {
    openingDenominations?: DenominationCount[] | null;
    actorRole?: string | null;
    requestId?: string | null;
  } = {},
): Promise<SessionSummary> {
  if (openingCash < 0) {
    throw new BadRequestError("Opening cash cannot be negative.");
  }
  const openingDenominations = validateDenominationSheet(
    opts.openingDenominations,
    openingCash,
  );
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
      .select({ id: registerSessions.id, terminalId: registerSessions.terminalId })
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
      // The business policy (pos_settings.allow_multiple_drawer_sessions)
      // may let one cashier run two counters — but only on DIFFERENT
      // terminals; a second terminal-less session stays blocked for
      // everyone (NULLS NOT DISTINCT enforces the same rule at the DB).
      if (
        !allowMultipleSessions ||
        userOpen.terminalId === null ||
        userOpen.terminalId === terminalId
      ) {
        throw new ConflictError(
          "You already have an open register session. Close it first.",
        );
      }
    }

    const [session] = await tx
      .insert(registerSessions)
      .values({
        businessId,
        registerId,
        userId,
        openingCash: roundMoney(openingCash),
        terminalId,
        ...(openingDenominations ? { openingDenominations } : {}),
      })
      .returning();
    if (!session) {
      throw new Error("Session insert returned no row.");
    }

    await recordAuditInTx(tx, {
      businessId,
      actorUserId: userId,
      action: "register.opened",
      entityType: "register_session",
      entityId: session.id,
      locationId: register.locationId,
      actorRole: opts.actorRole ?? null,
      requestId: opts.requestId ?? null,
      metadata: {
        registerId,
        registerName: register.name,
        openingCash: roundMoney(openingCash),
        countedByDenominations: openingDenominations !== null,
        terminalId,
      },
    });

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
      .leftJoin(posTerminals, eq(posTerminals.id, registerSessions.terminalId))
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
  opts: {
    recipientUserId?: number | null;
    referenceNo?: string | null;
    approvalToken?: string | null;
    actorRole?: string | null;
    requestId?: string | null;
  } = {},
): Promise<SessionSummary> {
  if (amount <= 0) {
    throw new BadRequestError("Amount must be greater than zero.");
  }
  // Drop metadata only belongs to a drawer→safe deposit; other movement
  // types reject it so the fields never carry silent meanings.
  if (type !== "safe_deposit" && (opts.recipientUserId != null || opts.referenceNo)) {
    throw new BadRequestError(
      "Recipient and reference number only apply to cash drops (safe deposit).",
    );
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

    // Manager approval when the business requires it for cash movements —
    // consumed inside this transaction so a rollback un-burns the token.
    if (opts.approvalToken) {
      await consumeApprovalInTx(tx, businessId, {
        token: opts.approvalToken,
        opType: "cash_movement",
        payload: { type, amount: roundMoney(amount) },
      });
    }

    await tx.insert(registerTransactions).values({
      businessId,
      sessionId,
      userId: callerUserId,
      type,
      amount: roundMoney(amount),
      referenceType: "manual",
      note: note ?? null,
      ...(type === "safe_deposit" && opts.recipientUserId != null
        ? { recipientUserId: opts.recipientUserId }
        : {}),
      ...(type === "safe_deposit" && opts.referenceNo
        ? { referenceNo: opts.referenceNo }
        : {}),
    });

    await recordAuditInTx(tx, {
      businessId,
      actorUserId: callerUserId,
      action: "cash.movement",
      entityType: "register_session",
      entityId: sessionId,
      actorRole: opts.actorRole ?? null,
      requestId: opts.requestId ?? null,
      metadata: {
        movementType: type,
        amount: roundMoney(amount),
        isDrop: type === "safe_deposit",
        note: note ?? null,
      },
    });

    const expected = await computeExpectedCash(tx, sessionId, Number(session.openingCash));
    return {
      id: session.id,
      registerId: session.registerId,
      registerName: "",
      locationId: 0,
      locationName: "",
      userName: "",
      terminalId: session.terminalId,
      terminalName: null,
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
  /** Cash-drop metadata (safe_deposit only). */
  recipientUserId: number | null;
  recipientName: string | null;
  referenceNo: string | null;
  confirmedBy: number | null;
  confirmedByName: string | null;
  confirmedAt: Date | null;
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
      recipientUserId: registerTransactions.recipientUserId,
      referenceNo: registerTransactions.referenceNo,
      confirmedBy: registerTransactions.confirmedBy,
      confirmedAt: registerTransactions.confirmedAt,
    })
    .from(registerTransactions)
    .innerJoin(users, eq(users.id, registerTransactions.userId))
    .where(eq(registerTransactions.sessionId, sessionId))
    .orderBy(desc(registerTransactions.id));

  // Names for drop recipient / confirmer (single query, then map).
  const nameIds = new Set<number>();
  for (const t of transactions) {
    if (t.recipientUserId) nameIds.add(t.recipientUserId);
    if (t.confirmedBy) nameIds.add(t.confirmedBy);
  }
  const nameById = new Map<number, string>();
  if (nameIds.size > 0) {
    const nameRows = await db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(sql`${users.id} IN (${sql.join([...nameIds].map((id) => sql`${id}`), sql`, `)})`);
    for (const r of nameRows) nameById.set(r.id, r.fullName);
  }

  const expected =
    row.status === "open"
      ? await computeExpectedCash(db, row.id, Number(row.openingCash))
      : Number(row.expectedCash ?? 0);

  return {
    ...toSummary(row, expected),
    transactions: transactions.map((t) => ({
      ...t,
      amount: Number(t.amount),
      recipientName: t.recipientUserId ? nameById.get(t.recipientUserId) ?? null : null,
      confirmedByName: t.confirmedBy ? nameById.get(t.confirmedBy) ?? null : null,
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
  opts: {
    countedDenominations?: DenominationCount[] | null;
    actorRole?: string | null;
    requestId?: string | null;
  } = {},
): Promise<SessionSummary> {
  if (countedCash < 0) {
    throw new BadRequestError("Counted cash cannot be negative.");
  }
  const countedDenominations = validateDenominationSheet(
    opts.countedDenominations,
    countedCash,
  );
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
        ...(countedDenominations ? { countedDenominations } : {}),
      })
      .where(eq(registerSessions.id, sessionId));

    await recordAuditInTx(tx, {
      businessId,
      actorUserId: callerUserId,
      action: "register.closed",
      entityType: "register_session",
      entityId: sessionId,
      actorRole: opts.actorRole ?? null,
      requestId: opts.requestId ?? null,
      metadata: {
        registerId: session.registerId,
        expectedCash: expected,
        countedCash: counted,
        difference,
        countedByDenominations: countedDenominations !== null,
      },
    });

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
      .leftJoin(posTerminals, eq(posTerminals.id, registerSessions.terminalId))
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
 * Mid-shift blind count (Phase 1). Records an interim expected-vs-counted
 * variance WITHOUT changing the session's expected cash — a count event,
 * never a movement. Large variances alert the same notification channel the
 * close path uses, so a drifting drawer is caught before shift end.
 */
export async function reconcileSession(
  businessId: number,
  callerUserId: number,
  callerIsOwner: boolean,
  sessionId: number,
  countedCash: number,
  countedDenominations?: DenominationCount[] | null,
  notes?: string,
  auditCtx: { actorRole?: string | null; requestId?: string | null } = {},
): Promise<{ session: SessionSummary; reconciliationId: number; expected: number; difference: number }> {
  if (countedCash < 0) {
    throw new BadRequestError("Counted cash cannot be negative.");
  }
  const denominations = validateDenominationSheet(countedDenominations, countedCash);
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

    const [reconciliation] = await tx
      .insert(registerReconciliations)
      .values({
        businessId,
        sessionId,
        expectedCash: expected,
        countedCash: counted,
        difference,
        ...(denominations ? { countedDenominations: denominations } : {}),
        notes: notes ?? null,
        createdBy: callerUserId,
      })
      .returning({ id: registerReconciliations.id });
    if (!reconciliation) {
      throw new Error("Reconciliation insert returned no row.");
    }

    await recordAuditInTx(tx, {
      businessId,
      actorUserId: callerUserId,
      action: "register.reconciled",
      entityType: "register_session",
      entityId: sessionId,
      actorRole: auditCtx.actorRole ?? null,
      requestId: auditCtx.requestId ?? null,
      metadata: {
        reconciliationId: reconciliation.id,
        expectedCash: expected,
        countedCash: counted,
        difference,
      },
    });

    if (Math.abs(difference) > 0.01) {
      await notifyRegisterDiscrepancy(tx, {
        businessId,
        sessionId,
        registerName: `Register ${session.registerId}`,
        difference,
      });
    }

    return {
      session: {
        id: session.id,
        registerId: session.registerId,
        registerName: "",
        locationId: 0,
        locationName: "",
        userName: "",
        terminalId: session.terminalId,
        terminalName: null,
        status: session.status,
        openingCash: Number(session.openingCash),
        expectedCash: expected,
        countedCash: null,
        difference: null,
        notes: session.notes,
        openedAt: session.openedAt,
        closedAt: session.closedAt,
      },
      reconciliationId: reconciliation.id,
      expected,
      difference,
    };
  });
}

/**
 * Controlled reopen of a closed session (Phase 1). ALWAYS requires a manager
 * approval token (op register.reopen) consumed inside the transaction. The
 * counted cash at close becomes the reopened session's opening float — the
 * money is still physically in the drawer — and the close variance survives
 * in the audit trail (before/after snapshots), not in mutable columns.
 */
export async function reopenSession(
  businessId: number,
  callerUserId: number,
  sessionId: number,
  approvalToken: string,
  reason?: string,
  auditCtx: { actorRole?: string | null; requestId?: string | null } = {},
): Promise<SessionSummary> {
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
    if (session.status !== "closed") {
      throw new ConflictError("Only a closed session can be reopened.");
    }
    const before = {
      status: session.status,
      openingCash: Number(session.openingCash),
      expectedCash: Number(session.expectedCash ?? 0),
      countedCash: Number(session.countedCash ?? 0),
      difference: Number(session.difference ?? 0),
      closedAt: session.closedAt,
    };

    const approval = await consumeApprovalInTx(tx, businessId, {
      token: approvalToken,
      opType: "register.reopen",
      entityType: "register_session",
      entityId: sessionId,
    });

    // The register must not have another open session, and must be active.
    const [register] = await tx
      .select()
      .from(registers)
      .where(
        and(eq(registers.id, session.registerId), eq(registers.businessId, businessId)),
      )
      .for("update");
    if (!register) {
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
          eq(registerSessions.registerId, session.registerId),
          eq(registerSessions.status, "open"),
        ),
      )
      .for("update", { of: registerSessions });
    if (registerOpen) {
      throw new ConflictError(
        "This register already has an open session. Close it first.",
      );
    }

    const reopenCash = Number(session.countedCash ?? session.openingCash);
    await tx
      .update(registerSessions)
      .set({
        status: "open",
        openingCash: roundMoney(reopenCash),
        // The counted sheet at close IS the physical float going forward.
        ...(session.countedDenominations
          ? { openingDenominations: session.countedDenominations }
          : {}),
        countedDenominations: null,
        expectedCash: null,
        countedCash: null,
        difference: null,
        closedAt: null,
      })
      .where(eq(registerSessions.id, sessionId));

    await recordAuditInTx(tx, {
      businessId,
      actorUserId: callerUserId,
      action: "register.reopened",
      entityType: "register_session",
      entityId: sessionId,
      actorRole: auditCtx.actorRole ?? null,
      requestId: auditCtx.requestId ?? null,
      beforeState: before,
      afterState: { status: "open", openingCash: roundMoney(reopenCash) },
      metadata: {
        approvedBy: approval.approverUserId,
        approvalReason: approval.reason,
        callerReason: reason ?? null,
      },
    });

    return {
      id: session.id,
      registerId: session.registerId,
      registerName: register.name,
      locationId: register.locationId,
      locationName: "",
      userName: "",
      terminalId: session.terminalId,
      terminalName: null,
      status: "open",
      openingCash: roundMoney(reopenCash),
      expectedCash: roundMoney(reopenCash),
      countedCash: null,
      difference: null,
      notes: session.notes,
      openedAt: session.openedAt,
      closedAt: null,
    };
  });
}

/**
 * Manager confirmation of a cash drop (Phase 1): attests the money reached
 * the safe. Requires cash_register.manage (route); the drop's drawer movement
 * itself was already recorded — this only completes its paper trail.
 */
export async function confirmCashDrop(
  businessId: number,
  confirmedByUserId: number,
  sessionId: number,
  transactionId: number,
  auditCtx: { actorRole?: string | null; requestId?: string | null } = {},
): Promise<{ id: number; confirmedAt: Date }> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ id: registerSessions.id })
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
    const [tx2] = await tx
      .select()
      .from(registerTransactions)
      .where(
        and(
          eq(registerTransactions.id, transactionId),
          eq(registerTransactions.sessionId, sessionId),
          eq(registerTransactions.businessId, businessId),
        ),
      )
      .for("update");
    if (!tx2) {
      throw new NotFoundError("Cash movement not found in this session.");
    }
    if (tx2.type !== "safe_deposit") {
      throw new BadRequestError("Only cash drops (safe deposits) can be confirmed.");
    }
    if (tx2.confirmedAt) {
      throw new ConflictError("This drop is already confirmed.");
    }
    const confirmedAt = new Date();
    await tx
      .update(registerTransactions)
      .set({ confirmedBy: confirmedByUserId, confirmedAt })
      .where(eq(registerTransactions.id, transactionId));

    await recordAuditInTx(tx, {
      businessId,
      actorUserId: confirmedByUserId,
      action: "cash.drop_confirmed",
      entityType: "register_transaction",
      entityId: transactionId,
      actorRole: auditCtx.actorRole ?? null,
      requestId: auditCtx.requestId ?? null,
      metadata: {
        sessionId,
        amount: Number(tx2.amount),
        referenceNo: tx2.referenceNo,
        recipientUserId: tx2.recipientUserId,
      },
    });
    return { id: transactionId, confirmedAt };
  });
}

/** The business's denomination sheet, or the default set when unconfigured. */
export async function getDenominationConfig(
  businessId: number,
): Promise<number[]> {
  const [row] = await db
    .select({ denominations: registerDenominationConfigs.denominations })
    .from(registerDenominationConfigs)
    .where(eq(registerDenominationConfigs.businessId, businessId))
    .limit(1);
  return row?.denominations ?? [...DEFAULT_DENOMINATIONS];
}

/** Replaces the business's denomination sheet (validated) and audits it. */
export async function setDenominationConfig(
  businessId: number,
  userId: number,
  denominations: number[],
  auditCtx: { actorRole?: string | null; requestId?: string | null } = {},
): Promise<number[]> {
  if (
    !Array.isArray(denominations) ||
    denominations.length === 0 ||
    denominations.length > 15
  ) {
    throw new BadRequestError(
      "Provide between 1 and 15 denomination values.",
    );
  }
  const seen = new Set<number>();
  for (const value of denominations) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
      throw new BadRequestError(
        "Denomination values must be positive numbers up to 1,000,000.",
      );
    }
    if (seen.has(value)) {
      throw new BadRequestError(`Denomination ${value} appears more than once.`);
    }
    seen.add(value);
  }
  const sorted = [...denominations].sort((a, b) => b - a);
  await db
    .insert(registerDenominationConfigs)
    .values({ businessId, denominations: sorted })
    .onConflictDoUpdate({
      target: registerDenominationConfigs.businessId,
      set: { denominations: sorted, updatedAt: new Date() },
    });
  await recordAudit({
    businessId,
    actorUserId: userId,
    action: "register.denominations_updated",
    entityType: "register_denomination_config",
    entityId: businessId,
    actorRole: auditCtx.actorRole ?? null,
    requestId: auditCtx.requestId ?? null,
    afterState: { denominations: sorted },
  });
  return sorted;
}

/**
 * Auto-records the cash portion of a sale into an open register session
 * (same transaction as the sale — atomic). Attribution preference: the
 * session bound to the sale's TERMINAL (the drawer the money physically
 * landed in, even when another cashier opened it), then the seller's own
 * open session at this location. No-op when neither exists or cash is zero.
 */
export async function recordCashSaleInTx(
  tx: Tx,
  businessId: number,
  userId: number,
  locationId: number,
  cashAmount: number,
  saleId: number,
  terminalId: number | null = null,
): Promise<void> {
  if (cashAmount <= 0) return;
  const session = await findOpenSessionForAttribution(
    tx,
    businessId,
    userId,
    locationId,
    terminalId,
  );
  if (!session) {
    // Phase 1 (audit finding): cash changed hands with no open drawer — the
    // movement cannot be recorded, so leave an honest audit row instead of
    // silently dropping it. require_open_drawer (pos_settings) can reject
    // this situation outright for businesses that opt in.
    await recordAuditInTx(tx, {
      businessId,
      actorUserId: userId,
      action: "cash.unattributed",
      entityType: "sale",
      entityId: saleId,
      locationId,
      metadata: {
        cashAmount: roundMoney(cashAmount),
        terminalId,
        reason: "no_open_register_session",
      },
    });
    return;
  }
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
  terminalId: number | null = null,
): Promise<void> {
  if (cashAmount <= 0 || userId === null || locationId === null) return;
  const session = await findOpenSessionForAttribution(
    tx,
    businessId,
    userId,
    locationId,
    terminalId,
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
 * The actor's open session — or, when the request came from a bound
 * terminal, that terminal's open session (the drawer the cash physically
 * reached, regardless of which cashier opened it). Only sessions whose
 * register sits at the given location qualify (a session opened at another
 * location must never absorb this business's cash). Row-locks the session
 * so concurrent attributions serialize on the drawer.
 */
async function findOpenSessionForAttribution(
  tx: Tx,
  businessId: number,
  userId: number,
  locationId: number,
  terminalId: number | null = null,
): Promise<{ id: number } | null> {
  if (terminalId !== null) {
    const [terminalSession] = await tx
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
          eq(registerSessions.terminalId, terminalId),
          eq(registerSessions.status, "open"),
        ),
      )
      .for("update", { of: registerSessions });
    if (terminalSession && terminalSession.registerLocationId === locationId) {
      return { id: terminalSession.id };
    }
  }
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
