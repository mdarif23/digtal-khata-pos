import type { Request, Response } from "express";
import { z } from "zod";
import * as stockCountService from "./stockCount.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { sendSafeError } from "../../utils/safeError.js";

const createSchema = z.object({
  note: z.string().trim().max(500).optional(),
  variantIds: z.array(z.number().int().positive()).max(500).optional(),
});

const submitSchema = z.object({
  counts: z
    .array(
      z.object({
        variantId: z.number().int().positive(),
        countedQuantity: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(500),
});

function parseId(raw: string | string[] | undefined): number | null {
  if (typeof raw !== "string") return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function createSession(req: Request, res: Response) {
  try {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid stock-count data.",
        errors: parsed.error.flatten(),
      });
    }
    const result = await stockCountService.createStockCountSession({
      businessId: getBusinessId(req),
      locationId: getLocationId(req),
      actorUserId: req.user!.id,
      note: parsed.data.note ?? null,
      variantIds: parsed.data.variantIds,
    });
    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to start the stock count.");
  }
}

export async function listSessions(req: Request, res: Response) {
  try {
    const rows = await stockCountService.listStockCountSessions(
      getBusinessId(req),
      getLocationId(req),
    );
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to list stock counts.");
  }
}

export async function getSession(req: Request, res: Response) {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const result = await stockCountService.getStockCountSession(
      getBusinessId(req),
      getLocationId(req),
      id,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load the stock count.");
  }
}

export async function submitCount(req: Request, res: Response) {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid count submission.",
        errors: parsed.error.flatten(),
      });
    }
    const result = await stockCountService.submitStockCount(
      getBusinessId(req),
      getLocationId(req),
      id,
      req.user!.id,
      parsed.data.counts,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to record the counts.");
  }
}

export async function approveSession(req: Request, res: Response) {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const result = await stockCountService.approveStockCount(
      getBusinessId(req),
      getLocationId(req),
      id,
      req.user!.id,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to approve the stock count.");
  }
}

export async function cancelSession(req: Request, res: Response) {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const result = await stockCountService.cancelStockCount(
      getBusinessId(req),
      getLocationId(req),
      id,
      req.user!.id,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to cancel the stock count.");
  }
}
