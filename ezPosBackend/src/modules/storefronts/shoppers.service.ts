import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { sales } from "../../db/schema/sales.js";
import { shopperSessions, shoppers } from "../../db/schema/shoppers.js";import { storefronts } from "../../db/schema/storefronts.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../utils/handleError.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";

/**
 * End-consumer ("shopper") accounts for hosted storefronts — stage 5.
 *
 * Fully isolated from ezPos user accounts: separate table, opaque bearer
 * tokens stored sha256-hashed (30-day expiry), emails unique per storefront.
 * Only enabled when the storefront's `shopper_accounts_enabled` flag is on;
 * guest checkout remains the default.
 */

const SESSION_TTL_DAYS = 30;

export interface ShopperSession {
  shopper: typeof shoppers.$inferSelect;
  token: string;
}

async function requireShoppersEnabled(storefrontId: number) {
  const [storefront] = await db
    .select({
      id: storefronts.id,
      businessId: storefronts.businessId,
      status: storefronts.status,
      enabled: storefronts.shopperAccountsEnabled,
    })
    .from(storefronts)
    .where(eq(storefronts.id, storefrontId))
    .limit(1);
  if (!storefront) throw new NotFoundError("Storefront not found.");
  if (!storefront.enabled) {
    throw new ForbiddenError(
      "This store does not offer customer accounts.",
    );
  }
  return storefront;
}

function newSessionToken(): { token: string; tokenHash: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
  };
}

async function createSession(shopperId: number): Promise<string> {
  const session = newSessionToken();
  await db.insert(shopperSessions).values({
    shopperId,
    tokenHash: session.tokenHash,
    expiresAt: session.expiresAt,
  });
  return session.token;
}

export async function registerShopper(
  storefrontId: number,
  input: {
    email: string;
    password: string;
    fullName: string;
    phone?: string | undefined;
  },
): Promise<ShopperSession> {
  const storefront = await requireShoppersEnabled(storefrontId);
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);

  try {
    const [created] = await db
      .insert(shoppers)
      .values({
        businessId: storefront.businessId,
        storefrontId,
        email,
        passwordHash,
        fullName: input.fullName,
        phone: input.phone ?? null,
      })
      .returning();
    if (!created) throw new Error("Shopper insert returned no row.");
    const token = await createSession(created.id);
    return { shopper: created, token };
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "23505"
    ) {
      throw new ConflictError(
        "An account with this email already exists. Sign in instead.",
      );
    }
    throw err;
  }
}

export async function loginShopper(
  storefrontId: number,
  input: { email: string; password: string },
): Promise<ShopperSession> {
  await requireShoppersEnabled(storefrontId);
  const email = input.email.trim().toLowerCase();
  const [shopper] = await db
    .select()
    .from(shoppers)
    .where(
      and(eq(shoppers.storefrontId, storefrontId), eq(shoppers.email, email)),
    )
    .limit(1);

  // Uniform failure — no account enumeration.
  if (
    !shopper ||
    shopper.status !== "active" ||
    !(await verifyPassword(shopper.passwordHash, input.password))
  ) {
    throw new BadRequestError("Incorrect email or password.");
  }

  const token = await createSession(shopper.id);
  return { shopper, token };
}

/** Resolves a bearer token to an active shopper of THIS storefront. */
export async function resolveShopper(
  storefrontId: number,
  token: string,
): Promise<typeof shoppers.$inferSelect | null> {
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const [row] = await db
    .select({ shopper: shoppers, expiresAt: shopperSessions.expiresAt })
    .from(shopperSessions)
    .innerJoin(shoppers, eq(shoppers.id, shopperSessions.shopperId))
    .where(
      and(
        eq(shopperSessions.tokenHash, tokenHash),
        eq(shoppers.storefrontId, storefrontId),
        eq(shoppers.status, "active"),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row.shopper;
}

/** The shopper's orders for this storefront (no cost/internal fields). */
export async function listShopperOrders(
  storefrontId: number,
  shopperId: number,
) {
  const [storefront] = await db
    .select({ businessId: storefronts.businessId })
    .from(storefronts)
    .where(eq(storefronts.id, storefrontId))
    .limit(1);
  if (!storefront) throw new NotFoundError("Storefront not found.");

  return db
    .select({
      invoiceNumber: sales.invoiceNumber,
      status: sales.status,
      paymentStatus: sales.paymentStatus,
      fulfillmentStatus: sales.fulfillmentStatus,
      total: sales.finalTotal,
      createdAt: sales.createdAt,
    })
    .from(sales)
    .where(
      and(
        eq(sales.businessId, storefront.businessId),
        eq(sales.shopperId, shopperId),
      ),
    )
    .orderBy(desc(sales.id))
    .limit(50);
}
