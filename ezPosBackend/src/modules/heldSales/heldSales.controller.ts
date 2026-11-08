import type { Request, Response } from "express";
import { z } from "zod";
import * as heldSalesService from "./heldSales.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { sendSafeError } from "../../utils/safeError.js";

const heldItemSchema = z.object({
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
  serialNumbers: z.array(z.string().trim().min(1)).max(200).optional(),
  productName: z.string().trim().min(1).max(255),
  // UOM (migration 0062): the hold stores the entered unit; resume
  // re-resolves the factor from the live packaging row.
  uomConversionId: z.number().int().positive().nullish(),
}).superRefine((data, ctx) => {
  if (data.uomConversionId == null && !Number.isInteger(data.quantity)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["quantity"],
      message: "Quantity must be a whole number.",
    });
  }
});

const createSchema = z.object({
  name: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
  items: z.array(heldItemSchema).min(1).max(200),
});

export async function createHeld(req: Request, res: Response) {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid held sale data.",
        errors: parsed.error.flatten(),
      });
    }
    const created = await heldSalesService.createHeldSale({
      businessId: getBusinessId(req),
      locationId: getLocationId(req),
      actorUserId: req.user!.id,
      name:
        parsed.data.name?.trim() ||
        `Hold ${new Date().toLocaleTimeString()}`,
      items: parsed.data.items.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
        discount: item.discount ?? null,
        ...(item.serialNumbers ? { serialNumbers: item.serialNumbers } : {}),
        productName: item.productName,
        uomConversionId: item.uomConversionId ?? null,
        enteredQuantity: item.uomConversionId != null ? item.quantity : null,
      })),
      note: parsed.data.note ?? null,
    });
    return res.status(201).json({ success: true, data: created });
  } catch (err) {
    return sendSafeError(res, err, "Unable to hold the sale.");
  }
}

export async function listHeld(req: Request, res: Response) {
  try {
    const rows = await heldSalesService.listHeldSales(
      getBusinessId(req),
      getLocationId(req),
    );
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to list held sales.");
  }
}

export async function deleteHeld(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const result = await heldSalesService.deleteHeldSale(
      getBusinessId(req),
      getLocationId(req),
      id,
      req.user?.id ?? null,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to discard the held sale.");
  }
}
