import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/schema/index.js";
import { storefronts } from "../../db/schema/storefronts.js";
import { storefrontPages } from "../../db/schema/storefrontPages.js";
import { storefrontProductVisibility } from "../../db/schema/storefrontProductVisibility.js";
import { storefrontDeliveryZones } from "../../db/schema/storefrontDeliveryZones.js";
import { storefrontPaymentMethods } from "../../db/schema/storefrontPaymentMethods.js";
import { storefrontMedia as storefrontMediaTable } from "../../db/schema/storefrontMedia.js";
import { products } from "../../db/schema/products.js";
import { getBusinessId } from "../../middleware/business.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { sendSafeError } from "../../utils/safeError.js";
import * as service from "./storefronts.service.js";
import * as domainsService from "./domains.service.js";
import {
  addDomainSchema,
  changeSubdomainSchema,
  createPageSchema,
  createZoneSchema,
  createStorefrontSchema,
  presignMediaSchema,
  registerMediaSchema,
  updatePageSchema,
  updatePaymentMethodsSchema,
  updateStorefrontSchema,
  updateZoneSchema,
  upsertVisibilitySchema,
} from "./storefront.validation.js";
import {
  createPreviewToken as signPreviewToken,
} from "./previewToken.js";
import {
  MEDIA_CONTENT_TYPES,
  buildMediaObjectKey,
  isAllowedMediaType,
  mediaStorageEnabled,
  presignObjectUrl,
  publicMediaUrl,
} from "../../services/objectStorage.js";
import {
  assertWithinMediaQuota,
  getEntitlements,
  getMediaStorageBytes,
} from "../../services/entitlements.js";
import { env } from "../../config/env.js";

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message ?? "Invalid request data.",
    );
  }
  return parsed.data;
}

function parseId(raw: string | string[] | undefined, label: string): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestError(`A valid ${label} is required.`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Storefronts
// ---------------------------------------------------------------------------

export async function createStorefront(req: Request, res: Response) {
  try {
    const input = parseBody(createStorefrontSchema, req.body);
    const created = await service.createStorefront(
      getBusinessId(req),
      req.user!.id,
      input,
    );
    res.status(201).json({
      success: true,
      message: "Online store created.",
      data: created,
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to create the online store right now.");
  }
}

export async function listStorefronts(req: Request, res: Response) {
  try {
    const data = await service.listStorefronts(getBusinessId(req));
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafeError(res, err, "Unable to load online stores right now.");
  }
}

export async function getStorefront(req: Request, res: Response) {
  try {
    const data = await service.getStorefrontDetail(
      getBusinessId(req),
      parseId(req.params.storefrontId, "storefront ID"),
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafeError(res, err, "Unable to load the online store right now.");
  }
}

export async function updateStorefront(req: Request, res: Response) {
  try {
    const patch = parseBody(updateStorefrontSchema, req.body);
    const updated = await service.updateStorefront(
      getBusinessId(req),
      parseId(req.params.storefrontId, "storefront ID"),
      patch,
    );
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    sendSafeError(res, err, "Unable to update the online store right now.");
  }
}

export async function updateDraftConfig(req: Request, res: Response) {
  try {
    const { draftConfig } = parseBody(
      z.object({ draftConfig: z.unknown() }),
      req.body,
    );
    const updated = await service.updateStorefront(
      getBusinessId(req),
      parseId(req.params.storefrontId, "storefront ID"),
      { draftConfig },
    );
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    sendSafeError(res, err, "Unable to save the design right now.");
  }
}

export async function archiveStorefront(req: Request, res: Response) {
  try {
    await service.archiveStorefront(
      getBusinessId(req),
      parseId(req.params.storefrontId, "storefront ID"),
    );
    res.status(200).json({ success: true, message: "Online store archived." });
  } catch (err) {
    sendSafeError(res, err, "Unable to archive the online store right now.");
  }
}

export async function publishStorefront(req: Request, res: Response) {
  try {
    const result = await service.publishStorefront(
      getBusinessId(req),
      req.user!.id,
      parseId(req.params.storefrontId, "storefront ID"),
    );
    res.status(200).json({
      success: true,
      message: `Store published as version ${result.versionNumber}.`,
      data: result,
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to publish the store right now.");
  }
}

export async function unpublishStorefront(req: Request, res: Response) {
  try {
    await service.unpublishStorefront(
      getBusinessId(req),
      parseId(req.params.storefrontId, "storefront ID"),
    );
    res
      .status(200)
      .json({ success: true, message: "Store unpublished. The live site is now offline." });
  } catch (err) {
    sendSafeError(res, err, "Unable to unpublish the store right now.");
  }
}

export async function listStorefrontVersions(req: Request, res: Response) {
  try {
    const data = await service.listStorefrontVersions(
      getBusinessId(req),
      parseId(req.params.storefrontId, "storefront ID"),
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafeError(res, err, "Unable to load versions right now.");
  }
}

export async function restoreStorefrontVersion(req: Request, res: Response) {
  try {
    const result = await service.restoreStorefrontVersion(
      getBusinessId(req),
      req.user!.id,
      parseId(req.params.storefrontId, "storefront ID"),
      parseId(req.params.versionId, "version ID"),
    );
    res.status(200).json({
      success: true,
      message: `Restored as version ${result.versionNumber}.`,
      data: result,
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to restore the version right now.");
  }
}

export async function changeSubdomain(req: Request, res: Response) {
  try {
    const { subdomain } = parseBody(changeSubdomainSchema, req.body);
    const result = await service.changeSubdomain(
      getBusinessId(req),
      parseId(req.params.storefrontId, "storefront ID"),
      subdomain,
    );
    res
      .status(200)
      .json({ success: true, message: "Subdomain updated.", data: { subdomain: result } });
  } catch (err) {
    sendSafeError(res, err, "Unable to change the subdomain right now.");
  }
}

export async function getSubdomainAvailability(req: Request, res: Response) {
  try {
    const subdomain = service.normalizeSubdomain(String(req.query.subdomain ?? ""));
    let available = false;
    let error: string | null = null;
    try {
      service.validateSubdomain(subdomain);
      const [row] = await db
        .select({ id: storefronts.id })
        .from(storefronts)
        .where(eq(storefronts.subdomain, subdomain))
        .limit(1);
      available = row === undefined;
    } catch (err) {
      if (err instanceof BadRequestError) {
        error = err.message;
      } else {
        throw err;
      }
    }
    res.status(200).json({ success: true, data: { subdomain, available, error } });
  } catch (err) {
    sendSafeError(res, err, "Unable to check availability right now.");
  }
}

export async function createPreviewToken(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    const token = await signPreviewToken(getBusinessId(req), storefrontId);
    res.status(200).json({ success: true, data: { token, expiresInHours: 4 } });
  } catch (err) {
    sendSafeError(res, err, "Unable to create a preview link right now.");
  }
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export async function listDomains(req: Request, res: Response) {
  try {
    const data = await domainsService.listDomains(
      getBusinessId(req),
      parseId(req.params.storefrontId, "storefront ID"),
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafeError(res, err, "Unable to load domains right now.");
  }
}

export async function addDomain(req: Request, res: Response) {
  try {
    const { domain } = parseBody(addDomainSchema, req.body);
    const created = await domainsService.addCustomDomain(
      getBusinessId(req),
      parseId(req.params.storefrontId, "storefront ID"),
      domain,
    );
    res.status(201).json({
      success: true,
      message: "Domain added. Add the DNS verification record to continue.",
      data: created,
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to add the domain right now.");
  }
}

export async function verifyDomain(req: Request, res: Response) {
  try {
    const result = await domainsService.verifyDomain(
      getBusinessId(req),
      parseId(req.params.storefrontId, "storefront ID"),
      parseId(req.params.domainId, "domain ID"),
    );
    res.status(200).json({
      success: true,
      message: result.verified
        ? "Domain verified. SSL provisioning happens automatically."
        : "Verification is still pending — check the DNS record and try again.",
      data: result.domain,
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to verify the domain right now.");
  }
}

export async function makePrimaryDomain(req: Request, res: Response) {
  try {
    await domainsService.makePrimaryDomain(
      getBusinessId(req),
      parseId(req.params.storefrontId, "storefront ID"),
      parseId(req.params.domainId, "domain ID"),
    );
    res
      .status(200)
      .json({ success: true, message: "Primary domain updated." });
  } catch (err) {
    sendSafeError(res, err, "Unable to update the primary domain right now.");
  }
}

export async function removeDomain(req: Request, res: Response) {
  try {
    await domainsService.removeDomain(
      getBusinessId(req),
      parseId(req.params.storefrontId, "storefront ID"),
      parseId(req.params.domainId, "domain ID"),
    );
    res.status(200).json({ success: true, message: "Domain removed." });
  } catch (err) {
    sendSafeError(res, err, "Unable to remove the domain right now.");
  }
}

// ---------------------------------------------------------------------------
// Content pages
// ---------------------------------------------------------------------------

export async function listPages(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    const data = await db
      .select()
      .from(storefrontPages)
      .where(eq(storefrontPages.storefrontId, storefrontId))
      .orderBy(storefrontPages.id);
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafeError(res, err, "Unable to load pages right now.");
  }
}

export async function createPage(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    const input = parseBody(createPageSchema, req.body);
    const [created] = await db
      .insert(storefrontPages)
      .values({ storefrontId, ...input })
      .returning();
    if (!created) throw new Error("Page insert returned no row.");
    res.status(201).json({ success: true, message: "Page created.", data: created });
  } catch (err) {
    if (service.isUniqueViolation(err)) {
      return sendSafeError(
        res,
        new ConflictError("A page with this slug already exists."),
        "Unable to create the page.",
      );
    }
    sendSafeError(res, err, "Unable to create the page right now.");
  }
}

export async function updatePage(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    const pageId = parseId(req.params.pageId, "page ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    const patch = parseBody(updatePageSchema, req.body);
    const [updated] = await db
      .update(storefrontPages)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(eq(storefrontPages.id, pageId), eq(storefrontPages.storefrontId, storefrontId)),
      )
      .returning();
    if (!updated) throw new NotFoundError("Page not found.");
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    sendSafeError(res, err, "Unable to update the page right now.");
  }
}

export async function deletePage(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    const pageId = parseId(req.params.pageId, "page ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    const deleted = await db
      .delete(storefrontPages)
      .where(
        and(eq(storefrontPages.id, pageId), eq(storefrontPages.storefrontId, storefrontId)),
      )
      .returning({ id: storefrontPages.id });
    if (deleted.length === 0) throw new NotFoundError("Page not found.");
    res.status(200).json({ success: true, message: "Page deleted." });
  } catch (err) {
    sendSafeError(res, err, "Unable to delete the page right now.");
  }
}

// ---------------------------------------------------------------------------
// Product visibility
// ---------------------------------------------------------------------------

export async function listVisibility(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    // Deliberately excludes cost/supplier fields — website-only view.
    const data = await db
      .select({
        visibilityId: storefrontProductVisibility.id,
        productId: products.id,
        productName: products.name,
        productStatus: products.status,
        published: storefrontProductVisibility.published,
        featured: storefrontProductVisibility.featured,
        seoTitle: storefrontProductVisibility.seoTitle,
        seoDescription: storefrontProductVisibility.seoDescription,
        websiteImageUrls: storefrontProductVisibility.websiteImageUrls,
        sortOrder: storefrontProductVisibility.sortOrder,
      })
      .from(storefrontProductVisibility)
      .innerJoin(products, eq(products.id, storefrontProductVisibility.productId))
      .where(eq(storefrontProductVisibility.storefrontId, storefrontId))
      .orderBy(storefrontProductVisibility.sortOrder, storefrontProductVisibility.id);
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafeError(res, err, "Unable to load storefront products right now.");
  }
}

export async function upsertVisibility(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    const productId = parseId(req.params.productId, "product ID");
    await service.requireStorefront(businessId, storefrontId);

    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.businessId, businessId)))
      .limit(1);
    if (!product) throw new NotFoundError("Product not found.");

    const patch = parseBody(upsertVisibilitySchema, req.body);
    const [row] = await db
      .insert(storefrontProductVisibility)
      .values({ businessId, storefrontId, productId, ...patch })
      .onConflictDoUpdate({
        target: [
          storefrontProductVisibility.storefrontId,
          storefrontProductVisibility.productId,
        ],
        set: { ...patch, updatedAt: new Date() },
      })
      .returning();
    res.status(200).json({ success: true, data: row });
  } catch (err) {
    sendSafeError(res, err, "Unable to update the storefront product right now.");
  }
}

export async function deleteVisibility(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    const productId = parseId(req.params.productId, "product ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    const deleted = await db
      .delete(storefrontProductVisibility)
      .where(
        and(
          eq(storefrontProductVisibility.storefrontId, storefrontId),
          eq(storefrontProductVisibility.productId, productId),
        ),
      )
      .returning({ id: storefrontProductVisibility.id });
    if (deleted.length === 0) throw new NotFoundError("Storefront product not found.");
    res.status(200).json({ success: true, message: "Product removed from the store." });
  } catch (err) {
    sendSafeError(res, err, "Unable to remove the storefront product right now.");
  }
}

// ---------------------------------------------------------------------------
// Delivery zones
// ---------------------------------------------------------------------------

export async function listZones(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    const data = await db
      .select()
      .from(storefrontDeliveryZones)
      .where(eq(storefrontDeliveryZones.storefrontId, storefrontId))
      .orderBy(storefrontDeliveryZones.id);
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafeError(res, err, "Unable to load delivery zones right now.");
  }
}

export async function createZone(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    const input = parseBody(createZoneSchema, req.body);
    const [created] = await db
      .insert(storefrontDeliveryZones)
      .values({ storefrontId, ...input })
      .returning();
    res.status(201).json({ success: true, message: "Delivery zone created.", data: created });
  } catch (err) {
    sendSafeError(res, err, "Unable to create the delivery zone right now.");
  }
}

export async function updateZone(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    const zoneId = parseId(req.params.zoneId, "zone ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    const patch = parseBody(updateZoneSchema, req.body);
    const [updated] = await db
      .update(storefrontDeliveryZones)
      .set(patch)
      .where(
        and(
          eq(storefrontDeliveryZones.id, zoneId),
          eq(storefrontDeliveryZones.storefrontId, storefrontId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundError("Delivery zone not found.");
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    sendSafeError(res, err, "Unable to update the delivery zone right now.");
  }
}

export async function deleteZone(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    const zoneId = parseId(req.params.zoneId, "zone ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    const deleted = await db
      .delete(storefrontDeliveryZones)
      .where(
        and(
          eq(storefrontDeliveryZones.id, zoneId),
          eq(storefrontDeliveryZones.storefrontId, storefrontId),
        ),
      )
      .returning({ id: storefrontDeliveryZones.id });
    if (deleted.length === 0) throw new NotFoundError("Delivery zone not found.");
    res.status(200).json({ success: true, message: "Delivery zone deleted." });
  } catch (err) {
    sendSafeError(res, err, "Unable to delete the delivery zone right now.");
  }
}

// ---------------------------------------------------------------------------
// Payment methods (config only)
// ---------------------------------------------------------------------------

export async function getPaymentMethods(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    const rows = await db
      .select()
      .from(storefrontPaymentMethods)
      .where(eq(storefrontPaymentMethods.storefrontId, storefrontId));
    res.status(200).json({ success: true, data: rows });
  } catch (err) {
    sendSafeError(res, err, "Unable to load payment methods right now.");
  }
}

export async function updatePaymentMethods(req: Request, res: Response) {
  try {
    const storefrontId = parseId(req.params.storefrontId, "storefront ID");
    await service.requireStorefront(getBusinessId(req), storefrontId);
    const { methods } = parseBody(updatePaymentMethodsSchema, req.body);

    const updated = await db.transaction(async (tx) => {
      const rows: Array<typeof storefrontPaymentMethods.$inferSelect> = [];
      for (const method of methods) {
        const [row] = await tx
          .insert(storefrontPaymentMethods)
          .values({ storefrontId, method: method.method, enabled: method.enabled, label: method.label ?? null })
          .onConflictDoUpdate({
            target: [
              storefrontPaymentMethods.storefrontId,
              storefrontPaymentMethods.method,
            ],
            set: { enabled: method.enabled, label: method.label ?? null },
          })
          .returning();
        if (row) rows.push(row);
      }
      return rows;
    });
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    sendSafeError(res, err, "Unable to update payment methods right now.");
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export async function presignMedia(req: Request, res: Response) {
  try {
    if (!mediaStorageEnabled()) {
      throw new BadRequestError(
        "Image storage is not configured yet. Please contact ezPos support.",
      );
    }
    const input = parseBody(presignMediaSchema, req.body);
    if (!isAllowedMediaType(input.contentType)) {
      throw new BadRequestError("Only JPEG, PNG and WebP images are supported.");
    }
    const maxBytes = env.mediaMaxUploadMb * 1024 * 1024;
    if (input.sizeBytes > maxBytes) {
      throw new BadRequestError(
        `Images can be up to ${env.mediaMaxUploadMb} MB.`,
      );
    }

    const businessId = getBusinessId(req);
    const entitlements = await getEntitlements(businessId);
    const usedBytes = await getMediaStorageBytes(businessId);
    assertWithinMediaQuota(entitlements, usedBytes, input.sizeBytes);

    const objectKey = buildMediaObjectKey(businessId, input.contentType);
    res.status(200).json({
      success: true,
      data: {
        objectKey,
        uploadUrl: presignObjectUrl("PUT", objectKey),
        publicUrl: publicMediaUrl(objectKey),
        expiresIn: 600,
      },
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to prepare the image upload right now.");
  }
}

export async function registerMedia(req: Request, res: Response) {
  try {
    if (!mediaStorageEnabled()) {
      throw new BadRequestError(
        "Image storage is not configured yet. Please contact ezPos support.",
      );
    }
    const input = parseBody(registerMediaSchema, req.body);
    const businessId = getBusinessId(req);

    if (!input.objectKey.startsWith(`businesses/${businessId}/storefront/`)) {
      throw new BadRequestError("Invalid object key.");
    }
    if (!isAllowedMediaType(input.contentType)) {
      throw new BadRequestError("Only JPEG, PNG and WebP images are supported.");
    }
    const maxBytes = env.mediaMaxUploadMb * 1024 * 1024;
    if (input.bytes > maxBytes) {
      throw new BadRequestError(`Images can be up to ${env.mediaMaxUploadMb} MB.`);
    }

    // Confirm the object actually exists in storage before registering it.
    try {
      const head = await fetch(presignObjectUrl("HEAD", input.objectKey));
      if (!head.ok) {
        throw new BadRequestError(
          "Upload not found — finish uploading the file first, then register it.",
        );
      }
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      throw new BadRequestError(
        "Upload not found — finish uploading the file first, then register it.",
      );
    }

    const entitlements = await getEntitlements(businessId);
    const usedBytes = await getMediaStorageBytes(businessId);
    assertWithinMediaQuota(entitlements, usedBytes, input.bytes);

    const [created] = await db
      .insert(await Promise.resolve(storefrontMediaTable))
      .values({
        businessId,
        objectKey: input.objectKey,
        fileName: input.fileName,
        contentType: input.contentType,
        bytes: input.bytes,
        width: input.width ?? null,
        height: input.height ?? null,
      })
      .onConflictDoNothing()
      .returning();

    const row =
      created ??
      (
        await db
          .select()
          .from(storefrontMediaTable)
          .where(eq(storefrontMediaTable.objectKey, input.objectKey))
          .limit(1)
      )[0];
    res.status(201).json({
      success: true,
      message: "Image registered.",
      data: { ...row, publicUrl: publicMediaUrl(input.objectKey) },
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to register the image right now.");
  }
}

export async function listMedia(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const rows = await db
      .select()
      .from(storefrontMediaTable)
      .where(eq(storefrontMediaTable.businessId, businessId))
      .limit(500);
    res.status(200).json({
      success: true,
      data: rows.map((row) => ({ ...row, publicUrl: publicMediaUrl(row.objectKey) })),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load images right now.");
  }
}

export async function deleteMedia(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const mediaId = parseId(req.params.mediaId, "image ID");
    const [row] = await db
      .select()
      .from(storefrontMediaTable)
      .where(
        and(eq(storefrontMediaTable.id, mediaId), eq(storefrontMediaTable.businessId, businessId)),
      )
      .limit(1);
    if (!row) throw new NotFoundError("Image not found.");

    // Best-effort storage delete; the metadata row is authoritative.
    try {
      if (mediaStorageEnabled()) {
        await fetch(presignObjectUrl("DELETE", row.objectKey), { method: "DELETE" });
      }
    } catch (storageErr) {
      console.error("Media storage delete failed:", storageErr);
    }

    await db
      .delete(storefrontMediaTable)
      .where(eq(storefrontMediaTable.id, row.id));
    res.status(200).json({ success: true, message: "Image deleted." });
  } catch (err) {
    sendSafeError(res, err, "Unable to delete the image right now.");
  }
}
