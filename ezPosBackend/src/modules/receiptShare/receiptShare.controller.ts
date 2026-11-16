import type { Request, Response } from "express";
import { z } from "zod";
import * as receiptShareService from "../../services/receiptShare.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

const createLinkSchema = z.object({
  /** Hours the link stays live. Absent = the 72h default (D12). */
  ttlHours: z.union([z.literal(24), z.literal(72), z.literal(168)]).optional(),
});

const revokeLinkSchema = z.object({
  /** Absent = revoke ALL live links for the sale. */
  tokenId: z.number().int().positive().nullish(),
});

function parseSaleId(req: Request): number | null {
  const saleId = Number(req.params.saleId);
  return Number.isInteger(saleId) && saleId > 0 ? saleId : null;
}

export async function createLink(req: Request, res: Response) {
  try {
    const saleId = parseSaleId(req);
    if (saleId === null) {
      return res.status(400).json({ success: false, message: "Invalid sale ID." });
    }
    const parsed = createLinkSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid link data.",
        errors: parsed.error.flatten(),
      });
    }
    const link = await receiptShareService.createReceiptShareLink(
      getBusinessId(req),
      saleId,
      req.user?.id ?? null,
      parsed.data.ttlHours ?? null,
    );
    // The plaintext token is returned EXACTLY once — only its hash is stored.
    return res.status(201).json({ success: true, data: link });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the receipt link.");
  }
}

export async function revokeLink(req: Request, res: Response) {
  try {
    const saleId = parseSaleId(req);
    if (saleId === null) {
      return res.status(400).json({ success: false, message: "Invalid sale ID." });
    }
    const parsed = revokeLinkSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid revoke data.",
        errors: parsed.error.flatten(),
      });
    }
    const result = await receiptShareService.revokeReceiptShareLink(
      getBusinessId(req),
      saleId,
      parsed.data.tokenId ?? null,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to revoke the receipt link.");
  }
}

export async function listLinks(req: Request, res: Response) {
  try {
    const saleId = parseSaleId(req);
    if (saleId === null) {
      return res.status(400).json({ success: false, message: "Invalid sale ID." });
    }
    const links = await receiptShareService.listReceiptShareLinks(
      getBusinessId(req),
      saleId,
    );
    return res.status(200).json({ success: true, data: links });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to list the receipt links.");
  }
}

/**
 * PUBLIC, unauthenticated fetch (rate-limited at the app edge): resolves the
 * hashed token to the live receipt payload. An expired/revoked/unknown token
 * is a uniform 404 — nothing about the sale leaks.
 */
export async function getPublicReceipt(req: Request, res: Response) {
  try {
    const token = String(req.params.token ?? "");
    const receipt = await receiptShareService.getPublicReceiptByToken(token);
    return res.status(200).json({ success: true, data: receipt });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Receipt link not found.");
  }
}
