import type { Request, Response } from "express";
import { z } from "zod";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError } from "../../utils/handleError.js";
import {
  convertQuotation,
  createQuotation,
  getQuotationDetail,
  listQuotations,
  transitionQuotation,
  updateQuotationDraft,
} from "./quotations.service.js";

const itemSchema = z.object({
  variantId: z.number().int().positive(),
  quantity: z.number().positive().max(1_000_000),
  unitPrice: z.number().min(0).max(100_000_000),
  discount: z.number().min(0).max(100_000_000).optional(),
});

const quotationSchema = z.object({
  customerId: z.number().int().positive().nullable(),
  customerNameSnapshot: z.string().trim().max(255).nullable().optional(),
  items: z.array(itemSchema).min(1).max(200),
  vatPercent: z.number().min(0).max(100),
  notes: z.string().trim().max(2000).nullable().optional(),
  terms: z.string().trim().max(2000).nullable().optional(),
  validUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

const listSchema = z.object({
  status: z
    .enum(["draft", "sent", "accepted", "rejected", "expired", "converted", "cancelled"])
    .optional(),
  search: z.string().trim().max(120).optional(),
});

export async function postQuotation(req: Request, res: Response) {
  try {
    const parsed = quotationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid quotation data.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await createQuotation(
      getBusinessId(req),
      getLocationId(req),
      req.user!.id,
      {
        customerId: parsed.data.customerId,
        customerNameSnapshot: parsed.data.customerNameSnapshot ?? null,
        items: parsed.data.items,
        vatPercent: parsed.data.vatPercent,
        notes: parsed.data.notes ?? null,
        terms: parsed.data.terms ?? null,
        validUntil: parsed.data.validUntil ?? null,
      },
    );
    return res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the quotation.");
  }
}

export async function patchQuotation(req: Request, res: Response) {
  try {
    const quotationId = Number(req.params.quotationId);
    if (!Number.isInteger(quotationId) || quotationId <= 0) {
      throw new BadRequestError("Invalid quotation ID.");
    }
    const parsed = quotationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid quotation data.",
        errors: parsed.error.flatten(),
      });
    }
    await updateQuotationDraft(getBusinessId(req), req.user!.id, quotationId, {
      customerId: parsed.data.customerId,
      customerNameSnapshot: parsed.data.customerNameSnapshot ?? null,
      items: parsed.data.items,
      vatPercent: parsed.data.vatPercent,
      notes: parsed.data.notes ?? null,
      terms: parsed.data.terms ?? null,
      validUntil: parsed.data.validUntil ?? null,
    });
    return res.status(200).json({ success: true });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the quotation.");
  }
}

export async function postTransition(req: Request, res: Response) {
  try {
    const quotationId = Number(req.params.quotationId);
    if (!Number.isInteger(quotationId) || quotationId <= 0) {
      throw new BadRequestError("Invalid quotation ID.");
    }
    const to = z
      .enum(["sent", "accepted", "rejected", "cancelled"])
      .safeParse(req.body?.status);
    if (!to.success) {
      throw new BadRequestError("Invalid status transition.");
    }
    const data = await transitionQuotation(
      getBusinessId(req),
      req.user!.id,
      quotationId,
      to.data,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the quotation status.");
  }
}

const convertSchema = z.object({
  payments: z
    .array(
      z.object({
        method: z.string().min(1).max(30),
        amount: z.number().min(0).optional(),
        reference: z.string().max(200).optional(),
        tendered: z.number().min(0).optional(),
      }),
    )
    .min(1)
    .max(10),
});

export async function postConvert(req: Request, res: Response) {
  try {
    const quotationId = Number(req.params.quotationId);
    if (!Number.isInteger(quotationId) || quotationId <= 0) {
      throw new BadRequestError("Invalid quotation ID.");
    }
    const parsed = convertSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversion payments.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await convertQuotation(
      getBusinessId(req),
      getLocationId(req),
      req.user!.id,
      quotationId,
      { payments: parsed.data.payments },
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to convert the quotation.");
  }
}

export async function getQuotations(req: Request, res: Response) {
  try {
    const parsed = listSchema.safeParse(req.query);
    const data = await listQuotations(getBusinessId(req), {
      ...(parsed.success && parsed.data.status
        ? { status: parsed.data.status }
        : {}),
      ...(parsed.success && parsed.data.search
        ? { search: parsed.data.search }
        : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
      ...(req.query.offset ? { offset: Number(req.query.offset) } : {}),
    });
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load quotations.");
  }
}

export async function getQuotation(req: Request, res: Response) {
  try {
    const quotationId = Number(req.params.quotationId);
    if (!Number.isInteger(quotationId) || quotationId <= 0) {
      throw new BadRequestError("Invalid quotation ID.");
    }
    const data = await getQuotationDetail(getBusinessId(req), quotationId);
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the quotation.");
  }
}
