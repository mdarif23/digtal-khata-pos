import { and, eq } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { customerCredits } from "../db/schema/customerCredits.js";
import { ConflictError } from "../utils/handleError.js";
import { roundMoney } from "../utils/roundMoney.js";
import type { DbTransaction } from "../modules/purchases/purchase.types.js";

/**
 * Store credit / customer account ledger (Module 5). Positive rows grant
 * credit, negative rows consume it; the balance is SUM(amount) over the
 * ledger, so balances always reconcile. Consumers lock the customer's rows
 * FOR UPDATE inside their transaction — two concurrent checkouts cannot
 * overspend the same credit.
 */

type Tx = DbTransaction;

export async function getStoreCreditBalance(
  businessId: number,
  customerId: number,
): Promise<number> {
  const rows = await db
    .select({ amount: customerCredits.amount })
    .from(customerCredits)
    .where(
      and(
        eq(customerCredits.businessId, businessId),
        eq(customerCredits.customerId, customerId),
      ),
    );
  return roundMoney(
    rows.reduce((sum, row) => sum + Number(row.amount), 0),
  );
}

export async function grantStoreCreditInTx(
  tx: Tx,
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
  });
}

/** Locks the customer's ledger, verifies the balance, records the spend. */
export async function consumeStoreCreditInTx(
  tx: Tx,
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
  // Lock every ledger row for this customer so the balance cannot change
  // between the check and the consumption insert.
  const rows = await tx
    .select({ amount: customerCredits.amount })
    .from(customerCredits)
    .where(
      and(
        eq(customerCredits.businessId, input.businessId),
        eq(customerCredits.customerId, input.customerId),
      ),
    )
    .for("update");
  const balance = roundMoney(
    rows.reduce((sum, row) => sum + Number(row.amount), 0),
  );
  if (balance < amount - 0.01) {
    throw new ConflictError(
      `Insufficient store credit: available ৳${balance.toFixed(2)}, tried to use ৳${amount.toFixed(2)}.`,
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
