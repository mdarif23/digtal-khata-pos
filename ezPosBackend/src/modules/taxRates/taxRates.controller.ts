import type { Request, Response } from "express";
import { z } from "zod";
import * as taxRatesService from "./taxRates.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

const optionalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .nullable()
  .optional();

const taxRatePayloadSchema = z.object({
  name: z.string().trim().min(1).max(80),
  rate: z.number().min(0).max(100),
  isInclusive: z.boolean(),
  locationId: z.number().int().positive().nullable().optional(),
  validFrom: optionalDate,
  validTo: optionalDate,
  isDefault: z.boolean().optional(),
});

const taxRateUpdateSchema = taxRatePayloadSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const productTaxesSchema = z.object({
  taxRateIds: z.array(z.number().int().positive()).max(10),
});

function parseId(raw: string | string[] | undefined): number | null {
  if (typeof raw !== "string") return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function listTaxRates(req: Request, res: Response) {
  try {
    const includeInactive = req.query.includeInactive === "true";
    const rates = await taxRatesService.listTaxRates(
      getBusinessId(req),
      includeInactive,
    );
    res.status(200).json({ success: true, data: rates });
  } catch (err) {
    sendSafeError(res, err, "Unable to list tax rates.");
  }
}

export async function createTaxRate(req: Request, res: Response) {
  try {
    const parsed = taxRatePayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid tax rate data.",
        errors: parsed.error.flatten(),
      });
    }
    const rate = await taxRatesService.createTaxRate(
      getBusinessId(req),
      req.user?.id ?? null,
      parsed.data,
    );
    res.status(201).json({ success: true, data: rate });
  } catch (err) {
    sendSafeError(res, err, "Unable to create the tax rate.");
  }
}

export async function updateTaxRate(req: Request, res: Response) {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ success: false, message: "Invalid tax rate ID." });
    }
    const parsed = taxRateUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid tax rate data.",
        errors: parsed.error.flatten(),
      });
    }
    const rate = await taxRatesService.updateTaxRate(
      getBusinessId(req),
      id,
      req.user?.id ?? null,
      parsed.data,
    );
    res.status(200).json({ success: true, data: rate });
  } catch (err) {
    sendSafeError(res, err, "Unable to update the tax rate.");
  }
}

export async function deactivateTaxRate(req: Request, res: Response) {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ success: false, message: "Invalid tax rate ID." });
    }
    const rate = await taxRatesService.deactivateTaxRate(
      getBusinessId(req),
      id,
      req.user?.id ?? null,
    );
    res.status(200).json({ success: true, data: rate });
  } catch (err) {
    sendSafeError(res, err, "Unable to deactivate the tax rate.");
  }
}

export async function getProductTaxRates(req: Request, res: Response) {
  try {
    const productId = parseId(req.params.productId);
    if (productId === null) {
      return res.status(400).json({ success: false, message: "Invalid product ID." });
    }
    const rates = await taxRatesService.getProductTaxRates(
      getBusinessId(req),
      productId,
    );
    res.status(200).json({ success: true, data: rates });
  } catch (err) {
    sendSafeError(res, err, "Unable to list the product's tax rates.");
  }
}

export async function setProductTaxRates(req: Request, res: Response) {
  try {
    const productId = parseId(req.params.productId);
    if (productId === null) {
      return res.status(400).json({ success: false, message: "Invalid product ID." });
    }
    const parsed = productTaxesSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid tax rate assignment.",
        errors: parsed.error.flatten(),
      });
    }
    const result = await taxRatesService.setProductTaxRates(
      getBusinessId(req),
      productId,
      req.user?.id ?? null,
      parsed.data.taxRateIds,
    );
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    sendSafeError(res, err, "Unable to assign tax rates to the product.");
  }
}
