import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { giftCards, giftCardTransactions } from "../db/schema/giftCards.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/handleError.js";
import { roundMoney } from "../utils/roundMoney.js";
import type { DbTransaction } from "../modules/purchases/purchase.types.js";
import { postJournalEntry, isLedgerActivatedInTx, resolveCashAccountForMethod } from "./ledger.js";
import {
  recordGiftCardIssueCashInTx,
  recordGiftCardReloadCashInTx,
} from "../modules/cashRegisters/cashRegisters.service.js";

/**
 * Gift cards (Module 7): issue → redeem (partially, at checkout) → track.
 * Codes are SHA-256 hashed and shown exactly once; balances are ledger
 * sums; redemption locks the ledger FOR UPDATE inside the sale transaction.
 */

type Tx = DbTransaction;

// Unambiguous alphabet (no 0/O/1/I) for human-typed codes.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function generateGiftCardCode(): string {
  const bytes = randomBytes(12);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  // Group for readability: XXXX-XXXX-XXXX
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

function hashCode(code: string): string {
  // Normalize: strip separators/spaces, uppercase — typing variations must
  // resolve to the same card.
  return createHash("sha256")
    .update(code.replace(/[\s-]/g, "").toUpperCase())
    .digest("hex");
}

export interface IssuedGiftCard {
  id: number;
  /** The full code — shown exactly once, in this response only. */
  code: string;
  codeLast4: string;
  initialAmount: number;
  expiresAt: string | null;
}

export async function issueGiftCard(input: {
  businessId: number;
  actorUserId: number | null;
  initialAmount: number;
  expiresAt?: string | null;
  customerId?: number | null;
  note?: string | null;
  /** Paid issuance (F1-01): how the customer paid. Absent = complimentary card. */
  paymentMethod?: "cash" | "bangla_qr" | "card" | null;
  reference?: string | null;
  /** Issuer's active location — where the cash physically landed. */
  locationId?: number | null;
}): Promise<IssuedGiftCard> {
  const amount = roundMoney(input.initialAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestError("The gift card amount must be positive.");
  }
  let expiresAt: Date | null = null;
  if (input.expiresAt) {
    expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      throw new BadRequestError("The expiry must be a future date.");
    }
  }

  const code = generateGiftCardCode();
  const card = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(giftCards)
      .values({
        businessId: input.businessId,
        codeHash: hashCode(code),
        codeLast4: code.slice(-4),
        initialAmount: amount,
        expiresAt,
        customerId: input.customerId ?? null,
        issuedByUserId: input.actorUserId ?? null,
        note: input.note ?? null,
      })
      .returning({ id: giftCards.id });
    if (!created) throw new Error("Gift card insert returned no row.");
    await tx.insert(giftCardTransactions).values({
      businessId: input.businessId,
      giftCardId: created.id,
      amount,
      sourceType: "issue",
      note: "Issued",
    });

    // Paid issuance (F1-01): selling a card is a liability sale — the money
    // must reach the GL (DR cash/bank / CR 2040) and the drawer when paid
    // in cash. Redemption then debits 2040 instead of sinking it negative.
    // Complimentary issues (no paymentMethod) post nothing — no money moved.
    if (input.paymentMethod) {
      if (await isLedgerActivatedInTx(tx, input.businessId)) {
        const { account } = await resolveCashAccountForMethod(
          tx,
          input.businessId,
          input.paymentMethod,
        );
        const description = `Gift card sale — ····${code.slice(-4)}`;
        await postJournalEntry(tx, {
          businessId: input.businessId,
          memo: description,
          sourceType: "gift_card_issue",
          sourceId: created.id,
          cashFlowCategory: "operating",
          actorUserId: input.actorUserId,
          lines: [
            {
              accountId: account.id,
              debit: amount,
              locationId: input.locationId ?? null,
              description,
            },
            { accountCode: "2040", credit: amount, description },
          ],
        });
      }
      if (input.paymentMethod === "cash") {
        await recordGiftCardIssueCashInTx(
          tx,
          input.businessId,
          input.actorUserId,
          input.locationId ?? null,
          amount,
          created.id,
        );
      }
    }
    return created;
  });

  return {
    id: card.id,
    code,
    codeLast4: code.slice(-4),
    initialAmount: amount,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}

/**
 * P3 Phase 1 (F3): reloads an ACTIVE, unexpired card with customer money.
 * Follows the paid-issuance money side exactly (ledger-activation guard →
 * resolveCashAccountForMethod → postJournalEntry DR cash/bank / CR 2040 →
 * drawer cash_in when paid in cash) — one balance system, no parallel
 * tracking.
 *
 * Idempotency anchor: the reload's gift_card_transactions row id keys BOTH
 * the journal entry (sourceType 'gift_card_reload') and the drawer movement
 * (referenceType 'gift_card_reload'). Paid issuance already occupies
 * (business, 'gift_card_issue', cardId) — keying a reload on the card id
 * would make postJournalEntry silently REUSE the issuance entry (posted-entry
 * replay) and the money would never post; the per-reload row id gives every
 * reload its own idempotent key. An optional client reference adds a second
 * dedup layer via the 0082 partial unique index.
 */
export async function reloadGiftCard(input: {
  businessId: number;
  giftCardId: number;
  actorUserId: number | null;
  amount: number;
  paymentMethod: "cash" | "bangla_qr" | "card";
  reference?: string | null;
  locationId?: number | null;
}): Promise<{ giftCardId: number; codeLast4: string; amount: number; balance: number }> {
  const amount = roundMoney(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestError("The reload amount must be positive.");
  }
  const reference = input.reference?.trim() || null;

  const result = await db.transaction(async (tx) => {
    const [card] = await tx
      .select({
        id: giftCards.id,
        status: giftCards.status,
        expiresAt: giftCards.expiresAt,
        codeLast4: giftCards.codeLast4,
      })
      .from(giftCards)
      .where(
        and(
          eq(giftCards.id, input.giftCardId),
          eq(giftCards.businessId, input.businessId),
        ),
      )
      .for("update");
    if (!card) throw new NotFoundError("Gift card not found.");
    if (card.status !== "active") {
      throw new ConflictError("This gift card has been deactivated.");
    }
    if (card.expiresAt !== null && card.expiresAt.getTime() < Date.now()) {
      throw new ConflictError("This gift card has expired.");
    }

    // Duplicate-reference guard (0082 partial unique index backstops the
    // race; this pre-check turns the collision into a clear 409).
    if (reference) {
      const [dupe] = await tx
        .select({ id: giftCardTransactions.id })
        .from(giftCardTransactions)
        .where(
          and(
            eq(giftCardTransactions.businessId, input.businessId),
            eq(giftCardTransactions.giftCardId, card.id),
            eq(giftCardTransactions.reference, reference),
          ),
        )
        .limit(1);
      if (dupe) {
        throw new ConflictError(
          "This reload reference has already been used for this gift card.",
        );
      }
    }

    const [reloadRow] = await tx
      .insert(giftCardTransactions)
      .values({
        businessId: input.businessId,
        giftCardId: card.id,
        amount,
        sourceType: "reload",
        reference,
        actorUserId: input.actorUserId ?? null,
        note: `Reloaded (card ••${card.codeLast4})`,
      })
      .returning({ id: giftCardTransactions.id });
    if (!reloadRow) throw new Error("Gift card reload insert returned no row.");

    // Money side — mirrors paid issuance exactly (gift_card_issue flow).
    if (await isLedgerActivatedInTx(tx, input.businessId)) {
      const { account } = await resolveCashAccountForMethod(
        tx,
        input.businessId,
        input.paymentMethod,
      );
      const description = `Gift card reload — ····${card.codeLast4}`;
      await postJournalEntry(tx, {
        businessId: input.businessId,
        memo: description,
        sourceType: "gift_card_reload",
        sourceId: reloadRow.id,
        cashFlowCategory: "operating",
        actorUserId: input.actorUserId,
        lines: [
          {
            accountId: account.id,
            debit: amount,
            locationId: input.locationId ?? null,
            description,
          },
          { accountCode: "2040", credit: amount, description },
        ],
      });
    }
    if (input.paymentMethod === "cash") {
      await recordGiftCardReloadCashInTx(
        tx,
        input.businessId,
        input.actorUserId,
        input.locationId ?? null,
        amount,
        reloadRow.id,
      );
    }

    const rows = await tx
      .select({ amount: giftCardTransactions.amount })
      .from(giftCardTransactions)
      .where(eq(giftCardTransactions.giftCardId, card.id))
      .for("update");
    const balance = roundMoney(
      rows.reduce((sum, row) => sum + Number(row.amount), 0),
    );
    return {
      giftCardId: card.id,
      codeLast4: card.codeLast4,
      amount,
      balance,
    };
  });

  return result;
}

export interface GiftCardRedeemTarget {
  cardId: number;
  codeLast4: string;
  balance: number;
}

/** Resolves a typed code to a redeemable card + its balance. */
export async function lookupGiftCardForRedeem(
  businessId: number,
  code: string,
): Promise<GiftCardRedeemTarget> {
  const normalized = code.trim();
  if (normalized.length < 8) {
    throw new BadRequestError("Enter the full gift card code.");
  }
  const [card] = await db
    .select({
      id: giftCards.id,
      status: giftCards.status,
      expiresAt: giftCards.expiresAt,
      codeLast4: giftCards.codeLast4,
    })
    .from(giftCards)
    .where(
      and(
        eq(giftCards.businessId, businessId),
        eq(giftCards.codeHash, hashCode(normalized)),
      ),
    )
    .limit(1);
  if (!card) {
    // Unknown code — indistinguishable from a foreign card.
    throw new NotFoundError("Gift card not found.");
  }
  if (card.status !== "active") {
    throw new ConflictError("This gift card has been deactivated.");
  }
  if (card.expiresAt !== null && card.expiresAt.getTime() < Date.now()) {
    throw new ConflictError("This gift card has expired.");
  }
  const balance = await getGiftCardBalance(businessId, card.id);
  return { cardId: card.id, codeLast4: card.codeLast4, balance };
}

async function getGiftCardBalance(
  businessId: number,
  giftCardId: number,
): Promise<number> {
  const rows = await db
    .select({ amount: giftCardTransactions.amount })
    .from(giftCardTransactions)
    .where(
      and(
        eq(giftCardTransactions.businessId, businessId),
        eq(giftCardTransactions.giftCardId, giftCardId),
      ),
    );
  return roundMoney(rows.reduce((sum, row) => sum + Number(row.amount), 0));
}

/**
 * Redeems inside the sale transaction: locks the card row + its ledger,
 * verifies status/expiry/balance, and records the negative entry. An
 * overdraft aborts the whole sale.
 */
export async function redeemGiftCardInTx(
  tx: Tx,
  input: {
    businessId: number;
    code: string;
    amount: number;
    saleId: number;
    actorUserId?: number | null;
  },
): Promise<{ cardId: number; codeLast4: string; remaining: number }> {
  const amount = roundMoney(input.amount);
  if (amount <= 0) {
    throw new BadRequestError("Gift card payment amount must be positive.");
  }
  const [card] = await tx
    .select({
      id: giftCards.id,
      status: giftCards.status,
      expiresAt: giftCards.expiresAt,
      codeLast4: giftCards.codeLast4,
    })
    .from(giftCards)
    .where(
      and(
        eq(giftCards.businessId, input.businessId),
        eq(giftCards.codeHash, hashCode(input.code)),
      ),
    )
    .for("update");
  if (!card) throw new NotFoundError("Gift card not found.");
  if (card.status !== "active") {
    throw new ConflictError("This gift card has been deactivated.");
  }
  if (card.expiresAt !== null && card.expiresAt.getTime() < Date.now()) {
    throw new ConflictError("This gift card has expired.");
  }

  // Lock the ledger and verify the balance (double-redemption impossible:
  // concurrent sales serialize on the card row).
  const rows = await tx
    .select({ amount: giftCardTransactions.amount })
    .from(giftCardTransactions)
    .where(eq(giftCardTransactions.giftCardId, card.id))
    .for("update");
  const balance = roundMoney(
    rows.reduce((sum, row) => sum + Number(row.amount), 0),
  );
  if (balance < amount - 0.01) {
    throw new ConflictError(
      `Insufficient gift card balance: ৳${balance.toFixed(2)} remaining, ৳${amount.toFixed(2)} requested.`,
    );
  }
  await tx.insert(giftCardTransactions).values({
    businessId: input.businessId,
    giftCardId: card.id,
    amount: -amount,
    sourceType: "redeem",
    sourceId: input.saleId,
    actorUserId: input.actorUserId ?? null,
    note: `Redeemed on sale #${input.saleId} (card ••${card.codeLast4})`,
  });
  return {
    cardId: card.id,
    codeLast4: card.codeLast4,
    remaining: roundMoney(balance - amount),
  };
}

export async function listGiftCards(businessId: number) {
  const rows = await db
    .select({
      id: giftCards.id,
      codeLast4: giftCards.codeLast4,
      initialAmount: giftCards.initialAmount,
      status: giftCards.status,
      expiresAt: giftCards.expiresAt,
      issuedAt: giftCards.issuedAt,
      note: giftCards.note,
      balance: sql<number>`(
        SELECT COALESCE(SUM(t.amount), 0) FROM gift_card_transactions t
        WHERE t.gift_card_id = gift_cards.id
      )`,
    })
    .from(giftCards)
    .where(eq(giftCards.businessId, businessId))
    .orderBy(desc(giftCards.id))
    .limit(200);
  return rows.map((row) => ({
    ...row,
    initialAmount: Number(row.initialAmount),
    balance: Number(row.balance),
  }));
}

export async function getGiftCardDetail(businessId: number, id: number) {
  const [card] = await db
    .select({
      id: giftCards.id,
      codeLast4: giftCards.codeLast4,
      initialAmount: giftCards.initialAmount,
      status: giftCards.status,
      expiresAt: giftCards.expiresAt,
      issuedAt: giftCards.issuedAt,
      note: giftCards.note,
    })
    .from(giftCards)
    .where(and(eq(giftCards.id, id), eq(giftCards.businessId, businessId)))
    .limit(1);
  if (!card) throw new NotFoundError("Gift card not found.");
  const transactions = await db
    .select()
    .from(giftCardTransactions)
    .where(eq(giftCardTransactions.giftCardId, id))
    .orderBy(desc(giftCardTransactions.id));
  const balance = roundMoney(
    transactions.reduce((sum, t) => sum + Number(t.amount), 0),
  );
  return {
    card: { ...card, initialAmount: Number(card.initialAmount) },
    balance,
    transactions: transactions.map((t) => ({ ...t, amount: Number(t.amount) })),
  };
}

export async function setGiftCardStatus(
  businessId: number,
  id: number,
  status: "active" | "inactive",
  actorUserId: number | null,
): Promise<{ id: number; status: string }> {
  const [updated] = await db
    .update(giftCards)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(giftCards.id, id), eq(giftCards.businessId, businessId)))
    .returning({ id: giftCards.id, status: giftCards.status });
  if (!updated) throw new NotFoundError("Gift card not found.");
  void actorUserId;
  return { id: updated.id, status: updated.status };
}
