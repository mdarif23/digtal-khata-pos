import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { storefronts } from "../../db/schema/storefronts.js";
import { storefrontDomains } from "../../db/schema/storefrontDomains.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../utils/handleError.js";
import {
  assertFeature,
  assertWithinCustomDomainLimit,
  getEntitlements,
} from "../../services/entitlements.js";
import { env } from "../../config/env.js";
import { isUniqueViolation, requireStorefront } from "./storefronts.service.js";

/**
 * Custom-domain flow: add (pending + TXT token) → DNS proof → verified →
 * the edge may provision TLS. Nothing is ever reported connected before
 * verification succeeds; ssl_status tracks certificate issuance separately.
 */

const DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Normalizes a customer-supplied custom domain: lowercases, strips scheme,
 * port, path and a single leading "www." is KEPT (www.abcfashion.com is a
 * distinct, valid host customers may attach).
 */
export function normalizeDomain(raw: string): string {
  let domain = raw.trim().toLowerCase();
  domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  domain = domain.split("/")[0] ?? "";
  domain = domain.split(":")[0] ?? "";
  domain = domain.replace(/\.+$/, "");
  if (!domain) {
    throw new BadRequestError("Enter a domain like www.example.com.");
  }
  if (!/^[\x21-\x7e]+$/.test(domain)) {
    throw new BadRequestError(
      "Use the ASCII (punycode) form of the domain.",
    );
  }
  if (domain.length > 253 || !DOMAIN_PATTERN.test(domain)) {
    throw new BadRequestError("Enter a valid domain like www.example.com.");
  }
  if (domain === env.storefrontBaseDomain) {
    throw new BadRequestError("That domain is operated by ezPos.");
  }
  // No claiming platform subdomains as "custom" domains — that would allow
  // hijacking another tenant's abc.ezpos.store host.
  if (domain.endsWith(`.${env.storefrontBaseDomain}`)) {
    throw new BadRequestError(
      "Use your own domain — ezPos subdomains are assigned automatically.",
    );
  }
  return domain;
}

function verificationRecordName(domain: string): string {
  return `_ezpos-verify.${domain}`;
}

export async function listDomains(businessId: number, storefrontId: number) {
  await requireStorefront(businessId, storefrontId);
  return db
    .select({
      id: storefrontDomains.id,
      kind: storefrontDomains.kind,
      domain: storefrontDomains.domain,
      status: storefrontDomains.status,
      sslStatus: storefrontDomains.sslStatus,
      isPrimary: storefrontDomains.isPrimary,
      verificationToken: storefrontDomains.verificationToken,
      lastError: storefrontDomains.lastError,
      lastCheckedAt: storefrontDomains.lastCheckedAt,
      createdAt: storefrontDomains.createdAt,
    })
    .from(storefrontDomains)
    .where(eq(storefrontDomains.storefrontId, storefrontId))
    .orderBy(desc(storefrontDomains.isPrimary), asc(storefrontDomains.id));
}

export async function addCustomDomain(
  businessId: number,
  storefrontId: number,
  rawDomain: string,
): Promise<typeof storefrontDomains.$inferSelect> {
  const entitlements = await getEntitlements(businessId);
  assertFeature(entitlements, "storefrontCustomDomains");
  await requireStorefront(businessId, storefrontId);

  const domain = normalizeDomain(rawDomain);
  const verificationToken = randomBytes(24).toString("base64url");

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${businessId})`);
      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(storefrontDomains)
        .innerJoin(
          storefronts,
          eq(storefronts.id, storefrontDomains.storefrontId),
        )
        .where(
          and(
            eq(storefronts.businessId, businessId),
            eq(storefrontDomains.kind, "custom"),
          ),
        );
      assertWithinCustomDomainLimit(entitlements, countRow?.count ?? 0);

      const [created] = await tx
        .insert(storefrontDomains)
        .values({
          storefrontId,
          kind: "custom",
          domain,
          verificationToken,
          status: "pending",
        })
        .returning();
      if (!created) throw new Error("Domain insert returned no row.");
      return created;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Deliberately neutral: do not reveal whether another tenant owns it.
      throw new ConflictError(
        "This domain cannot be added. If you own it, contact ezPos support.",
      );
    }
    throw err;
  }
}

/**
 * Checks DNS for the TXT verification record. Never throws on DNS failure —
 * the outcome is recorded on the row so the portal can show progress.
 */
export async function verifyDomain(
  businessId: number,
  storefrontId: number,
  domainId: number,
): Promise<{ verified: boolean; domain: typeof storefrontDomains.$inferSelect }> {
  await requireStorefront(businessId, storefrontId);
  const [row] = await db
    .select()
    .from(storefrontDomains)
    .where(
      and(
        eq(storefrontDomains.id, domainId),
        eq(storefrontDomains.storefrontId, storefrontId),
        eq(storefrontDomains.kind, "custom"),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Domain not found.");
  if (row.status === "verified") {
    return { verified: true, domain: row };
  }
  if (!row.verificationToken) {
    throw new ConflictError("This domain has no verification token.");
  }

  let verified = false;
  let lastError: string | null = null;
  try {
    const resolver = new Resolver();
    const records = await resolver.resolveTxt(
      verificationRecordName(row.domain),
    );
    const flat = records.map((parts) => parts.join(""));
    verified = flat.includes(row.verificationToken);
    if (!verified) {
      lastError =
        "Verification record found but the value does not match yet.";
    }
  } catch (err) {
    lastError =
      "Verification record not found yet. DNS changes can take up to 24-48 hours.";
    console.error("Domain verification DNS lookup failed:", err);
  }

  const [updated] = await db
    .update(storefrontDomains)
    .set({
      status: verified ? "verified" : row.status,
      verifiedAt: verified ? new Date() : row.verifiedAt,
      lastError: verified ? null : lastError,
      lastCheckedAt: new Date(),
    })
    .where(eq(storefrontDomains.id, row.id))
    .returning();
  if (!updated) throw new Error("Domain update returned no row.");
  return { verified, domain: updated };
}

export async function makePrimaryDomain(
  businessId: number,
  storefrontId: number,
  domainId: number,
): Promise<void> {
  await requireStorefront(businessId, storefrontId);
  const [row] = await db
    .select({ id: storefrontDomains.id, status: storefrontDomains.status })
    .from(storefrontDomains)
    .where(
      and(
        eq(storefrontDomains.id, domainId),
        eq(storefrontDomains.storefrontId, storefrontId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Domain not found.");
  if (row.status !== "verified") {
    throw new ForbiddenError(
      "Only a verified domain can be made the primary domain.",
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(storefrontDomains)
      .set({ isPrimary: false })
      .where(eq(storefrontDomains.storefrontId, storefrontId));
    await tx
      .update(storefrontDomains)
      .set({ isPrimary: true })
      .where(eq(storefrontDomains.id, domainId));
  });
}

export async function removeDomain(
  businessId: number,
  storefrontId: number,
  domainId: number,
): Promise<void> {
  await requireStorefront(businessId, storefrontId);
  const deleted = await db
    .delete(storefrontDomains)
    .where(
      and(
        eq(storefrontDomains.id, domainId),
        eq(storefrontDomains.storefrontId, storefrontId),
        eq(storefrontDomains.kind, "custom"),
      ),
    )
    .returning({ id: storefrontDomains.id });
  if (deleted.length === 0) {
    throw new NotFoundError("Domain not found.");
  }
}
