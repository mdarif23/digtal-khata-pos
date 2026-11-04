import { expenseTemplates } from "../../db/schema/expenseTemplates.js";
import { expenses } from "../../db/schema/expenses.js";
import { expenseCategories } from "../../db/schema/expenseCategories.js";
import { db } from "../../db/schema/index.js";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import { recordAudit, recordAuditInTx } from "../../services/audit.js";
import type { ExpenseTemplateWriteInput } from "./expenses.schema.js";

/**
 * Recurring expense templates (Phase 6). Generation is idempotent by
 * transactional state: the same transaction that inserts an expense advances
 * next_generation_date under a FOR UPDATE row lock, so concurrent or retried
 * runs can never produce the same period twice. Generated expenses are
 * ALWAYS unpaid — generation never touches the settlement ledger.
 */

const MAX_CATCH_UP_PERIODS = 24;

type Frequency = "weekly" | "monthly" | "yearly";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/**
 * Advance one period without drift: monthly/yearly steps keep the anchor
 * day (clamped to the target month's length) instead of letting Postgres
 * month arithmetic walk 31st → 28th → 28th.
 */
export function advancePeriod(
  dateStr: string,
  frequency: string,
  anchorDay: number,
): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (frequency === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth() + 1; // 1-based
  if (frequency === "monthly") {
    if (month === 12) {
      year += 1;
      month = 1;
    } else {
      month += 1;
    }
  } else {
    year += 1;
  }
  const day = Math.min(anchorDay, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function templateColumns() {
  return {
    id: expenseTemplates.id,
    title: expenseTemplates.title,
    amount: expenseTemplates.amount,
    categoryId: expenseTemplates.categoryId,
    categoryName: expenseCategories.categoryName,
    paymentMethod: expenseTemplates.paymentMethod,
    payee: expenseTemplates.payee,
    note: expenseTemplates.note,
    locationId: expenseTemplates.locationId,
    channel: expenseTemplates.channel,
    frequency: expenseTemplates.frequency,
    startDate: expenseTemplates.startDate,
    endDate: expenseTemplates.endDate,
    nextGenerationDate: expenseTemplates.nextGenerationDate,
    lastGeneratedDate: expenseTemplates.lastGeneratedDate,
    isActive: expenseTemplates.isActive,
    createdAt: expenseTemplates.createdAt,
  };
}

function templateBaseQuery(businessId: number, includeInactive: boolean) {
  const conditions = [eq(expenseTemplates.businessId, businessId)];
  if (!includeInactive) {
    conditions.push(eq(expenseTemplates.isActive, true));
  }
  return db
    .select(templateColumns())
    .from(expenseTemplates)
    .leftJoin(
      expenseCategories,
      and(
        eq(expenseTemplates.categoryId, expenseCategories.id),
        eq(expenseCategories.businessId, businessId),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(expenseTemplates.nextGenerationDate))
    .$dynamic();
}

export async function listExpenseTemplates(
  businessId: number,
  includeInactive = false,
) {
  return templateBaseQuery(businessId, includeInactive);
}

function validateTemplateInput(data: ExpenseTemplateWriteInput) {
  if (data.end_date && data.end_date < data.start_date) {
    throw new BadRequestError("The end date must be on or after the start date.");
  }
}

export async function createExpenseTemplate(
  businessId: number,
  createdBy: number,
  data: ExpenseTemplateWriteInput,
) {
  validateTemplateInput(data);
  const [template] = await db
    .insert(expenseTemplates)
    .values({
      businessId,
      title: data.title,
      amount: data.amount,
      categoryId: data.category_id,
      paymentMethod: data.payment_method,
      payee: data.payee ?? null,
      note: data.note ?? null,
      locationId: data.location_id ?? null,
      channel: data.channel ?? null,
      frequency: data.frequency,
      startDate: data.start_date,
      endDate: data.end_date ?? null,
      nextGenerationDate: data.start_date,
      isActive: true,
      createdBy,
    })
    .returning({ id: expenseTemplates.id });
  const createdTemplate = template;
  if (!createdTemplate) {
    throw new NotFoundError("Expense template could not be created.");
  }
  await recordAudit({
    businessId,
    actorUserId: createdBy,
    action: "expense.template.create",
    entityType: "expense_template",
    entityId: createdTemplate.id,
    metadata: {
      title: data.title,
      amount: data.amount,
      frequency: data.frequency,
    },
  });
  return template;
}

export async function updateExpenseTemplate(
  businessId: number,
  id: number,
  updatedBy: number,
  data: ExpenseTemplateWriteInput,
) {
  validateTemplateInput(data);
  const [template] = await db
    .select({ id: expenseTemplates.id })
    .from(expenseTemplates)
    .where(
      and(
        eq(expenseTemplates.id, id),
        eq(expenseTemplates.businessId, businessId),
      ),
    )
    .limit(1);
  if (!template) {
    throw new NotFoundError("Expense template not found");
  }
  const [updated] = await db
    .update(expenseTemplates)
    .set({
      title: data.title,
      amount: data.amount,
      categoryId: data.category_id,
      paymentMethod: data.payment_method,
      payee: data.payee ?? null,
      note: data.note ?? null,
      locationId: data.location_id ?? null,
      channel: data.channel ?? null,
      frequency: data.frequency,
      startDate: data.start_date,
      endDate: data.end_date ?? null,
      isActive: data.is_active ?? true,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(expenseTemplates.id, id),
        eq(expenseTemplates.businessId, businessId),
      ),
    )
    .returning({ id: expenseTemplates.id, isActive: expenseTemplates.isActive });
  const updatedTemplate = updated;
  if (!updatedTemplate) {
    throw new NotFoundError("Expense template not found");
  }
  await recordAudit({
    businessId,
    actorUserId: updatedBy,
    action: "expense.template.update",
    entityType: "expense_template",
    entityId: id,
    metadata: { title: data.title, isActive: updatedTemplate.isActive },
  });
  return updated;
}

export async function archiveExpenseTemplate(
  businessId: number,
  id: number,
  archivedBy: number,
) {
  const [template] = await db
    .update(expenseTemplates)
    .set({ isActive: false, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(expenseTemplates.id, id),
        eq(expenseTemplates.businessId, businessId),
      ),
    )
    .returning({ id: expenseTemplates.id, isActive: expenseTemplates.isActive });
  if (!template) {
    throw new NotFoundError("Expense template not found");
  }
  await recordAudit({
    businessId,
    actorUserId: archivedBy,
    action: "expense.template.archive",
    entityType: "expense_template",
    entityId: id,
    metadata: {},
  });
  return template;
}

/**
 * Generate every due period for one template. Idempotent: the expense
 * insert and the next_generation_date advance share one transaction with a
 * row lock, so a retry (manual, scheduler overlap, crash recovery) resumes
 * from the advanced date instead of duplicating a period.
 */
export async function generateForTemplate(
  businessId: number,
  templateId: number,
): Promise<number> {
  const cutoff = today();
  return db.transaction(async (tx) => {
    const [template] = await tx
      .select()
      .from(expenseTemplates)
      .where(
        and(
          eq(expenseTemplates.id, templateId),
          eq(expenseTemplates.businessId, businessId),
          eq(expenseTemplates.isActive, true),
        ),
      )
      .for("update")
      .limit(1);
    if (!template) {
      throw new NotFoundError("Active expense template not found");
    }

    const anchorDay = Number(template.startDate.slice(8, 10));
    let next = template.nextGenerationDate;
    let lastGenerated: string | null = null;
    let count = 0;
    while (
      next <= cutoff &&
      (!template.endDate || next <= template.endDate) &&
      count < MAX_CATCH_UP_PERIODS
    ) {
      const inserted = await tx
        .insert(expenses)
        .values({
          businessId,
          locationId: template.locationId,
          title: template.title,
          expenseDate: next,
          amount: Number(template.amount),
          payee: template.payee,
          categoryId: template.categoryId,
          paymentMethod: template.paymentMethod,
          // reference_no deliberately left NULL — the (business, method,
          // reference) settlement uniqueness must not constrain templates.
          note:
            template.note ??
            `Generated from the recurring template “${template.title}”`,
          channel: template.channel,
          // NEVER auto-paid: generated expenses are pure dues.
          paidAmount: 0,
          paymentStatus: "unpaid",
          createdBy: template.createdBy,
          updatedBy: template.createdBy,
        })
        .returning({ id: expenses.id });
      const expense = inserted[0];
      if (!expense) {
        throw new NotFoundError("Generated expense could not be created.");
      }
      await recordAuditInTx(tx, {
        businessId,
        actorUserId: template.createdBy,
        action: "expense.generate",
        entityType: "expense",
        entityId: expense.id,
        metadata: {
          templateId,
          templateTitle: template.title,
          period: next,
          amount: template.amount,
        },
      });
      lastGenerated = next;
      next = advancePeriod(next, template.frequency, anchorDay);
      count += 1;
    }

    if (count > 0) {
      await tx
        .update(expenseTemplates)
        .set({
          nextGenerationDate: next,
          lastGeneratedDate: lastGenerated,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(expenseTemplates.id, templateId));
    }
    return count;
  });
}

/**
 * Generate across every active business — the scheduler + manual "run now"
 * entry point. Each template is isolated: one failing template never blocks
 * the others.
 */
export async function generateDueExpensesForAllBusinesses(): Promise<{
  templatesRun: number;
  expensesGenerated: number;
}> {
  const dueTemplates = await db
    .select({
      id: expenseTemplates.id,
      businessId: expenseTemplates.businessId,
    })
    .from(expenseTemplates)
    .where(
      and(
        eq(expenseTemplates.isActive, true),
        lte(expenseTemplates.nextGenerationDate, today()),
      ),
    );
  let expensesGenerated = 0;
  let templatesRun = 0;
  for (const template of dueTemplates) {
    try {
      const count = await generateForTemplate(template.businessId, template.id);
      templatesRun += 1;
      expensesGenerated += count;
    } catch (err) {
      console.error(
        `[scheduler] expense template ${String(template.id)} generation failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { templatesRun, expensesGenerated };
}
