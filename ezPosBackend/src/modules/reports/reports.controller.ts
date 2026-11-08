import type { Request, Response } from "express";
import { dateRangeSchema } from "./reports.validation.js";
import * as reportsService from "./reports.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import { resolveOptionalLocationParam } from "../../middleware/location.js";

// Every report handler forwards the server-verified businessId from
// requireBusinessContext into the service, which injects it into every
// raw-SQL fragment. No report can aggregate across businesses.

function getValidatedParams(req: Request) {
  const parsed = dateRangeSchema.safeParse(req.query);
  if (!parsed.success) {
    throw new Error(
      `Invalid report parameters: ${parsed.error.issues.map((i) => i.message).join(", ")}`
    );
  }
  return parsed.data;
}

const resolveReportLocation = resolveOptionalLocationParam;

export async function getSalesSummary(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getSalesSummaryReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getSalesByInvoice(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getSalesByInvoiceReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getSaleRefundItems(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getSaleRefundItemsReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getPurchaseItems(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getPurchaseItemsReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getProductSales(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getProductSalesReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getCustomerSales(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getCustomerSalesReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getPaymentMethods(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getPaymentMethodReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getSaleRefunds(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getSaleRefundsReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getProfit(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getProfitReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getExpenses(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getExpenseReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getCustomerReceivables(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getCustomerReceivablesReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getStock(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getStockReport(getBusinessId(req), params, locationId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getStockMovements(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getStockMovementReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getBatchExpiry(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getBatchExpiryReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getPurchaseSummary(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getPurchaseSummaryReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getSupplierPayables(req: Request, res: Response) {
  try {
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getSupplierPayablesReport(
      getBusinessId(req),
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getHourlySales(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getHourlySalesReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getTaxReconciliation(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getTaxReconciliationReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getInventoryShrinkage(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getInventoryShrinkageReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getRegisterClose(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getRegisterCloseReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

// Report errors never leak internals: log server-side, return a generic body.
export async function getLocationComparison(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const data = await reportsService.getLocationComparisonReport(
      getBusinessId(req),
      params,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

function sendSafe(err: unknown, res: Response) {
  sendSafeError(res, err, "Unable to generate this report right now.");
}

export async function getInventoryAging(req: Request, res: Response) {
  try {
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getInventoryAgingReport(
      getBusinessId(req),
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getDeadStock(req: Request, res: Response) {
  try {
    const locationId = await resolveReportLocation(req);
    const days = Number(req.query.days ?? 60);
    const windowDays = Number.isFinite(days) && days >= 1 && days <= 365 ? Math.floor(days) : 60;
    const data = await reportsService.getDeadStockReport(
      getBusinessId(req),
      windowDays,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getChannelPerformance(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getChannelPerformanceReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getCustomerLifetimeValue(req: Request, res: Response) {
  try {
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getCustomerLifetimeValueReport(
      getBusinessId(req),
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getCustomerRetention(req: Request, res: Response) {
  try {
    const data = await reportsService.getCustomerRetentionReport(
      getBusinessId(req),
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getStaffPerformance(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getStaffPerformanceReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getSalesForecast(req: Request, res: Response) {
  try {
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getSalesForecastReport(
      getBusinessId(req),
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

// --- Pricing attribution reports (Phase 7) ----------------------------------

export async function getGroupProfitability(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getGroupProfitabilityReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}

export async function getPromotionPerformance(req: Request, res: Response) {
  try {
    const params = getValidatedParams(req);
    const locationId = await resolveReportLocation(req);
    const data = await reportsService.getPromotionPerformanceReport(
      getBusinessId(req),
      params,
      locationId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    sendSafe(err, res);
  }
}
