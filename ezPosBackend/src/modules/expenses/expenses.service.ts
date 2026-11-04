import { expenseCategories } from "../../db/schema/expenseCategories.js";
import { expensePayments } from "../../db/schema/expensePayments.js";
import { expenses } from "../../db/schema/expenses.js";
import { locations } from "../../db/schema/locations.js";
import {
  registerSessions,
  registerTransactions,
} from "../../db/schema/registers.js";
import { sales } from "../../db/schema/sales.js";
import { db } from "../../db/schema/index.js";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAuditInTx, recordAudit } from "../../services/audit.js";
import type { Tx } from "../../services/audit.js";
import { listExpenseAttachments } from "./expenses.attachments.service.js";
import type {
  ExpenseCategoryWriteInput,
  ExpenseListQuery,
  ExpensePaymentCreateInput,
  ExpenseWriteInput,
} from "./expenses.schema.js";
import { EXPENSE_EXPORT_LIMIT } from "./expenses.schema.js";
type ExpenseRow = typeof expenses.$inferSelect;
type ExpensePaymentRow = typeof expensePayments.$inferSelect;

// Every function takes the caller's server-verified businessId (from
// requireBusinessContext) and scopes all reads and writes to it.

/** Derive settlement status from the authoritative ledger mirror. */
export function derivePaymentStatus(
  amount: number,
  paidAmount: number,
): "unpaid" | "partial" | "paid" {
  if (paidAmount >= amount) return "paid"; // zero-amount expenses settle by definition
  if (paidAmount > 0) return "partial";
  return "unpaid";
}

/** Channel/order attribution must reference rows the business owns. */
async function assertAttribution(businessId: number, data: ExpenseWriteInput) {
  if (data.sale_id != null) {
    const [sale] = await db
      .select({ id: sales.id })
      .from(sales)
      .where(and(eq(sales.id, data.sale_id), eq(sales.businessId, businessId)))
      .limit(1);
    if (!sale) {
      throw new BadRequestError(
        "Linked order does not exist for this business.",
      );
    }
  }
}

/** Filter conditions shared by list, summary and export. */
function listConditions(businessId: number, filters: ExpenseListQuery) {
  const conditions = [
    eq(expenses.businessId, businessId),
    isNull(expenses.deletedAt),
  ];
  if (filters.locationId) {
    conditions.push(eq(expenses.locationId, filters.locationId));
  }
  if (filters.payment_status) {
    conditions.push(eq(expenses.paymentStatus, filters.payment_status));
  }
  if (filters.payment_method) {
    conditions.push(eq(expenses.paymentMethod, filters.payment_method));
  }
  if (filters.channel) {
    conditions.push(eq(expenses.channel, filters.channel));
  }
  if (filters.date_from) conditions.push(gte(expenses.expenseDate, filters.date_from));
  if (filters.date_to) conditions.push(lte(expenses.expenseDate, filters.date_to));
  if (filters.category_id === "none") {
    conditions.push(isNull(expenses.categoryId));
  } else if (typeof filters.category_id === "number") {
    conditions.push(eq(expenses.categoryId, filters.category_id));
  }
  if (filters.search) {
    const like = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(expenses.title, like),
        ilike(expenses.referenceNo, like),
        ilike(expenses.note, like),
        ilike(expenses.payee, like),
        ilike(expenseCategories.categoryName, like),
      )!,
    );
  }
  return and(...conditions)!;
}

const EXPENSE_LIST_COLUMNS = {
  id: expenses.id,
  title: expenses.title,
  payee: expenses.payee,
  amount: expenses.amount,
  paidAmount: expenses.paidAmount,
  paymentStatus: expenses.paymentStatus,
  paymentMethod: expenses.paymentMethod,
  categoryId: expenses.categoryId,
  categoryName: expenseCategories.categoryName,
  locationId: expenses.locationId,
  locationName: locations.name,
  channel: expenses.channel,
  referenceNo: expenses.referenceNo,
  note: expenses.note,
  expenseDate: expenses.expenseDate,
  createdAt: expenses.createdAt,
} as const;

function listBaseQuery(businessId: number, filters: ExpenseListQuery) {
  return db
    .select(EXPENSE_LIST_COLUMNS)
    .from(expenses)
    .leftJoin(
      expenseCategories,
      and(
        eq(expenses.categoryId, expenseCategories.id),
        eq(expenseCategories.businessId, businessId),
      ),
    )
    .leftJoin(locations, eq(expenses.locationId, locations.id))
    .where(listConditions(businessId, filters))
    .$dynamic();
}

const SORT_COLUMNS = {
  expense_date: expenses.expenseDate,
  amount: expenses.amount,
  title: expenses.title,
  payment_status: expenses.paymentStatus,
  created_at: expenses.createdAt,
} as const;

export async function listExpenses(businessId: number, filters: ExpenseListQuery) {
  const sortColumn = SORT_COLUMNS[filters.sort];
  const direction = filters.sort_dir === "asc" ? asc : desc;

  const rows = await listBaseQuery(businessId, filters)
    .orderBy(direction(sortColumn), desc(expenses.id))
    .limit(filters.page_size)
    .offset((filters.page - 1) * filters.page_size);

  const [totals] = await db
    .select({
      totalCount: count(),
      totalAmount: sql<number>`round(coalesce(sum(${expenses.amount}), 0)::numeric, 2)::float8`,
      totalPaid: sql<number>`round(coalesce(sum(${expenses.paidAmount}), 0)::numeric, 2)::float8`,
      totalDue: sql<number>`round(coalesce(sum(${expenses.amount} - ${expenses.paidAmount}), 0)::numeric, 2)::float8`,
      unpaidCount: sql<number>`count(*) filter (where ${expenses.paymentStatus} = 'unpaid')::int`,
      partialCount: sql<number>`count(*) filter (where ${expenses.paymentStatus} = 'partial')::int`,
      paidCount: sql<number>`count(*) filter (where ${expenses.paymentStatus} = 'paid')::int`,
    })
    .from(expenses)
    // Search can match the category name, so the aggregate needs this join too.
    .leftJoin(
      expenseCategories,
      and(
        eq(expenses.categoryId, expenseCategories.id),
        eq(expenseCategories.businessId, businessId),
      ),
    )
    .where(listConditions(businessId, filters));

  return {
    rows,
    meta: {
      page: filters.page,
      pageSize: filters.page_size,
      total: Number(totals?.totalCount ?? 0),
      totalPages: Math.max(
        1,
        Math.ceil(Number(totals?.totalCount ?? 0) / filters.page_size),
      ),
      summary: {
        totalAmount: totals?.totalAmount ?? 0,
        totalPaid: totals?.totalPaid ?? 0,
        totalDue: totals?.totalDue ?? 0,
        unpaidCount: Number(totals?.unpaidCount ?? 0),
        partialCount: Number(totals?.partialCount ?? 0),
        paidCount: Number(totals?.paidCount ?? 0),
      },
    },
  };
}

/** Same filtering as the list, bounded hard for CSV export. */
export async function exportExpenses(businessId: number, filters: ExpenseListQuery) {
  return listBaseQuery(businessId, filters)
    .orderBy(desc(expenses.expenseDate), desc(expenses.id))
    .limit(EXPENSE_EXPORT_LIMIT);
}
async function loadPayments(businessId: number, expenseId: number) {
  return db
    .select({
      id: expensePayments.id,
      amount: expensePayments.amount,
      paymentMethod: expensePayments.paymentMethod,
      paymentDate: expensePayments.paymentDate,
      referenceNo: expensePayments.referenceNo,
      note: expensePayments.note,
      recordedBy: expensePayments.recordedBy,
      registerSessionId: expensePayments.registerSessionId,
      createdAt: expensePayments.createdAt,
    })
    .from(expensePayments)
    .where(
      and(
        eq(expensePayments.expenseId, expenseId),
        eq(expensePayments.businessId, businessId),
      ),
    )
    .orderBy(desc(expensePayments.paymentDate), desc(expensePayments.id));
}

async function loadDetail(businessId: number, expense: ExpenseRow) {
  const [categoryName] = expense.categoryId
    ? await db
        .select({ name: expenseCategories.categoryName })
        .from(expenseCategories)
        .where(
          and(
            eq(expenseCategories.id, expense.categoryId),
            eq(expenseCategories.businessId, businessId),
          ),
        )
        .limit(1)
    : [];
  const [locationName] = expense.locationId
    ? await db
        .select({ name: locations.name })
        .from(locations)
        .where(eq(locations.id, expense.locationId))
        .limit(1)
    : [];
  const payments = await loadPayments(businessId, expense.id);
  const attachments = await listExpenseAttachments(businessId, expense.id);
  const amount = Number(expense.amount);
  const paidAmount = Number(expense.paidAmount);
  return {
    ...expense,
    categoryName: categoryName?.name ?? null,
    locationName: locationName?.name ?? null,
    dueAmount: Math.round((amount - paidAmount) * 100) / 100,
    payments,
    attachments,
  };
}

export async function getExpense(businessId: number, id: number) {
  const [expense] = await db
    .select()
    .from(expenses)
    .where(
      and(
        eq(expenses.id, id),
        eq(expenses.businessId, businessId),
        isNull(expenses.deletedAt),
      ),
    )
    .limit(1);
  if (!expense) {
    throw new NotFoundError("Expense not found");
  }
  return loadDetail(businessId, expense);
}

/** Exact-cents arithmetic keeps settlement comparisons float-safe. */
function cents(value: number): number {
  return Math.round(value * 100);
}

function isUniqueViolation(err: unknown): boolean {
  // drizzle wraps driver errors — the pg code can sit on err or err.cause.
  const code = (e: unknown): string | undefined =>
    e && typeof e === "object" ? (e as { code?: string }).code : undefined;
  return (
    code(err) === "23505" ||
    code((err as { cause?: unknown } | null)?.cause) === "23505"
  );
}

async function sumSettledInTx(
  tx: Tx,
  businessId: number,
  expenseId: number,
): Promise<number> {
  const [agg] = await tx
    .select({
      paid: sql<number>`coalesce(sum(${expensePayments.amount}), 0)::numeric`,
    })
    .from(expensePayments)
    .where(
      and(
        eq(expensePayments.expenseId, expenseId),
        eq(expensePayments.businessId, businessId),
      ),
    );
  return Number(agg?.paid ?? 0);
}

/**
 * Validate + lock the register session, then record the drawer movement
 * (approved decision D3): a Cash settlement tied to an open session becomes a
 * `cash_out` transaction, so the session's expected_cash reflects the expense.
 */
async function insertRegisterCashOut(
  tx: Tx,
  opts: {
    businessId: number;
    sessionId: number;
    recordedBy: number;
    callerIsOwner: boolean;
    amount: number;
    referenceId: number;
    note: string | null;
  },
): Promise<void> {
  const [session] = await tx
    .select({
      id: registerSessions.id,
      userId: registerSessions.userId,
      status: registerSessions.status,
    })
    .from(registerSessions)
    .where(
      and(
        eq(registerSessions.id, opts.sessionId),
        eq(registerSessions.businessId, opts.businessId),
      ),
    )
    .for("update");
  if (!session) {
    throw new NotFoundError("Register session not found.");
  }
  if (session.status !== "open") {
    throw new ConflictError("This session is already closed.");
  }
  if (session.userId !== opts.recordedBy && !opts.callerIsOwner) {
    throw new ForbiddenError(
      "You can only operate your own register session.",
    );
  }
  await tx.insert(registerTransactions).values({
    businessId: opts.businessId,
    sessionId: opts.sessionId,
    userId: opts.recordedBy,
    type: "cash_out",
    amount: opts.amount,
    referenceType: "expense_payment",
    referenceId: opts.referenceId,
    note: opts.note,
  });
}

export async function createExpense(
  businessId: number,
  locationId: number,
  recordedBy: number,
  callerIsOwner: boolean,
  data: ExpenseWriteInput,
) {
  await assertAttribution(businessId, data);
  if (data.record_as === "unpaid" && data.initial_payment) {
    throw new BadRequestError(
      "An expense recorded as unpaid cannot include an initial payment.",
    );
  }
  if (data.initial_payment?.register_session_id && data.payment_method !== "Cash") {
    throw new BadRequestError(
      "Only cash settlements can be tied to a register session.",
    );
  }
  // Default settlement mirrors the legacy contract: recording an expense
  // settles it in full with the expense's own method and date. `record_as:
  // "unpaid"` records a pure due instead.
  const initialPayment =
    data.record_as === "unpaid"
      ? null
      : {
          amount: data.initial_payment?.amount ?? data.amount,
          paymentDate: data.initial_payment?.payment_date ?? data.expense_date,
          referenceNo: data.initial_payment?.reference_no ?? null,
          note: data.initial_payment?.note ?? null,
          registerSessionId: data.initial_payment?.register_session_id ?? null,
        };
  if (initialPayment && initialPayment.amount > data.amount) {
    throw new BadRequestError(
      "The initial payment cannot exceed the expense amount.",
    );
  }

  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(expenses)
      .values({
        businessId,
        locationId,
        title: data.title,
        expenseDate: data.expense_date,
        amount: data.amount,
        payee: data.payee ?? null,
        categoryId: data.category_id,
        paymentMethod: data.payment_method,
        referenceNo: data.reference_no ?? null,
        note: data.note ?? null,
        channel: data.channel ?? null,
        saleId: data.sale_id ?? null,
        paidAmount: initialPayment?.amount ?? 0,
        paymentStatus: derivePaymentStatus(
          data.amount,
          initialPayment?.amount ?? 0,
        ),
        createdBy: recordedBy,
        updatedBy: recordedBy,
      })
      .returning();
    const expense = inserted[0];
    if (!expense) {
      throw new NotFoundError("Expense could not be created.");
    }
    if (initialPayment) {
      const paymentRows = await tx
        .insert(expensePayments)
        .values({
          businessId,
          expenseId: expense.id,
          amount: initialPayment.amount,
          paymentMethod: data.payment_method,
          paymentDate: initialPayment.paymentDate,
          referenceNo: initialPayment.referenceNo,
          note: initialPayment.note,
          recordedBy,
          locationId,
          registerSessionId: initialPayment.registerSessionId,
        })
        .returning();
      const payment = paymentRows[0];
      if (!payment) {
        throw new NotFoundError("Settlement could not be recorded.");
      }
      if (initialPayment.registerSessionId) {
        await insertRegisterCashOut(tx, {
          businessId,
          sessionId: initialPayment.registerSessionId,
          recordedBy,
          callerIsOwner,
          amount: initialPayment.amount,
          referenceId: payment.id,
          note: `Expense settlement: ${expense.title}`,
        });
      }
    }
    await recordAuditInTx(tx, {
      businessId,
      actorUserId: recordedBy,
      action: "expense.create",
      entityType: "expense",
      entityId: expense.id,
      metadata: {
        title: expense.title,
        amount: expense.amount,
        paidAmount: expense.paidAmount,
        paymentStatus: expense.paymentStatus,
      },
    });
    return expense;
  });
  return loadDetail(businessId, created);
}

export async function updateExpense(
  businessId: number,
  id: number,
  updatedBy: number,
  data: ExpenseWriteInput,
) {
  await assertAttribution(businessId, data);
  // Expense edits never move an expense between locations — the owning
  // location stays whatever it was created with.
  const updated = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: expenses.id, paidAmount: expenses.paidAmount })
      .from(expenses)
      .where(
        and(
          eq(expenses.id, id),
          eq(expenses.businessId, businessId),
          isNull(expenses.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new NotFoundError("Expense not found");
    }
    const paidAmount = Number(existing.paidAmount);
    if (data.amount < paidAmount) {
      throw new BadRequestError(
        `The expense amount cannot be reduced below the ${paidAmount.toFixed(
          2,
        )} already paid. Void the expense or record it as a smaller new expense.`,
      );
    }
    const updatedRows = await tx
      .update(expenses)
      .set({
        title: data.title,
        expenseDate: data.expense_date,
        amount: data.amount,
        payee: data.payee ?? null,
        categoryId: data.category_id,
        paymentMethod: data.payment_method,
        referenceNo: data.reference_no ?? null,
        note: data.note ?? null,
        channel: data.channel ?? null,
        saleId: data.sale_id ?? null,
        paymentStatus: derivePaymentStatus(data.amount, paidAmount),
        updatedBy,
      })
      .where(
        and(
          eq(expenses.id, id),
          eq(expenses.businessId, businessId),
          isNull(expenses.deletedAt),
        ),
      )
      .returning();
    const expense = updatedRows[0];
    if (!expense) {
      throw new NotFoundError("Expense not found");
    }
    await recordAuditInTx(tx, {
      businessId,
      actorUserId: updatedBy,
      action: "expense.update",
      entityType: "expense",
      entityId: expense.id,
      metadata: {
        amount: expense.amount,
        paidAmount: expense.paidAmount,
        paymentStatus: expense.paymentStatus,
      },
    });
    return expense;
  });
  return loadDetail(businessId, updated);
}

/** Soft void — financial records are never hard-deleted. */
export async function voidExpense(
  businessId: number,
  id: number,
  deletedBy: number,
  reason: string | undefined,
) {
  const [voided] = await db
    .update(expenses)
    .set({
      deletedAt: sql`CURRENT_TIMESTAMP`,
      deletedBy,
      voidReason: reason ?? null,
    })
    .where(
      and(
        eq(expenses.id, id),
        eq(expenses.businessId, businessId),
        isNull(expenses.deletedAt),
      ),
    )
    .returning({ id: expenses.id, title: expenses.title });
  if (!voided) {
    throw new NotFoundError("Expense not found");
  }
  await recordAudit({
    businessId,
    actorUserId: deletedBy,
    action: "expense.void",
    entityType: "expense",
    entityId: voided.id,
    metadata: { title: voided.title, reason: reason ?? null },
  });
  return { id: voided.id };
}

// ---------------------------------------------------------------------------
// Settlement ledger (Phase 2): the expense row's paid_amount/payment_status
// are mirrors maintained ONLY inside these transactions; the authoritative
// balance is always recomputed from expense_payments rows.
// ---------------------------------------------------------------------------

export async function listExpensePayments(
  businessId: number,
  expenseId: number,
) {
  const [expense] = await db
    .select({ id: expenses.id })
    .from(expenses)
    .where(
      and(
        eq(expenses.id, expenseId),
        eq(expenses.businessId, businessId),
        isNull(expenses.deletedAt),
      ),
    )
    .limit(1);
  if (!expense) {
    throw new NotFoundError("Expense not found");
  }
  return loadPayments(businessId, expenseId);
}

export async function recordExpensePayment(
  businessId: number,
  expenseId: number,
  recordedBy: number,
  callerIsOwner: boolean,
  data: ExpensePaymentCreateInput,
) {
  if (data.register_session_id && data.payment_method !== "Cash") {
    throw new BadRequestError(
      "Only cash payments can be tied to a register session.",
    );
  }
  return db.transaction(async (tx) => {
    const [expense] = await tx
      .select({
        id: expenses.id,
        title: expenses.title,
        amount: expenses.amount,
        paidAmount: expenses.paidAmount,
        locationId: expenses.locationId,
      })
      .from(expenses)
      .where(
        and(
          eq(expenses.id, expenseId),
          eq(expenses.businessId, businessId),
          isNull(expenses.deletedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!expense) {
      throw new NotFoundError("Expense not found");
    }

    // Idempotency first: a retried submission returns the original
    // settlement instead of failing overpayment/settled checks.
    if (data.client_uuid) {
      const [existing] = await tx
        .select()
        .from(expensePayments)
        .where(
          and(
            eq(expensePayments.clientUuid, data.client_uuid),
            eq(expensePayments.businessId, businessId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.expenseId !== expenseId) {
          throw new ConflictError(
            "This payment was already submitted for another expense.",
          );
        }
        return {
          payment: existing,
          duplicate: true as const,
          paidAmount: Number(expense.paidAmount),
          paymentStatus: derivePaymentStatus(
            Number(expense.amount),
            Number(expense.paidAmount),
          ),
        };
      }
    }

    const amount = Number(expense.amount);
    const remainingCents = cents(amount) - cents(Number(expense.paidAmount));
    if (remainingCents <= 0) {
      throw new BadRequestError("This expense is already fully settled.");
    }
    if (cents(data.amount) > remainingCents) {
      throw new BadRequestError(
        `This payment would overpay the expense. The remaining balance is ${(remainingCents / 100).toFixed(2)}.`,
      );
    }

    let payment: ExpensePaymentRow | undefined;
    try {
      const rows = await tx
        .insert(expensePayments)
        .values({
          businessId,
          expenseId,
          amount: data.amount,
          paymentMethod: data.payment_method,
          paymentDate: data.payment_date,
          referenceNo: data.reference_no ?? null,
          note: data.note ?? null,
          recordedBy,
          registerSessionId: data.register_session_id ?? null,
          locationId: expense.locationId,
          clientUuid: data.client_uuid ?? null,
        })
        .returning();
      payment = rows[0];
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          "A payment with this reference number already exists.",
        );
      }
      throw err;
    }
    if (!payment) {
      throw new NotFoundError("Payment could not be recorded.");
    }

    if (data.register_session_id) {
      await insertRegisterCashOut(tx, {
        businessId,
        sessionId: data.register_session_id,
        recordedBy,
        callerIsOwner,
        amount: data.amount,
        referenceId: payment.id,
        note: `Expense settlement: ${expense.title}`,
      });
    }

    const paid = await sumSettledInTx(tx, businessId, expenseId);
    await tx
      .update(expenses)
      .set({
        paidAmount: paid,
        paymentStatus: derivePaymentStatus(amount, paid),
      })
      .where(eq(expenses.id, expenseId));

    await recordAuditInTx(tx, {
      businessId,
      actorUserId: recordedBy,
      action: "expense.payment.record",
      entityType: "expense",
      entityId: expenseId,
      metadata: {
        paymentId: payment.id,
        amount: payment.amount,
        paymentMethod: payment.paymentMethod,
        paidAmount: paid,
      },
    });

    return {
      payment,
      duplicate: false as const,
      paidAmount: paid,
      paymentStatus: derivePaymentStatus(amount, paid),
    };
  });
}

/**
 * Corrective void of a settlement: removes the ledger row and any matching
 * register cash_out movement, then recomputes the expense balance. The
 * audit entry preserves what was removed.
 */
export async function voidExpensePayment(
  businessId: number,
  expenseId: number,
  paymentId: number,
  voidedBy: number,
) {
  await db.transaction(async (tx) => {
    const [expense] = await tx
      .select({ id: expenses.id, amount: expenses.amount })
      .from(expenses)
      .where(
        and(
          eq(expenses.id, expenseId),
          eq(expenses.businessId, businessId),
          isNull(expenses.deletedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!expense) {
      throw new NotFoundError("Expense not found");
    }
    const [payment] = await tx
      .select()
      .from(expensePayments)
      .where(
        and(
          eq(expensePayments.id, paymentId),
          eq(expensePayments.expenseId, expenseId),
          eq(expensePayments.businessId, businessId),
        ),
      )
      .limit(1);
    if (!payment) {
      throw new NotFoundError("Payment not found");
    }

    await tx
      .delete(registerTransactions)
      .where(
        and(
          eq(registerTransactions.referenceType, "expense_payment"),
          eq(registerTransactions.referenceId, payment.id),
          eq(registerTransactions.businessId, businessId),
        ),
      );
    await tx
      .delete(expensePayments)
      .where(
        and(
          eq(expensePayments.id, payment.id),
          eq(expensePayments.businessId, businessId),
        ),
      );

    const paid = await sumSettledInTx(tx, businessId, expenseId);
    await tx
      .update(expenses)
      .set({
        paidAmount: paid,
        paymentStatus: derivePaymentStatus(Number(expense.amount), paid),
      })
      .where(eq(expenses.id, expenseId));

    await recordAuditInTx(tx, {
      businessId,
      actorUserId: voidedBy,
      action: "expense.payment.void",
      entityType: "expense",
      entityId: expenseId,
      metadata: {
        paymentId: payment.id,
        amount: payment.amount,
        paymentMethod: payment.paymentMethod,
        paymentDate: payment.paymentDate,
        paidAmount: paid,
      },
    });
  });
}

export async function getExpenseCategories(
  businessId: number,
  includeArchived = false,
) {
  const conditions = [eq(expenseCategories.businessId, businessId)];
  if (!includeArchived) {
    conditions.push(isNull(expenseCategories.archivedAt));
  }
  return db
    .select()
    .from(expenseCategories)
    .where(and(...conditions))
    .orderBy(asc(expenseCategories.categoryName));
}

export async function createExpenseCategory(
  businessId: number,
  data: ExpenseCategoryWriteInput,
  createdBy: number,
) {
  // Only ACTIVE names collide — an archived category may be re-created.
  const [existing] = await db
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(
      and(
        eq(expenseCategories.businessId, businessId),
        eq(expenseCategories.categoryName, data.categoryName),
        isNull(expenseCategories.archivedAt),
      ),
    );
  if (existing) {
    throw new ConflictError(
      "An expense category with this name already exists",
    );
  }
  const insertedCategories = await db
    .insert(expenseCategories)
    .values({
      businessId,
      categoryName: data.categoryName,
      description: data.description ?? null,
      color: data.color ?? null,
      icon: data.icon ?? null,
    })
    .returning(categoryColumns);
  const category = insertedCategories[0];
  if (!category) {
    throw new NotFoundError("Expense category could not be created.");
  }
  await recordAudit({
    businessId,
    actorUserId: createdBy,
    action: "expense.category.create",
    entityType: "expense_category",
    entityId: category.id,
    metadata: { categoryName: category.categoryName },
  });
  return category;
}

const categoryColumns = {
  id: expenseCategories.id,
  categoryName: expenseCategories.categoryName,
  description: expenseCategories.description,
  color: expenseCategories.color,
  icon: expenseCategories.icon,
  archivedAt: expenseCategories.archivedAt,
} as const;

async function findCategory(businessId: number, id: number) {
  const [category] = await db
    .select(categoryColumns)
    .from(expenseCategories)
    .where(
      and(
        eq(expenseCategories.id, id),
        eq(expenseCategories.businessId, businessId),
      ),
    )
    .limit(1);
  if (!category) {
    throw new NotFoundError("Expense category not found");
  }
  return category;
}

/** Active-name uniqueness excluding the category being written. */
async function assertActiveNameFree(
  businessId: number,
  categoryName: string,
  excludeId: number,
) {
  const [duplicate] = await db
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(
      and(
        eq(expenseCategories.businessId, businessId),
        eq(expenseCategories.categoryName, categoryName),
        isNull(expenseCategories.archivedAt),
        ne(expenseCategories.id, excludeId),
      ),
    )
    .limit(1);
  if (duplicate) {
    throw new ConflictError(
      "An active expense category with this name already exists",
    );
  }
}

export async function updateExpenseCategory(
  businessId: number,
  id: number,
  data: ExpenseCategoryWriteInput,
  updatedBy: number,
) {
  await findCategory(businessId, id);
  await assertActiveNameFree(businessId, data.categoryName, id);
  const updatedRows = await db
    .update(expenseCategories)
    .set({
      categoryName: data.categoryName,
      description: data.description ?? null,
      color: data.color ?? null,
      icon: data.icon ?? null,
    })
    .where(
      and(
        eq(expenseCategories.id, id),
        eq(expenseCategories.businessId, businessId),
      ),
    )
    .returning(categoryColumns);
  const updated = updatedRows[0];
  if (!updated) {
    throw new NotFoundError("Expense category not found");
  }
  await recordAudit({
    businessId,
    actorUserId: updatedBy,
    action: "expense.category.update",
    entityType: "expense_category",
    entityId: id,
    metadata: { categoryName: updated.categoryName },
  });
  return updated;
}

/**
 * Soft archive — categories referenced by expenses are never removed, so
 * historical expense rows keep rendering their category. Archived names free
 * the per-business uniqueness for a fresh active category.
 */
export async function archiveExpenseCategory(
  businessId: number,
  id: number,
  archivedBy: number,
) {
  const [archived] = await db
    .update(expenseCategories)
    .set({ archivedAt: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(expenseCategories.id, id),
        eq(expenseCategories.businessId, businessId),
        isNull(expenseCategories.archivedAt),
      ),
    )
    .returning(categoryColumns);
  if (!archived) {
    // Idempotent: already archived → verify existence, else 404.
    const existing = await findCategory(businessId, id);
    return existing;
  }
  await recordAudit({
    businessId,
    actorUserId: archivedBy,
    action: "expense.category.archive",
    entityType: "expense_category",
    entityId: id,
    metadata: { categoryName: archived.categoryName },
  });
  return archived;
}

export async function restoreExpenseCategory(
  businessId: number,
  id: number,
  restoredBy: number,
) {
  const existing = await findCategory(businessId, id);
  if (!existing.archivedAt) {
    return existing; // idempotent
  }
  await assertActiveNameFree(businessId, existing.categoryName, id);
  const restoredRows = await db
    .update(expenseCategories)
    .set({ archivedAt: null })
    .where(
      and(
        eq(expenseCategories.id, id),
        eq(expenseCategories.businessId, businessId),
      ),
    )
    .returning(categoryColumns);
  const restored = restoredRows[0];
  if (!restored) {
    throw new NotFoundError("Expense category not found");
  }
  await recordAudit({
    businessId,
    actorUserId: restoredBy,
    action: "expense.category.restore",
    entityType: "expense_category",
    entityId: id,
    metadata: { categoryName: restored.categoryName },
  });
  return restored;
}
