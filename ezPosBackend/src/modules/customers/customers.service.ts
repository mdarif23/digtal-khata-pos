import { and, eq, inArray, sql } from "drizzle-orm";
import { customers } from "../../db/schema/customers.js";
import { db } from "../../db/schema/index.js";
import { salePayments } from "../../db/schema/salePayments.js";
import { sales } from "../../db/schema/sales.js";
import { recordAudit } from "../../services/audit.js";
import { NotFoundError } from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import type { DbTransaction } from "../purchases/purchase.types.js";

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
  email: string | null = null,
  creditLimit: number | null = null,
) {
  const [customer] = await db
    .insert(customers)
    .values({ businessId, name, phone, address, email, creditLimit })
    .returning();
  return customer;
}

/** E1-004: customer contact details were permanently uncorrectable.
 * E3-001/E3-007: undefined means "field not provided" → the column is
 * PRESERVED (drizzle skips undefined keys); null means an explicit clear.
 * The old mapping turned omitted email/address/creditLimit into null and
 * every Contacts-page edit silently wiped the customer's credit limit and
 * online-order email/address. */
export async function updateCustomer(
  businessId: number,
  customerId: number,
  data: {
    name: string;
    phone: string;
    email?: string | null | undefined;
    address?: string | null | undefined;
    creditLimit?: number | null | undefined;
  },
  actorUserId: number | null,
) {
  const [updated] = await db
    .update(customers)
    .set({
      name: data.name,
      phone: data.phone,
      email: data.email,
      address: data.address,
      creditLimit: data.creditLimit,
    })
    .where(
      and(eq(customers.id, customerId), eq(customers.businessId, businessId)),
    )
    .returning();
  if (!updated) {
    throw new NotFoundError("Customer not found");
  }
  void recordAudit({
    businessId,
    actorUserId,
    action: "customer.update",
    entityType: "customer",
    entityId: customerId,
    metadata: {
      name: updated.name,
      phone: updated.phone,
      creditLimit:
        updated.creditLimit == null ? null : Number(updated.creditLimit),
    },
  });
  return updated;
}

/**
 * P3 Phase 1 (F2): the customer's authoritative outstanding receivable —
 * Σ(final_total − payments − refunds) over completed sales, the same
 * recomputation the due-management screens display (the denormalized
 * sales.due_amount is a dual truth, never the credit authority). Runs on the
 * caller's transaction so the credit-limit guard in createSale sees a
 * transaction-consistent figure under the customer row lock.
 */
export async function getCustomerOutstandingInTx(
  tx: DbTransaction | typeof db,
  businessId: number,
  customerId: number,
): Promise<number> {
  // Correlated subqueries reference the outer FROM ("sales") with PLAIN
  // table-qualified text — interpolating drizzle columns (${sales.id}) here
  // renders as the UNQUALIFIED "id", which inside the subquery binds to
  // sale_payments.id / sale_refunds.id and silently corrupts the sum.
  // F2-003: each sale's component is clamped at 0 — a fully-refunded PAID
  // sale contributes payments − refunds = 0 to truth, but the naive sum
  // subtracted BOTH the payment and the refund from final_total
  // (100 − 100 − 100 = −100), driving the outstanding negative and letting
  // the credit-limit guard hand out unlimited extra credit after one
  // refunded paid sale.
  const [row] = await tx
    .select({
      outstanding: sql<number>`COALESCE(SUM(GREATEST(
        sales.final_total
        - COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.sale_id = sales.id AND sp.business_id = sales.business_id), 0)
        - COALESCE((SELECT SUM(sr.refund_total) FROM sale_refunds sr WHERE sr.sale_id = sales.id AND sr.business_id = sales.business_id), 0),
        0
      )), 0)`.as("outstanding"),
    })
    .from(sales)
    .where(
      and(
        eq(sales.businessId, businessId),
        eq(sales.customerId, customerId),
        inArray(sales.status, ["completed", "refunded"]),
      ),
    );
  return roundMoney(Number(row?.outstanding ?? 0));
}

/**
 * P3 Phase 1 (F2): limit / outstanding / available for the customer profile
 * and the POS due tender. NULL limit = unlimited (available: null).
 */
export async function getCustomerCreditSummary(
  businessId: number,
  customerId: number,
): Promise<{
  creditLimit: number | null;
  outstanding: number;
  available: number | null;
}> {
  const [customer] = await db
    .select({ id: customers.id, creditLimit: customers.creditLimit })
    .from(customers)
    .where(
      and(eq(customers.id, customerId), eq(customers.businessId, businessId)),
    )
    .limit(1);
  if (!customer) {
    throw new NotFoundError(`Customer with ID ${customerId} not found.`);
  }
  const outstanding = await getCustomerOutstandingInTx(
    db,
    businessId,
    customerId,
  );
  const creditLimit =
    customer.creditLimit == null ? null : Number(customer.creditLimit);
  return {
    creditLimit,
    outstanding,
    available:
      creditLimit == null ? null : roundMoney(creditLimit - outstanding),
  };
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
