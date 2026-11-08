import type { Request, Response } from "express";
import { z } from "zod";
import * as salesService from "./sales.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { getTerminalId } from "../../middleware/terminalContext.js";
import { getLocationId } from "../../middleware/location.js";
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
        // ENTERED quantity — fractional allowed only with a packaging unit.
        quantity: z.number().positive(),
        discount: z
          .object({
            type: z.enum(["percentage", "fixed"]),
            value: z.number().min(0),
          })
          .nullable()
          .optional(),
        uomConversionId: z.number().int().positive().nullish(),
      }),
    )
    .min(1)
    .max(50)
    // Identity lines stay integer (legacy contract).
    .refine(
      (items) =>
        items.every(
          (i) => i.uomConversionId != null || Number.isInteger(i.quantity),
        ),
      { message: "Quantity must be a whole number." },
    ),
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
      getTerminalId(req),
    );
    return res
      .status(result.replayed ? 200 : 201)
      .json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the exchange.");
  }
}

const quoteSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.number().int().positive(),
        // ENTERED quantity — fractional allowed only with a packaging unit.
        quantity: z.number().positive(),
        discount: z
          .object({
            type: z.enum(["percentage", "fixed"]),
            value: z.number().min(0),
          })
          .nullable()
          .optional(),
        uomConversionId: z.number().int().positive().nullish(),
        // Phase 6 preview: the quoted total reflects a permitted price
        // override before checkout (the createSale gate still applies).
        priceOverride: z
          .object({
            unitPrice: z.number().min(0),
            reason: z.string().trim().max(300).optional(),
          })
          .nullish(),
      }),
    )
    .min(1)
    .max(200)
    .refine(
      (items) =>
        items.every(
          (i) => i.uomConversionId != null || Number.isInteger(i.quantity),
        ),
      { message: "Quantity must be a whole number." },
    ),
  cartDiscount: z
    .object({
      type: z.enum(["percentage", "fixed"]),
      value: z.number().min(0),
    })
    .nullable()
    .optional(),
  vatPercent: z.number().min(0).max(100).nullable().optional(),
  couponCode: z.string().trim().min(1).max(60).nullable().optional(),
  customerId: z.number().int().positive().nullable().optional(),
});

export async function quote(req: Request, res: Response) {
  try {
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid quote data.",
        errors: parsed.error.flatten(),
      });
    }
    const totals = await salesService.quoteSaleTotals(
      getBusinessId(req),
      getLocationId(req),
      parsed.data,
    );
    return res.status(200).json({ success: true, data: totals });
  } catch (err) {
    return sendSafeError(res, err, "Unable to quote the cart.");
  }
}
