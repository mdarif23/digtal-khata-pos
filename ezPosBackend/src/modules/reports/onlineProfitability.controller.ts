import type { Request, Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { locations } from "../../db/schema/locations.js";
import { NotFoundError } from "../../utils/handleError.js";
import {
  getProfitabilityChannels,
  getProfitabilityExpenses,
  getProfitabilityProducts,
  getProfitabilitySummary,
  getProfitabilityTrends,
  type ProfitabilityFilters,
} from "./onlineProfitability.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const filtersSchema = z.object({
  from: dateParam.optional(),
  to: dateParam.optional(),
  locationId: z.coerce.number().int().positive().optional(),
  channel: z.enum(["woocommerce", "custom_storefront"]).optional(),
  courierName: z.string().trim().max(120).optional(),
  paymentMethod: z.string().trim().max(50).optional(),
});

const productsSchema = filtersSchema.extend({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
  sort: z.enum(["profit", "margin", "losses"]).optional(),
});

type FiltersQuery = z.infer<typeof filtersSchema>;

async function assertLocationInBusiness(
  businessId: number,
  filters: FiltersQuery,
) {
  if (filters.locationId) {
    const [location] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(
        and(
          eq(locations.id, filters.locationId),
          eq(locations.businessId, businessId),
        ),
      )
      .limit(1);
    if (!location) throw new NotFoundError("Location not found.");
  }
}

async function parseAndValidate(
  req: Request,
): Promise<FiltersQuery | null> {
  const parsed = filtersSchema.safeParse(req.query);
  if (!parsed.success) return null;
  await assertLocationInBusiness(getBusinessId(req), parsed.data);
  return parsed.data;
}

export async function getOnlineProfitabilitySummary(req: Request, res: Response) {
  const filters = await parseAndValidate(req);
  if (!filters) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid report filters." });
  }
  try {
    res.status(200).json({
      success: true,
      data: await getProfitabilitySummary(getBusinessId(req), filters),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to build the profitability report right now.");
  }
}

export async function getOnlineProfitabilityTrends(req: Request, res: Response) {
  const filters = await parseAndValidate(req);
  if (!filters) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid report filters." });
  }
  try {
    res.status(200).json({
      success: true,
      data: await getProfitabilityTrends(getBusinessId(req), filters),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to build the profitability trends right now.");
  }
}

export async function getOnlineProfitabilityProducts(req: Request, res: Response) {
  const parsed = productsSchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid report filters." });
  }
  try {
    await assertLocationInBusiness(getBusinessId(req), parsed.data);
    const { page, pageSize, sort, ...filters } = parsed.data;
    res.status(200).json({
      success: true,
      data: await getProfitabilityProducts(
        getBusinessId(req),
        filters as ProfitabilityFilters,
        { page, pageSize, sort },
      ),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to build product profitability right now.");
  }
}

export async function getOnlineProfitabilityChannels(req: Request, res: Response) {
  const filters = await parseAndValidate(req);
  if (!filters) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid report filters." });
  }
  try {
    res.status(200).json({
      success: true,
      data: await getProfitabilityChannels(getBusinessId(req), filters),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to build channel profitability right now.");
  }
}

export async function getOnlineProfitabilityExpenses(req: Request, res: Response) {
  const filters = await parseAndValidate(req);
  if (!filters) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid report filters." });
  }
  try {
    res.status(200).json({
      success: true,
      data: await getProfitabilityExpenses(getBusinessId(req), filters),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to build the expense breakdown right now.");
  }
}
