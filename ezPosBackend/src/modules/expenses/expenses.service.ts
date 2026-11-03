import { expenseCategories } from "../../db/schema/expenseCategories.js";
import { expenses } from "../../db/schema/expenses.js";
import { sales } from "../../db/schema/sales.js";
import { db } from "../../db/schema/index.js";
import { and, asc, desc, eq } from "drizzle-orm";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/handleError.js";
import type { ExpenseWriteInput } from "./expenses.schema.js";
type NewExpense = typeof expenses.$inferInsert;

// Every function takes the caller's server-verified businessId (from
// requireBusinessContext) and scopes all reads and writes to it.

/** Channel/order attribution must reference rows the business owns. */
async function assertAttribution(businessId: number, data: ExpenseWriteInput) {
  if (data.sale_id != null) {
    const [sale] = await db
      .select({ id: sales.id })
      .from(sales)
      .where(and(eq(sales.id, data.sale_id), eq(sales.businessId, businessId)))
      .limit(1);
    if (!sale) {
      throw new BadRequestError("Linked order does not exist for this business.");
    }
  }
}

function toExpenseValues(
  businessId: number,
  locationId: number,
  data: ExpenseWriteInput,
): NewExpense {
  return {
    businessId,
    locationId,
    title: data.title,
    expenseDate: data.expense_date,
    amount: data.amount,
    categoryId: data.category_id,
    paymentMethod: data.payment_method,
    referenceNo: data.reference_no ?? null,
    note: data.note ?? null,
    channel: data.channel ?? null,
    saleId: data.sale_id ?? null,
  };
}

export async function createExpense(
  businessId: number,
  locationId: number,
  data: ExpenseWriteInput,
) {
  await assertAttribution(businessId, data);
  const [expense] = await db
    .insert(expenses)
    .values(toExpenseValues(businessId, locationId, data))
    .returning();
  return expense;
}

export async function updateExpense(
  businessId: number,
  id: number,
  data: ExpenseWriteInput,
) {
  await assertAttribution(businessId, data);
  // Expense edits never move an expense between locations — the owning
  // location stays whatever it was created with.
  const [expense] = await db
    .update(expenses)
    .set({
      title: data.title,
      expenseDate: data.expense_date,
      amount: data.amount,
      categoryId: data.category_id,
      paymentMethod: data.payment_method,
      referenceNo: data.reference_no ?? null,
      note: data.note ?? null,
      channel: data.channel ?? null,
      saleId: data.sale_id ?? null,
    })
    .where(and(eq(expenses.id, id), eq(expenses.businessId, businessId)))
    .returning();
  if (!expense) {
    throw new NotFoundError("Expense not found");
  }
  return expense;
}

export async function deleteExpense(businessId: number, id: number) {
  const [deleted] = await db
    .delete(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.businessId, businessId)))
    .returning({ id: expenses.id });
  if (!deleted) {
    throw new NotFoundError("Expense not found");
  }
  return deleted;
}

export async function getExpenseCategories(businessId: number) {
  return db
    .select()
    .from(expenseCategories)
    .where(eq(expenseCategories.businessId, businessId))
    .orderBy(asc(expenseCategories.categoryName));
}

export async function createExpenseCategory(
  businessId: number,
  categoryName: string,
) {
  const [existing] = await db
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(
      and(
        eq(expenseCategories.businessId, businessId),
        eq(expenseCategories.categoryName, categoryName),
      ),
    );
  if (existing) {
    throw new ConflictError("An expense category with this name already exists");
  }
  const [category] = await db
    .insert(expenseCategories)
    .values({ businessId, categoryName })
    .returning({
      id: expenseCategories.id,
      categoryName: expenseCategories.categoryName,
    });
  return category;
}

export async function getExpenses(businessId: number) {
  return db
    .select({
      id: expenses.id,
      title: expenses.title,
      amount: expenses.amount,
      categoryId: expenses.categoryId,
      categoryName: expenseCategories.categoryName,
      paymentMethod: expenses.paymentMethod,
      referenceNo: expenses.referenceNo,
      note: expenses.note,
      channel: expenses.channel,
      saleId: expenses.saleId,
      expenseDate: expenses.expenseDate,
      createdAt: expenses.createdAt,
    })
    .from(expenses)
    .leftJoin(
      expenseCategories,
      and(
        eq(expenses.categoryId, expenseCategories.id),
        eq(expenseCategories.businessId, businessId),
      ),
    )
    .where(eq(expenses.businessId, businessId))
    .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt));
}
