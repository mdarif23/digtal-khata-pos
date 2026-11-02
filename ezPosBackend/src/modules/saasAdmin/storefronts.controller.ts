import type { Request, Response } from "express";
import { and, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { businesses } from "../../db/schema/businesses.js";
import { storefrontDomains } from "../../db/schema/storefrontDomains.js";
import { storefrontMedia } from "../../db/schema/storefrontMedia.js";
import { storefronts } from "../../db/schema/storefronts.js";
import { shoppers } from "../../db/schema/shoppers.js";
import { THEMES } from "../storefronts/themes.catalog.js";
import { audit } from "./saasAdmin.service.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";

/**
 * SaaS-owner storefront administration (stage 6). Every mutation is
 * audit-logged in saas_admin_audit. Admins can stop a abusive/suspended
 * business's storefronts and inspect domain provisioning errors — they can
 * never edit a customer's storefront content or configuration.
 */

export async function listStorefronts(req: Request, res: Response) {
  try {
    const search = String(req.query.search ?? "").trim();
    const filters = [ne(storefronts.status, "archived")];
    if (search) {
      const pattern = `%${search}%`;
      filters.push(
        or(
          ilike(storefronts.name, pattern),
          ilike(storefronts.subdomain, pattern),
          ilike(businesses.name, pattern),
        )!,
      );
    }
    const rows = await db
      .select({
        id: storefronts.id,
        name: storefronts.name,
        subdomain: storefronts.subdomain,
        status: storefronts.status,
        themeId: storefronts.themeId,
        businessId: storefronts.businessId,
        businessName: businesses.name,
        businessStatus: businesses.status,
        publishedAt: storefronts.publishedAt,
        createdAt: storefronts.createdAt,
        domainCount: sql<number>`(
          select count(*)::int from ${storefrontDomains}
          where ${storefrontDomains.storefrontId} = ${storefronts.id}
        )`,
      })
      .from(storefronts)
      .innerJoin(businesses, eq(businesses.id, storefronts.businessId))
      .where(and(...filters))
      .orderBy(desc(storefronts.id))
      .limit(100);
    res.status(200).json({ success: true, data: rows });
  } catch (err) {
    sendSafeError(res, err, "Unable to load storefronts right now.");
  }
}

export async function getStorefront(req: Request, res: Response) {
  try {
    const id = Number(req.params.storefrontId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestError("A valid storefront ID is required.");
    }
    const [row] = await db
      .select({
        id: storefronts.id,
        name: storefronts.name,
        subdomain: storefronts.subdomain,
        status: storefronts.status,
        themeId: storefronts.themeId,
        businessId: storefronts.businessId,
        businessName: businesses.name,
        businessStatus: businesses.status,
        analyticsEnabled: storefronts.analyticsEnabled,
        shopperAccountsEnabled: storefronts.shopperAccountsEnabled,
        publishedAt: storefronts.publishedAt,
        suspendedAt: storefronts.suspendedAt,
        createdAt: storefronts.createdAt,
      })
      .from(storefronts)
      .innerJoin(businesses, eq(businesses.id, storefronts.businessId))
      .where(eq(storefronts.id, id))
      .limit(1);
    if (!row) throw new NotFoundError("Storefront not found.");

    const [domains, mediaUsage, shopperCount] = await Promise.all([
      db
        .select({
          id: storefrontDomains.id,
          kind: storefrontDomains.kind,
          domain: storefrontDomains.domain,
          status: storefrontDomains.status,
          sslStatus: storefrontDomains.sslStatus,
          isPrimary: storefrontDomains.isPrimary,
          lastError: storefrontDomains.lastError,
          createdAt: storefrontDomains.createdAt,
        })
        .from(storefrontDomains)
        .where(eq(storefrontDomains.storefrontId, id)),
      db
        .select({
          files: sql<number>`count(*)::int`,
          bytes: sql<number>`coalesce(sum(${storefrontMedia.bytes}), 0)::bigint`,
        })
        .from(storefrontMedia)
        .where(eq(storefrontMedia.businessId, row.businessId)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(shoppers)
        .where(eq(shoppers.storefrontId, id)),
    ]);

    res.status(200).json({
      success: true,
      data: {
        ...row,
        domains,
        media: {
          files: mediaUsage[0]?.files ?? 0,
          bytes: Number(mediaUsage[0]?.bytes ?? 0),
        },
        shoppers: shopperCount[0]?.n ?? 0,
      },
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load the storefront right now.");
  }
}

export async function suspendStorefront(req: Request, res: Response) {
  try {
    const id = Number(req.params.storefrontId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestError("A valid storefront ID is required.");
    }
    const reason = String((req.body as { reason?: unknown })?.reason ?? "").trim() || null;
    const updated = await db
      .update(storefronts)
      .set({ status: "suspended", suspendedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(storefronts.id, id), ne(storefronts.status, "suspended")))
      .returning({ id: storefronts.id });
    if (updated.length === 0) throw new NotFoundError("Storefront not found or already suspended.");

    await audit(
      { adminUserId: req.user!.id },
      "storefront.suspend",
      "storefront",
      id,
      { reason },
    );
    res.status(200).json({ success: true, message: "Storefront suspended." });
  } catch (err) {
    sendSafeError(res, err, "Unable to suspend the storefront right now.");
  }
}

export async function reactivateStorefront(req: Request, res: Response) {
  try {
    const id = Number(req.params.storefrontId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestError("A valid storefront ID is required.");
    }
    // A suspended store that had been published resumes serving instantly
    // (its published snapshot is intact); never-published ones go to draft.
    const [row] = await db
      .select({ publishedVersionId: storefronts.publishedVersionId })
      .from(storefronts)
      .where(eq(storefronts.id, id))
      .limit(1);
    if (!row) throw new NotFoundError("Storefront not found.");

    const updated = await db
      .update(storefronts)
      .set({
        status: row.publishedVersionId ? "published" : "draft",
        suspendedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(storefronts.id, id), eq(storefronts.status, "suspended")))
      .returning({ id: storefronts.id });
    if (updated.length === 0) {
      throw new NotFoundError("Storefront not found or not suspended.");
    }

    await audit(
      { adminUserId: req.user!.id },
      "storefront.reactivate",
      "storefront",
      id,
      { restoredStatus: row.publishedVersionId ? "published" : "draft" },
    );
    res.status(200).json({ success: true, message: "Storefront reactivated." });
  } catch (err) {
    sendSafeError(res, err, "Unable to reactivate the storefront right now.");
  }
}

export async function listThemes(_req: Request, res: Response) {
  res.status(200).json({
    success: true,
    data: THEMES.map((theme) => ({
      id: theme.id,
      name: theme.name,
      category: theme.category,
      description: theme.description,
      premium: theme.premium,
    })),
  });
}
