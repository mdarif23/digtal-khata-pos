import type { Request, Response } from "express";
import { z } from "zod";
import * as salesService from "./sales.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

const exchangeSchema = z.object({
  returns: z
    .array(z.object({ saleItemId: z.number().int().positive() }))
    .min(1)
    .max(50),
  replacements: z
    .array(
      z.object({
        variantId: z.number().int().positive(),
        quantity: z.number().int().positive(),
        discount: z
          .object({
            type: z.enum(["percentage", "fixed"]),
            value: z.number().min(0),
          })
          .nullable()
          .optional(),
      }),
    )
    .min(1)
    .max(50),
  additionalPayments: z
    .array(
      z.object({
        method: z.enum(["cash", "bangla_qr", "card"]),
        amount: z.number().positive(),
        reference: z.string().trim().max(100).nullable().optional(),
        tendered: z.number().nonnegative().nullable().optional(),
      }),
    )
    .max(5)
    .optional(),
  refundMethod: z.enum(["cash", "original_payment"]).optional(),
  reason: z.enum([
    "customer_request",
    "wrong_item",
    "damaged",
    "quality_issue",
    "other",
  ]),
  notes: z.string().trim().max(500).optional(),
  disposition: z.enum(["restock", "inspection", "damaged"]),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});

export async function createExchange(req: Request, res: Response) {
  try {
    const saleId = Number(req.params.id);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid sale ID." });
    }
    const parsed = exchangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid exchange data.",
        errors: parsed.error.flatten(),
      });
    }
    const result = await salesService.createSaleExchange(
      getBusinessId(req),
      saleId,
      req.user?.id ?? null,
      parsed.data,
    );
    return res
      .status(result.replayed ? 200 : 201)
      .json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the exchange.");
  }
}
