import { and, asc, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  capitalTransactions,
  ownerProfiles,
} from "../../db/schema/ownerFinance.js";
import { journalEntries } from "../../db/schema/journalEntries.js";
import { users } from "../../db/schema/users.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAuditInTx, recordAudit } from "../../services/audit.js";
import type { Tx } from "../../services/audit.js";
import {
  isLedgerActivatedInTx,
  postJournalEntry,
  resolveCashAccountForMethod,
  todayForBusiness,
} from "../../services/ledger.js";
import { poishaToMoneyString, toMoneyString } from "../../utils/money.js";
import { roundMoney } from "../../utils/roundMoney.js";
import type {
  CapitalListQuery,
  CapitalTransactionInput,
  CreateOwnerInput,
  UpdateOwnerInput,
} from "./finance.owner.schema.js";

/**
 * Owner profiles + capital transactions (Finance & Growth Stage 4).
 *
 * Accounting treatment (approved architecture §7.5):
 *   investment    DR cash/bank/MFS   CR 3010 Owner Contributions
 *   withdrawal    DR 3020 Owner Drawings   CR cash/bank/MFS
 *   distribution  DR 3020 Owner Drawings   CR cash/bank/MFS
 * Every transaction posts to the GL (financing cash-flow category) and is
 * idempotent per row (sourceType 'owner_capital', sourceId = txn id) plus
 * client_uuid for retried submissions.
 */

// ---------------------------------------------------------------------------
// Owner profiles
// ---------------------------------------------------------------------------

export async function listOwners(businessId: number, includeInactive = false) {
  const conditions = [eq(ownerProfiles.businessId, businessId)];
  if (!includeInactive) conditions.push(eq(ownerProfiles.isActive, true));
  const owners = await db
    .select()
    .from(ownerProfiles)
    .where(and(...conditions))
    .orderBy(asc(ownerProfiles.id));

  // Per-owner capital position: Σ(investment − withdrawal − distribution).
  const positions = await db
    .select({
      ownerProfileId: capitalTransactions.ownerProfileId,
      invested: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'investment'), 0)`,
      withdrawn: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'withdrawal'), 0)`,
      distributed: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'distribution'), 0)`,
    })
    .from(capitalTransactions)
    .where(eq(capitalTransactions.businessId, businessId))
    .groupBy(capitalTransactions.ownerProfileId);
  const byOwner = new Map(positions.map((p) => [p.ownerProfileId, p]));

  return owners.map((owner) => {
    const position = byOwner.get(owner.id);
    const invested = Number(position?.invested ?? 0);
    const withdrawn = Number(position?.withdrawn ?? 0);
    const distributed = Number(position?.distributed ?? 0);
    return {
      ...owner,
      totals: {
        invested: toMoneyString(invested),
        withdrawn: toMoneyString(withdrawn),
        distributed: toMoneyString(distributed),
      },
      capitalPosition: toMoneyString(invested - withdrawn - distributed),
    };
  });
}

export async function createOwner(
  businessId: number,
  input: CreateOwnerInput,
  actorUserId: number,
) {
  if (input.userId != null) {
    // The user must exist; platform users are global identity.
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!user) throw new NotFoundError("User not found.");
    const [existing] = await db
      .select({ id: ownerProfiles.id })
      .from(ownerProfiles)
      .where(
        and(
          eq(ownerProfiles.businessId, businessId),
          eq(ownerProfiles.userId, input.userId),
          eq(ownerProfiles.isActive, true),
        ),
      )
      .limit(1);
    if (existing) {
      throw new ConflictError(
        "An active owner profile already exists for this user in this business.",
      );
    }
  }
  const [created] = await db
    .insert(ownerProfiles)
    .values({
      businessId,
      userId: input.userId ?? null,
      name: input.name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      ownershipPercent:
        input.ownershipPercent != null
          ? input.ownershipPercent.toFixed(2)
          : null,
      notes: input.notes ?? null,
      createdByUserId: actorUserId,
    })
    .returning();
  if (!created) throw new Error("Failed to create the owner profile.");
  await recordAudit({
    businessId,
    actorUserId,
    action: "finance.owner.created",
    entityType: "owner_profile",
    entityId: created.id,
    metadata: { name: created.name },
  });
  return created;
}

export async function updateOwner(
  businessId: number,
  ownerId: number,
  input: UpdateOwnerInput,
  actorUserId: number,
) {
  const [existing] = await db
    .select()
    .from(ownerProfiles)
    .where(
      and(
        eq(ownerProfiles.id, ownerId),
        eq(ownerProfiles.businessId, businessId),
      ),
    )
    .limit(1);
  if (!existing) throw new NotFoundError("Owner profile not found.");
  const [updated] = await db
    .update(ownerProfiles)
    .set({
      name: input.name ?? existing.name,
      phone: input.phone !== undefined ? input.phone : existing.phone,
      email: input.email !== undefined ? input.email : existing.email,
      ownershipPercent:
        input.ownershipPercent !== undefined
          ? input.ownershipPercent != null
            ? input.ownershipPercent.toFixed(2)
            : null
          : existing.ownershipPercent,
      notes: input.notes !== undefined ? input.notes : existing.notes,
      isActive: input.isActive ?? existing.isActive,
      updatedAt: new Date(),
    })
    .where(eq(ownerProfiles.id, ownerId))
    .returning();
  if (!updated) throw new Error("Failed to update the owner profile.");
  await recordAudit({
    businessId,
    actorUserId,
    action: "finance.owner.updated",
    entityType: "owner_profile",
    entityId: ownerId,
    metadata: { name: updated.name, isActive: updated.isActive },
  });
  return updated;
}

async function requireOwnerInBusinessTx(
  tx: Tx,
  businessId: number,
  ownerId: number,
) {
  const [owner] = await tx
    .select()
    .from(ownerProfiles)
    .where(
      and(
        eq(ownerProfiles.id, ownerId),
        eq(ownerProfiles.businessId, businessId),
      ),
    )
    .limit(1);
  if (!owner) throw new NotFoundError("Owner profile not found.");
  return owner;
}

// ---------------------------------------------------------------------------
// Capital transactions
// ---------------------------------------------------------------------------

/**
 * Record + post a capital transaction inside the caller's transaction. The
 * journal entry is posted first (needs the account resolution), then the
 * operational row is inserted and the entry's idempotency key attached.
 */
export async function recordCapitalTransactionInTx(
  tx: Tx,
  businessId: number,
  input: CapitalTransactionInput,
  actorUserId: number | null,
) {
  if (!(await isLedgerActivatedInTx(tx, businessId))) {
    throw new ConflictError(
      "The Finance ledger is not activated for this business. Run the opening-balance activation first.",
    );
  }
  const owner = await requireOwnerInBusinessTx(tx, businessId, input.ownerProfileId);
  if (!owner.isActive) {
    throw new BadRequestError("This owner profile is inactive.");
  }

  // Client idempotency: a retried submission returns the original row.
  if (input.clientUuid) {
    const [existing] = await tx
      .select()
      .from(capitalTransactions)
      .where(
        and(
          eq(capitalTransactions.clientUuid, input.clientUuid),
          eq(capitalTransactions.businessId, businessId),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.ownerProfileId !== input.ownerProfileId) {
        throw new ConflictError(
          "This transaction was already submitted for another owner.",
        );
      }
      return { transaction: existing, duplicate: true as const };
    }
  }

  const amount = roundMoney(input.amount);
  const txnDate = input.txnDate ?? (await todayForBusiness(tx, businessId));
  const isInvestment = input.type === "investment";

  // Resolve the money account: explicit payment account → method default →
  // default cash account. An explicitly given but invalid account id fails
  // loudly rather than silently posting to a default.
  const { account, paymentAccountId } = await resolveCashAccountForMethod(
    tx,
    businessId,
    input.method ?? "cash",
    { paymentAccountId: input.paymentAccountId ?? null },
  );
  if (
    input.paymentAccountId != null &&
    paymentAccountId !== input.paymentAccountId
  ) {
    throw new NotFoundError("Payment account not found for this business.");
  }

  const description =
    input.description ??
    `${isInvestment ? "Owner investment" : input.type === "withdrawal" ? "Owner withdrawal" : "Profit distribution"} — ${owner.name}`;
  const lines: Parameters<typeof postJournalEntry>[1]["lines"] = isInvestment
    ? [
        { accountId: account.id, debit: amount, description },
        { accountCode: "3010", credit: amount, description },
      ]
    : [
        { accountCode: "3020", debit: amount, description },
        { accountId: account.id, credit: amount, description },
      ];

  const { entry } = await postJournalEntry(tx, {
    businessId,
    entryDate: txnDate,
    memo: `${input.type} — ${owner.name}`,
    sourceType: "owner_capital",
    cashFlowCategory: "financing",
    lines,
    actorUserId,
  });

    const [created] = await tx
    .insert(capitalTransactions)
    .values({
      businessId,
      ownerProfileId: owner.id,
      type: input.type,
      amount: toMoneyString(amount),
      txnDate,
      paymentAccountId,
      method: input.method ?? null,
      sourceOfFunds: input.sourceOfFunds ?? null,
      reference: input.reference ?? null,
      description: input.description ?? null,
      attachmentUrl: input.attachmentUrl ?? null,
      journalEntryId: entry.id,
      clientUuid: input.clientUuid ?? null,
      createdByUserId: actorUserId,
    })
    .returning();
  if (!created) throw new Error("Failed to record the capital transaction.");

  // Attach the idempotency key to the posted entry now that the row id exists.
  await tx
    .update(journalEntries)
    .set({ sourceId: created.id })
    .where(eq(journalEntries.id, entry.id));

  await recordAuditInTx(tx, {
    businessId,
    actorUserId,
    action: "finance.capital.recorded",
    entityType: "capital_transaction",
    entityId: created.id,
    metadata: {
      type: created.type,
      amount: created.amount,
      owner: owner.name,
      entryNo: entry.entryNo,
    },
  });
  return { transaction: created, duplicate: false as const };
}

export async function recordCapitalTransaction(
  businessId: number,
  input: CapitalTransactionInput,
  actorUserId: number | null,
) {
  return db.transaction((tx) =>
    recordCapitalTransactionInTx(tx, businessId, input, actorUserId),
  );
}

export async function listCapitalTransactions(
  businessId: number,
  query: CapitalListQuery,
) {
  const conditions = [eq(capitalTransactions.businessId, businessId)];
  if (query.type) conditions.push(eq(capitalTransactions.type, query.type));
  if (query.owner_id) {
    conditions.push(eq(capitalTransactions.ownerProfileId, query.owner_id));
  }
  if (query.date_from) {
    conditions.push(gte(capitalTransactions.txnDate, query.date_from));
  }
  if (query.date_to) {
    conditions.push(lte(capitalTransactions.txnDate, query.date_to));
  }
  const where = and(...conditions);

  const [totalRow] = await db
    .select({ value: count() })
    .from(capitalTransactions)
    .where(where);
  const rows = await db
    .select({
      id: capitalTransactions.id,
      ownerProfileId: capitalTransactions.ownerProfileId,
      ownerName: ownerProfiles.name,
      type: capitalTransactions.type,
      amount: capitalTransactions.amount,
      txnDate: capitalTransactions.txnDate,
      method: capitalTransactions.method,
      reference: capitalTransactions.reference,
      description: capitalTransactions.description,
      journalEntryId: capitalTransactions.journalEntryId,
      createdAt: capitalTransactions.createdAt,
    })
    .from(capitalTransactions)
    .innerJoin(
      ownerProfiles,
      eq(ownerProfiles.id, capitalTransactions.ownerProfileId),
    )
    .where(where)
    .orderBy(desc(capitalTransactions.txnDate), desc(capitalTransactions.id))
    .limit(query.page_size)
    .offset((query.page - 1) * query.page_size);

  const total = totalRow?.value ?? 0;
  return {
    rows,
    meta: {
      page: query.page,
      pageSize: query.page_size,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.page_size)),
    },
  };
}

/**
 * Owner capital dashboard totals (documented formulas):
 *   contributed  = Σ investments
 *   returned     = Σ withdrawals (capital repayment / drawings)
 *   distributed  = Σ profit distributions
 *   position     = contributed − returned − distributed (per owner + total)
 */
export async function getCapitalSummary(businessId: number) {
  const [totals] = await db
    .select({
      contributed: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'investment'), 0)`,
      returned: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'withdrawal'), 0)`,
      distributed: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'distribution'), 0)`,
    })
    .from(capitalTransactions)
    .where(eq(capitalTransactions.businessId, businessId));

  const perOwner = await db
    .select({
      ownerProfileId: capitalTransactions.ownerProfileId,
      ownerName: ownerProfiles.name,
      invested: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'investment'), 0)`,
      withdrawn: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'withdrawal'), 0)`,
      distributed: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'distribution'), 0)`,
    })
    .from(capitalTransactions)
    .innerJoin(
      ownerProfiles,
      eq(ownerProfiles.id, capitalTransactions.ownerProfileId),
    )
    .where(eq(capitalTransactions.businessId, businessId))
    .groupBy(capitalTransactions.ownerProfileId, ownerProfiles.name);

  const contributed = Number(totals?.contributed ?? 0);
  const returned = Number(totals?.returned ?? 0);
  const distributed = Number(totals?.distributed ?? 0);

  return {
    totals: {
      contributed: toMoneyString(contributed),
      returned: toMoneyString(returned),
      distributed: toMoneyString(distributed),
      position: toMoneyString(contributed - returned - distributed),
    },
    perOwner: perOwner.map((row) => {
      const invested = Number(row.invested);
      const withdrawn = Number(row.withdrawn);
      const distributedShare = Number(row.distributed);
      return {
        ownerProfileId: row.ownerProfileId,
        ownerName: row.ownerName,
        invested: toMoneyString(invested),
        withdrawn: toMoneyString(withdrawn),
        distributed: toMoneyString(distributedShare),
        position: toMoneyString(invested - withdrawn - distributedShare),
      };
    }),
  };
}
