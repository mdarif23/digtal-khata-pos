import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import {
  GROWTH_PERIOD_PRESETS,
  getCashFlow,
  getFinancialOverview,
  getGrowthAnalytics,
} from "./finance.overview.service.js";
import type { GrowthPeriodPreset } from "./finance.overview.service.js";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function dateParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" && isoDate.test(value) ? value : undefined;
}

export async function getOverview(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const from = dateParam(req, "from");
    const to = dateParam(req, "to");
    if (!from || !to || from > to) {
      return res.status(400).json({
        success: false,
        message: "Provide from and to dates (YYYY-MM-DD, from ≤ to).",
      });
    }
    const overview = await getFinancialOverview(businessId, from, to);
    res.json(overview);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the financial overview.");
  }
}

export async function getCashFlowReport(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const from = dateParam(req, "from");
    const to = dateParam(req, "to");
    if (!from || !to || from > to) {
      return res.status(400).json({
        success: false,
        message: "Provide from and to dates (YYYY-MM-DD, from ≤ to).",
      });
    }
    const report = await getCashFlow(businessId, from, to);
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the cash flow report.");
  }
}

export async function getGrowth(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const periodParam = req.query.period;
    const period =
      typeof periodParam === "string" &&
      (GROWTH_PERIOD_PRESETS as readonly string[]).includes(periodParam)
        ? (periodParam as GrowthPeriodPreset)
        : undefined;
    const from = dateParam(req, "from");
    const to = dateParam(req, "to");
    if (!period && (!from || !to)) {
      return res.status(400).json({
        success: false,
        message:
          "Provide a period preset (today, yesterday, this_week, last_week, this_month, last_month, this_quarter, last_quarter, this_year, last_year) or a custom from/to range.",
      });
    }
    const report = await getGrowthAnalytics(businessId, {
      ...(period != null ? { period } : {}),
      ...(from != null ? { from } : {}),
      ...(to != null ? { to } : {}),
    });
    res.json(report);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the growth report.");
  }
}
