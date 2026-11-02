import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { storefronts } from "../../db/schema/storefronts.js";
import { storefrontDomains } from "../../db/schema/storefrontDomains.js";
import { storefrontPublishVersions } from "../../db/schema/storefrontPublishVersions.js";
import { storefrontProductVisibility } from "../../db/schema/storefrontProductVisibility.js";
import { businesses } from "../../db/schema/businesses.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../utils/handleError.js";
import {
  assertFeature,
  getEntitlements,
} from "../../services/entitlements.js";
import { storefrontThemeConfigSchema } from "./themeConfig.schema.js";
import { getTheme } from "./themes.catalog.js";

/**
 * Hosted storefront lifecycle: create → draft → publish (versioned) →
 * suspend/archive. Every function is business-scoped; the caller (route
 * chain) has already verified membership, full access and permissions.
 */

// ---------------------------------------------------------------------------
// Subdomain rules
// ---------------------------------------------------------------------------

const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

/** Hosts owned by the platform that tenants must never claim. */
export const RESERVED_SUBDOMAINS = new Set([
  "www",
  "api",
  "app",
  "admin",
  "cdn",
  "static",
  "assets",
  "mail",
  "smtp",
  "ftp",
  "docs",
  "status",
  "support",
  "help",
  "blog",
  "shop",
  "store",
  "dashboard",
  "account",
  "accounts",
  "portal",
  "saas-admin",
  "ezpos",
  "platform",
  "null",
  "undefined",
]);

export function normalizeSubdomain(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Validates and normalizes a requested subdomain. Throws BadRequestError
 * with a user-facing message when the name is not DNS-safe or reserved.
 */
export function validateSubdomain(raw: string): string {
  const subdomain = normalizeSubdomain(raw);
  if (subdomain.length < 3 || subdomain.length > 63) {
    throw new BadRequestError(
      "Subdomain must be between 3 and 63 characters.",
    );
  }
  if (!SUBDOMAIN_PATTERN.test(subdomain)) {
    throw new BadRequestError(
      "Use only lowercase letters, numbers and hyphens (no leading/trailing hyphen).",
    );
  }
  if (RESERVED_SUBDOMAINS.has(subdomain)) {
    throw new BadRequestError("That subdomain is reserved. Choose another.");
  }
  return subdomain;
}

/** pg unique-violation code, unwrapping drizzle's DrizzleQueryError cause. */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current !== null && current !== undefined && depth < 4; depth += 1) {
    const candidate = current as { code?: string; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug.length >= 3 ? slug : "store";
}

async function subdomainTaken(subdomain: string): Promise<boolean> {
  const [row] = await db
    .select({ id: storefronts.id })
    .from(storefronts)
    .where(eq(storefronts.subdomain, subdomain))
    .limit(1);
  return row !== undefined;
}

/**
 * Resolves the subdomain for a new storefront: the customer's choice, or a
 * slug derived from the business name with numeric suffixes when taken.
 */
export async function pickSubdomain(
  businessId: number,
  requested: string | undefined,
): Promise<string> {
  if (requested !== undefined) {
    const subdomain = validateSubdomain(requested);
    if (await subdomainTaken(subdomain)) {
      throw new ConflictError("That subdomain is already taken.");
    }
    return subdomain;
  }

  const [business] = await db
    .select({ slug: businesses.slug })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!business) throw new NotFoundError("Business not found.");

  const base = slugify(business.slug);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (!(await subdomainTaken(candidate))) return candidate;
  }
  throw new ConflictError(
    "Could not find a free subdomain. Please choose one manually.",
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function requireStorefront(
  businessId: number,
  storefrontId: number,
): Promise<typeof storefronts.$inferSelect> {
  const [row] = await db
    .select()
    .from(storefronts)
    .where(
      and(
        eq(storefronts.id, storefrontId),
        eq(storefronts.businessId, businessId),
        ne(storefronts.status, "archived"),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Storefront not found.");
  return row;
}

export async function listStorefronts(businessId: number) {
  return db
    .select({
      id: storefronts.id,
      name: storefronts.name,
      subdomain: storefronts.subdomain,
      status: storefronts.status,
      themeId: storefronts.themeId,
      publishedVersionId: storefronts.publishedVersionId,
      publishedAt: storefronts.publishedAt,
      createdAt: storefronts.createdAt,
      updatedAt: storefronts.updatedAt,
      publishedProductCount: sql<number>`(
        select count(*)::int from ${storefrontProductVisibility}
        where ${storefrontProductVisibility.storefrontId} = ${storefronts.id}
          and ${storefrontProductVisibility.published} = true
      )`,
    })
    .from(storefronts)
    .where(
      and(
        eq(storefronts.businessId, businessId),
        ne(storefronts.status, "archived"),
      ),
    )
    .orderBy(desc(storefronts.id))
    .limit(50);
}

export async function getStorefrontDetail(businessId: number, storefrontId: number) {
  const storefront = await requireStorefront(businessId, storefrontId);
  const [domains, version] = await Promise.all([
    db
      .select({
        id: storefrontDomains.id,
        kind: storefrontDomains.kind,
        domain: storefrontDomains.domain,
        status: storefrontDomains.status,
        sslStatus: storefrontDomains.sslStatus,
        isPrimary: storefrontDomains.isPrimary,
        lastError: storefrontDomains.lastError,
        lastCheckedAt: storefrontDomains.lastCheckedAt,
        createdAt: storefrontDomains.createdAt,
      })
      .from(storefrontDomains)
      .where(eq(storefrontDomains.storefrontId, storefrontId))
      .orderBy(desc(storefrontDomains.isPrimary), asc(storefrontDomains.id)),
    storefront.publishedVersionId
      ? db
          .select({ versionNumber: storefrontPublishVersions.versionNumber })
          .from(storefrontPublishVersions)
          .where(eq(storefrontPublishVersions.id, storefront.publishedVersionId))
          .limit(1)
      : Promise.resolve([]),
  ]);
  return {
    ...storefront,
    domains,
    publishedVersionNumber: version[0]?.versionNumber ?? null,
  };
}

// ---------------------------------------------------------------------------
// Create / update / archive
// ---------------------------------------------------------------------------

export interface CreateStorefrontInput {
  name: string;
  themeId: string;
  subdomain?: string | undefined;
}

export async function createStorefront(
  businessId: number,
  userId: number,
  input: CreateStorefrontInput,
): Promise<typeof storefronts.$inferSelect> {
  const entitlements = await getEntitlements(businessId);
  assertFeature(entitlements, "hostedStorefront");

  const theme = getTheme(input.themeId);
  if (!theme) {
    throw new BadRequestError("Unknown template. Pick one from the gallery.");
  }
  if (theme.premium) {
    assertFeature(entitlements, "premiumThemes");
  }

  const subdomain = await pickSubdomain(businessId, input.subdomain);
  const draftConfig = storefrontThemeConfigSchema.parse({
    tokens: theme.defaultTokens,
    sections: theme.defaultSections,
  });

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${businessId})`);
      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(storefronts)
        .where(
          and(
            eq(storefronts.businessId, businessId),
            ne(storefronts.status, "archived"),
          ),
        );
      const limit = entitlements.plan?.limits?.maxStorefronts;
      if (limit !== undefined && limit !== null && (countRow?.count ?? 0) >= limit) {
        throw new ForbiddenError(
          `Your plan allows up to ${limit} online store${limit === 1 ? "" : "s"}. Upgrade your plan to create more.`,
          "PLAN_LIMIT_REACHED",
        );
      }

      const [created] = await tx
        .insert(storefronts)
        .values({
          businessId,
          name: input.name,
          subdomain,
          themeId: theme.id,
          draftConfig,
        })
        .returning();
      if (!created) throw new Error("Storefront insert returned no row.");

      await tx.insert(storefrontDomains).values({
        storefrontId: created.id,
        kind: "subdomain",
        domain: `${subdomain}`.trim(),
        status: "verified",
        sslStatus: "pending",
        isPrimary: true,
        verifiedAt: new Date(),
      });
      return created;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("That subdomain is already taken.");
    }
    throw err;
  }
}

export interface UpdateStorefrontPatch {
  name?: string | undefined;
  themeId?: string | undefined;
  draftConfig?: unknown;
  seo?: Record<string, unknown> | null | undefined;
  contact?: Record<string, unknown> | null | undefined;
  storePickupEnabled?: boolean | undefined;
  analyticsEnabled?: boolean | undefined;
  searchIndexingEnabled?: boolean | undefined;
}

export async function updateStorefront(
  businessId: number,
  storefrontId: number,
  patch: UpdateStorefrontPatch,
): Promise<typeof storefronts.$inferSelect> {
  await requireStorefront(businessId, storefrontId);

  const update: Partial<typeof storefronts.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (patch.themeId !== undefined) {
    const entitlements = await getEntitlements(businessId);
    const theme = getTheme(patch.themeId);
    if (!theme) throw new BadRequestError("Unknown template.");
    if (theme.premium) assertFeature(entitlements, "premiumThemes");
    update.themeId = theme.id;
  }

  if (patch.draftConfig !== undefined) {
    const parsed = storefrontThemeConfigSchema.safeParse(patch.draftConfig);
    if (!parsed.success) {
      throw new BadRequestError(
        parsed.error.issues[0]?.message ?? "Invalid theme configuration.",
      );
    }
    update.draftConfig = parsed.data as unknown as Record<string, unknown>;
  }

  if (patch.name !== undefined) update.name = patch.name;
  if (patch.seo !== undefined) {
    update.seo = (patch.seo ?? null) as typeof storefronts.$inferInsert.seo;
  }
  if (patch.contact !== undefined) {
    update.contact = (patch.contact ??
      null) as typeof storefronts.$inferInsert.contact;
  }
  if (patch.storePickupEnabled !== undefined) {
    update.storePickupEnabled = patch.storePickupEnabled;
  }
  if (patch.analyticsEnabled !== undefined) {
    update.analyticsEnabled = patch.analyticsEnabled;
  }
  if (patch.searchIndexingEnabled !== undefined) {
    update.searchIndexingEnabled = patch.searchIndexingEnabled;
  }

  const [updated] = await db
    .update(storefronts)
    .set(update)
    .where(
      and(
        eq(storefronts.id, storefrontId),
        eq(storefronts.businessId, businessId),
      ),
    )
    .returning();
  if (!updated) throw new NotFoundError("Storefront not found.");
  return updated;
}

export async function archiveStorefront(
  businessId: number,
  storefrontId: number,
): Promise<void> {
  const updated = await db
    .update(storefronts)
    .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(storefronts.id, storefrontId),
        eq(storefronts.businessId, businessId),
        ne(storefronts.status, "archived"),
      ),
    )
    .returning({ id: storefronts.id });
  if (updated.length === 0) throw new NotFoundError("Storefront not found.");
}

// ---------------------------------------------------------------------------
// Publishing (immutable version snapshots)
// ---------------------------------------------------------------------------

export async function publishStorefront(
  businessId: number,
  userId: number,
  storefrontId: number,
): Promise<{ versionNumber: number }> {
  const storefront = await requireStorefront(businessId, storefrontId);
  if (storefront.status === "suspended") {
    throw new ForbiddenError(
      "This store is suspended. Contact ezPos support to restore it.",
    );
  }

  // Re-validate at publish time: snapshots must always be renderable.
  const parsed = storefrontThemeConfigSchema.safeParse(storefront.draftConfig);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message ??
        "The theme configuration is invalid and cannot be published.",
    );
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${businessId})`);
    const [maxRow] = await tx
      .select({
        max: sql<number>`coalesce(max(${storefrontPublishVersions.versionNumber}), 0)::int`,
      })
      .from(storefrontPublishVersions)
      .where(eq(storefrontPublishVersions.storefrontId, storefrontId));

    const nextVersionNumber = (maxRow?.max ?? 0) + 1;
    const [version] = await tx
      .insert(storefrontPublishVersions)
      .values({
        storefrontId,
        versionNumber: nextVersionNumber,
        themeId: storefront.themeId,
        config: parsed.data as unknown as Record<string, unknown>,
        seo: (storefront.seo ?? null) as Record<string, unknown> | null,
        contact: (storefront.contact ?? null) as Record<string, unknown> | null,
        publishedByUserId: userId,
      })
      .returning({
        id: storefrontPublishVersions.id,
        versionNumber: storefrontPublishVersions.versionNumber,
      });
    if (!version) throw new Error("Version insert returned no row.");

    const now = new Date();
    await tx
      .update(storefronts)
      .set({
        publishedVersionId: version.id,
        status: "published",
        publishedAt: now,
        updatedAt: now,
      })
      .where(eq(storefronts.id, storefrontId));

    return { versionNumber: version.versionNumber };
  });
}

export async function unpublishStorefront(
  businessId: number,
  storefrontId: number,
): Promise<void> {
  const storefront = await requireStorefront(businessId, storefrontId);
  if (storefront.status !== "published") {
    throw new BadRequestError("Only a published store can be unpublished.");
  }
  await db
    .update(storefronts)
    .set({ status: "draft", updatedAt: new Date() })
    .where(eq(storefronts.id, storefrontId));
}

export async function listStorefrontVersions(
  businessId: number,
  storefrontId: number,
) {
  await requireStorefront(businessId, storefrontId);
  return db
    .select({
      id: storefrontPublishVersions.id,
      versionNumber: storefrontPublishVersions.versionNumber,
      themeId: storefrontPublishVersions.themeId,
      publishedAt: storefrontPublishVersions.publishedAt,
      publishedByUserId: storefrontPublishVersions.publishedByUserId,
    })
    .from(storefrontPublishVersions)
    .where(eq(storefrontPublishVersions.storefrontId, storefrontId))
    .orderBy(desc(storefrontPublishVersions.versionNumber))
    .limit(50);
}

/**
 * Restores an old snapshot by republishing it as a NEW version (history is
 * never rewritten), then points the storefront at the new snapshot.
 */
export async function restoreStorefrontVersion(
  businessId: number,
  userId: number,
  storefrontId: number,
  versionId: number,
): Promise<{ versionNumber: number }> {
  await requireStorefront(businessId, storefrontId);
  const [snapshot] = await db
    .select()
    .from(storefrontPublishVersions)
    .where(
      and(
        eq(storefrontPublishVersions.id, versionId),
        eq(storefrontPublishVersions.storefrontId, storefrontId),
      ),
    )
    .limit(1);
  if (!snapshot) throw new NotFoundError("Version not found.");

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${businessId})`);
    const [maxRow] = await tx
      .select({
        max: sql<number>`coalesce(max(${storefrontPublishVersions.versionNumber}), 0)::int`,
      })
      .from(storefrontPublishVersions)
      .where(eq(storefrontPublishVersions.storefrontId, storefrontId));
    const nextVersionNumber = (maxRow?.max ?? 0) + 1;

    const [created] = await tx
      .insert(storefrontPublishVersions)
      .values({
        storefrontId,
        versionNumber: nextVersionNumber,
        themeId: snapshot.themeId,
        config: snapshot.config,
        seo: snapshot.seo,
        contact: snapshot.contact,
        publishedByUserId: userId,
      })
      .returning({
        id: storefrontPublishVersions.id,
        versionNumber: storefrontPublishVersions.versionNumber,
      });
    if (!created) throw new Error("Version insert returned no row.");

    const now = new Date();
    await tx
      .update(storefronts)
      .set({
        publishedVersionId: created.id,
        status: "published",
        publishedAt: now,
        updatedAt: now,
      })
      .where(eq(storefronts.id, storefrontId));

    return { versionNumber: created.versionNumber };
  });
}

// ---------------------------------------------------------------------------
// Subdomain change
// ---------------------------------------------------------------------------

export async function changeSubdomain(
  businessId: number,
  storefrontId: number,
  requested: string,
): Promise<string> {
  const subdomain = validateSubdomain(requested);
  const storefront = await requireStorefront(businessId, storefrontId);
  if (subdomain === storefront.subdomain) return subdomain;

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${businessId})`);
      await tx
        .update(storefronts)
        .set({ subdomain, updatedAt: new Date() })
        .where(eq(storefronts.id, storefrontId));
      await tx
        .update(storefrontDomains)
        .set({ domain: subdomain, status: "verified", lastError: null })
        .where(
          and(
            eq(storefrontDomains.storefrontId, storefrontId),
            eq(storefrontDomains.kind, "subdomain"),
          ),
        );
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("That subdomain is already taken.");
    }
    throw err;
  }
  return subdomain;
}
