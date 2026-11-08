import type { Request, Response } from "express";
import { z } from "zod";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError } from "../../utils/handleError.js";
import { isBarcodeFormat } from "./barcodes.validation.js";
import {
  assignBarcode,
  deleteAlias,
  generateBarcodes,
  getPrintHistory,
  getVariantBarcodes,
  logPrintJob,
  lookupBarcode,
  searchVariantsForBarcodes,
  updateAlias,
  validateOnly,
} from "./barcodes.service.js";

const searchSchema = z.object({
  search: z.string().trim().max(120).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  brandId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const assignSchema = z
  .object({
    variantId: z.coerce.number().int().positive(),
    barcode: z.string().max(100),
    format: z
      .string()
      .refine(isBarcodeFormat, "Unsupported barcode format.")
      .optional(),
    target: z.enum(["primary", "alias"]).default("primary"),
    replace: z.boolean().optional(),
    source: z.enum(["external", "internal"]).optional(),
    // UOM (migration 0062): alias-level package qualifier (a box-of-12
    // code). Primary barcodes are always the base unit.
    uomConversionId: z.coerce.number().int().positive().nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.barcode.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["barcode"], message: "Barcode is required." });
    }
  });

const generateSchema = z.object({
  variantIds: z.array(z.coerce.number().int().positive()).min(1).max(500),
  regenerate: z.boolean().optional(),
});

const validateSchema = z.object({
  barcode: z.string().max(100),
  format: z
    .string()
    .refine(isBarcodeFormat, "Unsupported barcode format.")
    .optional(),
  variantId: z.coerce.number().int().positive().optional(),
  aliasId: z.coerce.number().int().positive().optional(),
});

const aliasPatchSchema = z
  .object({
    barcode: z.string().max(100),
    format: z
      .string()
      .refine(isBarcodeFormat, "Unsupported barcode format.")
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.barcode.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["barcode"], message: "Barcode is required." });
    }
  });

const printLogSchema = z.object({
  variantCount: z.coerce.number().int().min(0).max(10_000),
  copies: z.coerce.number().int().min(1).max(1000),
  template: z.string().max(100).optional(),
});

function aliasIdParam(req: Request): number {
  const id = Number(req.params.aliasId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestError("Invalid alias ID.");
  }
  return id;
}

export async function getBarcodeSearch(req: Request, res: Response) {
  try {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid search parameters.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await searchVariantsForBarcodes(getBusinessId(req), parsed.data);
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to search products for barcodes.");
  }
}

export async function postGenerate(req: Request, res: Response) {
  try {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid generation request.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await generateBarcodes(getBusinessId(req), req.user?.id ?? null, parsed.data);
    return res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to generate barcodes.");
  }
}

export async function postAssign(req: Request, res: Response) {
  try {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid assignment request.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await assignBarcode(getBusinessId(req), req.user?.id ?? null, parsed.data);
    return res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to assign the barcode.");
  }
}

export async function getVariant(req: Request, res: Response) {
  try {
    const variantId = Number(req.params.variantId);
    if (!Number.isInteger(variantId) || variantId <= 0) {
      throw new BadRequestError("Invalid variant ID.");
    }
    const data = await getVariantBarcodes(getBusinessId(req), variantId);
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the variant barcodes.");
  }
}

export async function patchAlias(req: Request, res: Response) {
  try {
    const parsed = aliasPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid alias update.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await updateAlias(
      getBusinessId(req),
      req.user?.id ?? null,
      aliasIdParam(req),
      parsed.data,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the alias.");
  }
}

export async function deleteAliasHandler(req: Request, res: Response) {
  try {
    const data = await deleteAlias(getBusinessId(req), req.user?.id ?? null, aliasIdParam(req));
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to remove the alias.");
  }
}

export async function postValidate(req: Request, res: Response) {
  try {
    const parsed = validateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid validation request.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await validateOnly(getBusinessId(req), parsed.data, {
      variantId: parsed.data.variantId,
      aliasId: parsed.data.aliasId,
    });
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to validate the barcode.");
  }
}

export async function getLookup(req: Request, res: Response) {
  try {
    const code = typeof req.params.code === "string" ? req.params.code : "";
    if (code.trim() === "" || code.length > 100) {
      throw new BadRequestError("A barcode of at most 100 characters is required.");
    }
    const data = await lookupBarcode(getBusinessId(req), code, {
      // Stock is reported for the caller's verified active location.
      locationId: getLocationId(req),
      // Purchase costs stay hidden from POS-only roles (spec §17).
      includeCost:
        callerHasPermission(req, "purchases.view") ||
        callerHasPermission(req, "purchases.create"),
    });
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to resolve the barcode.");
  }
}

export async function getPrintHistoryHandler(req: Request, res: Response) {
  try {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    const data = await getPrintHistory(getBusinessId(req), limit);
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load print history.");
  }
}

export async function postPrintLog(req: Request, res: Response) {
  try {
    const parsed = printLogSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid print log entry.",
        errors: parsed.error.flatten(),
      });
    }
    await logPrintJob(getBusinessId(req), req.user?.id ?? null, parsed.data);
    return res.status(201).json({ success: true, data: { logged: true } });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to record the print job.");
  }
}
