import type { Request, Response } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/schema/index.js";
import { storefrontApiKeys } from "../../db/schema/storefrontApiKeys.js";
import {
  STOREFRONT_SCOPES,
  generatePublishableKey,
  generateSecretKey,
  hashSecretKey,
  type StorefrontScope,
} from "../../middleware/storefront.js";
import { getBusinessId } from "../../middleware/business.js";
import { ConflictError } from "../../utils/handleError.js";
import { assertFeature, getEntitlements } from "../../services/entitlements.js";
import { sendSafeError } from "../../utils/safeError.js";

const createKeySchema = z.object({
  name: z.string().trim().min(2, "Enter a key name").max(120),
  scopes: z
    .array(z.enum(STOREFRONT_SCOPES))
    .min(1, "Select at least one scope")
    .max(STOREFRONT_SCOPES.length),
  allowedDomains: z
    .array(z.string().trim().min(3).max(255))
    .max(10)
    .optional(),
  integrationId: z.number().int().positive().nullish(),
});

/**
 * Portal-side key management. The secret key is returned EXACTLY ONCE —
 * only its hash is stored, and no endpoint ever returns it again.
 */
export async function createKey(req: Request, res: Response) {
  const parsed = createKeySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid key data.",
    });
  }
  try {
    const businessId = getBusinessId(req);
    const entitlements = await getEntitlements(businessId);
    await assertFeature(entitlements, "storefrontApi");
    const publishableKey = generatePublishableKey();
    const secretKey = generateSecretKey();

    const [created] = await db
      .insert(storefrontApiKeys)
      .values({
        businessId,
        integrationId: parsed.data.integrationId ?? null,
        name: parsed.data.name,
        publishableKey,
        secretKeyHash: hashSecretKey(secretKey),
        scopes: parsed.data.scopes as StorefrontScope[],
        allowedDomains: parsed.data.allowedDomains ?? null,
      })
      .returning({
        id: storefrontApiKeys.id,
        publishableKey: storefrontApiKeys.publishableKey,
      });
    if (!created) {
      throw new Error("Key insert returned no row.");
    }
    res.status(201).json({
      success: true,
      message:
        "API key created. The secret key is shown once — store it securely.",
      data: {
        id: created.id,
        name: parsed.data.name,
        publishableKey: created.publishableKey,
        secretKey, // one-time response
        scopes: parsed.data.scopes,
      },
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to create the API key right now.");
  }
}

export async function listKeys(req: Request, res: Response) {
  try {
    const keys = await db
      .select({
        id: storefrontApiKeys.id,
        name: storefrontApiKeys.name,
        publishableKey: storefrontApiKeys.publishableKey,
        scopes: storefrontApiKeys.scopes,
        allowedDomains: storefrontApiKeys.allowedDomains,
        environment: storefrontApiKeys.environment,
        requestCount: storefrontApiKeys.requestCount,
        lastUsedAt: storefrontApiKeys.lastUsedAt,
        revokedAt: storefrontApiKeys.revokedAt,
        createdAt: storefrontApiKeys.createdAt,
      })
      .from(storefrontApiKeys)
      .where(eq(storefrontApiKeys.businessId, getBusinessId(req)))
      .orderBy(desc(storefrontApiKeys.id))
      .limit(100);
    res.status(200).json({ success: true, data: keys });
  } catch (err) {
    sendSafeError(res, err, "Unable to load API keys right now.");
  }
}

export async function revokeKey(req: Request, res: Response) {
  const keyId = Number(req.params.keyId);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return res
      .status(400)
      .json({ success: false, message: "A valid key ID is required." });
  }
  try {
    const revoked = await db
      .update(storefrontApiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(storefrontApiKeys.id, keyId),
          eq(storefrontApiKeys.businessId, getBusinessId(req)),
          isNull(storefrontApiKeys.revokedAt),
        ),
      )
      .returning({ id: storefrontApiKeys.id });
    if (revoked.length === 0) {
      throw new ConflictError("Key not found or already revoked.");
    }
    res
      .status(200)
      .json({ success: true, message: "API key revoked. Storefronts using it fail immediately." });
  } catch (err) {
    sendSafeError(res, err, "Unable to revoke the API key right now.");
  }
}
