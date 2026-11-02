import { SignJWT, jwtVerify } from "jose";
import { env } from "../../config/env.js";

/**
 * Signed preview tokens let the portal open a storefront's DRAFT config in
 * the renderer (preview mode) without publishing. Tokens are short-lived,
 * carry no PII, and are only accepted by the renderer's preview surface.
 */
const PREVIEW_TTL_SECONDS = 60 * 60 * 4; // 4 hours

function key(): Uint8Array {
  return new TextEncoder().encode(env.jwtSecret);
}

export async function createPreviewToken(
  businessId: number,
  storefrontId: number,
): Promise<string> {
  return new SignJWT({
    scope: "storefront_preview",
    businessId,
    storefrontId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${PREVIEW_TTL_SECONDS}s`)
    .sign(key());
}

export interface StorefrontPreviewClaims {
  businessId: number;
  storefrontId: number;
}

export async function verifyPreviewToken(
  token: string,
): Promise<StorefrontPreviewClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key());
    if (
      payload.scope !== "storefront_preview" ||
      typeof payload.businessId !== "number" ||
      typeof payload.storefrontId !== "number"
    ) {
      return null;
    }
    return {
      businessId: payload.businessId,
      storefrontId: payload.storefrontId,
    };
  } catch {
    return null;
  }
}
