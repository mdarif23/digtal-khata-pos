import type { Request, Response } from "express";
import { z } from "zod";
import * as giftCardsService from "../../services/giftCards.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

const issueSchema = z.object({
  initialAmount: z.number().positive(),
  expiresAt: z.string().datetime().nullable().optional(),
  customerId: z.number().int().positive().nullable().optional(),
  note: z.string().trim().max(300).optional(),
});

const lookupSchema = z.object({ code: z.string().trim().min(8).max(40) });

export async function listGiftCards(req: Request, res: Response) {
  try {
    const cards = await giftCardsService.listGiftCards(getBusinessId(req));
    return res.status(200).json({ success: true, data: cards });
  } catch (err) {
    return sendSafeError(res, err, "Unable to list gift cards.");
  }
}

/**
 * Issues a gift card. The FULL code is returned exactly once in this
 * response and is never recoverable — only its SHA-256 hash is stored.
 */
export async function issueGiftCard(req: Request, res: Response) {
  try {
    const parsed = issueSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid gift card data.",
        errors: parsed.error.flatten(),
      });
    }
    const card = await giftCardsService.issueGiftCard({
      businessId: getBusinessId(req),
      actorUserId: req.user?.id ?? null,
      initialAmount: parsed.data.initialAmount,
      expiresAt: parsed.data.expiresAt ?? null,
      customerId: parsed.data.customerId ?? null,
      note: parsed.data.note ?? null,
    });
    return res.status(201).json({ success: true, data: card });
  } catch (err) {
    return sendSafeError(res, err, "Unable to issue the gift card.");
  }
}

export async function lookupGiftCard(req: Request, res: Response) {
  try {
    const parsed = lookupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, message: "Enter the full card code." });
    }
    const target = await giftCardsService.lookupGiftCardForRedeem(
      getBusinessId(req),
      parsed.data.code,
    );
    return res.status(200).json({ success: true, data: target });
  } catch (err) {
    return sendSafeError(res, err, "Unable to look up the gift card.");
  }
}

export async function getGiftCard(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const detail = await giftCardsService.getGiftCardDetail(getBusinessId(req), id);
    return res.status(200).json({ success: true, data: detail });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load the gift card.");
  }
}

export async function setGiftCardStatus(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const status = req.body?.status;
    if (status !== "active" && status !== "inactive") {
      return res.status(400).json({ success: false, message: "Invalid status." });
    }
    const result = await giftCardsService.setGiftCardStatus(
      getBusinessId(req),
      id,
      status,
      req.user?.id ?? null,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the gift card.");
  }
}
