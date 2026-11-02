import { and, eq, inArray, sql } from "drizzle-orm";
import { customers } from "../../db/schema/customers.js";
import { db } from "../../db/schema/index.js";
import { salePayments } from "../../db/schema/salePayments.js";
import { sales } from "../../db/schema/sales.js";

// Every function takes the caller's server-verified businessId (from
// requireBusinessContext) and scopes all reads and writes to it.
export async function getCustomers(businessId: number) {
  return db
    .select()
    .from(customers)
    .where(eq(customers.businessId, businessId));
}
export async function createCustomer(
  businessId: number,
  name: string,
  phone: string,
  address: string,
) {
  const [customer] = await db
    .insert(customers)
    .values({ businessId, name, phone, address })
    .returning();
  return customer;
}
export async function getCustomerDueSummary(businessId: number) {
  const paymentSummaryCte = db.$with("payment_summary").as(
    db
      .select({
        saleId: salePayments.saleId,
        totalPaid: sql<number>`SUM(${salePayments.amount})`.as(
          "total_paid",
        ),
      })
      .from(salePayments)
      .where(eq(salePayments.businessId, businessId))
      .groupBy(salePayments.saleId),
  );
  return db
    .with(paymentSummaryCte)
    .select({
      customerId: customers.id,
      // sales.due_amount is maintained by the sale/refund flows (refunds
      // reduce it), so refunds net off receivables here. For un-refunded
      // sales it equals finalTotal − payments.
      totalDue:
        sql<number>`COALESCE(SUM(${sales.dueAmount}),0)`.as(
          "TOTAL_DUE",
        ),
      totalPaid:
        sql<number>`COALESCE(SUM(${paymentSummaryCte.totalPaid}), 0)`.as(
          "TOTAL_PAID",
        ),
      totalAmount: sql<number>`COALESCE(SUM(${sales.finalTotal}), 0)`.as(
        "TOTAL_AMOUNT",
      ),
    })
    .from(customers)
    .innerJoin(
      sales,
      and(eq(sales.customerId, customers.id), eq(sales.businessId, businessId)),
    )
    .leftJoin(paymentSummaryCte, eq(paymentSummaryCte.saleId, sales.id))
    .where(
      and(
        eq(customers.businessId, businessId),
        inArray(sales.paymentStatus, ["unpaid", "partial"]),
      ),
    )
    .groupBy(customers.id)
    .having(
      sql`COALESCE(SUM(${sales.dueAmount}),0) > 0`,
    );
}

import { NotFoundError } from "../../utils/handleError.js";
import { getStoreCreditBalance } from "../../services/storeCredit.js";

/**
 * Spendable store credit balance for one customer (Module 5). The customer
 * must belong to the caller's business; a foreign id is indistinguishable
 * from a missing one.
 */
export async function getCustomerStoreCredit(
  businessId: number,
  customerId: number,
): Promise<number> {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(eq(customers.id, customerId), eq(customers.businessId, businessId)),
    )
    .limit(1);
  if (!customer) {
    throw new NotFoundError(`Customer with ID ${customerId} not found.`);
  }
  return getStoreCreditBalance(businessId, customerId);
}
