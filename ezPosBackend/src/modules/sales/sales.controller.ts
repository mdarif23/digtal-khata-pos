import type { Request, Response } from "express";
import * as salesService from "./sales.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { resolveOptionalLocationParam } from "../../middleware/location.js";
import { sendSafeError } from "../../utils/safeError.js";
import {
  createSalePayloadSchema,
  saleRefundRequestSchema,
  updateAvailableSerialSchema,
} from "./schemas/sales.schema.js";
import {
  dashboardPeriods,
  type DashboardPeriod,
} from "./dashboardMatrix.service.js";

function isDashboardPeriod(period: string): period is DashboardPeriod {
  return dashboardPeriods.some((supportedPeriod) => supportedPeriod === period);
}

export async function getSalesData(req: Request, res: Response) {
  try {
    const salesData = await salesService.getSalesData(getBusinessId(req));
    res.status(200).json(salesData);
  } catch (err) {
    sendSafeError(res, err, "Unable to load sales.");
  }
}

export async function getSaleReceipt(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "Invalid sale ID" });
    }
    const receipt = await salesService.getSaleReceipt(getBusinessId(req), id);
    return res.status(200).json(receipt);
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the receipt.");
  }
}

export async function createSale(req: Request, res: Response) {
  try {
    const result = createSalePayloadSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid sale data",
        errors: result.error.flatten(),
      });
    }
    // Discounts are a permission, not a UI convention: a cart-level or
    // line-level discount from a caller without pos.apply_discount is 403.
    const payload = result.data;
    const hasDiscount =
      (payload.discount?.value ?? 0) > 0 ||
      payload.items.some((item) => (item.discount?.value ?? 0) > 0);
    if (hasDiscount && !callerHasPermission(req, "pos.apply_discount")) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to apply discounts.",
      });
    }
    const sale = await salesService.createSale(
      getBusinessId(req),
      getLocationId(req),
      req.user!.id,
      payload,
    );
    return res
      .status(201)
      .json({ message: "Sale created successfully", data: sale });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the sale.");
  }
}
export async function createSingleRefund(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "Invalid sale item ID" });
    }
    const result = saleRefundRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid refund options",
        errors: result.error.flatten(),
      });
    }
    const { message, refundId } = await salesService.createSingleRefund(
      getBusinessId(req),
      id,
      result.data,
    );
    res.status(200).json({ message, refundId });
  } catch (err) {
    sendSafeError(res, err, "Unable to create the refund.");
  }
}
export async function createMultipleRefunds(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "Invalid sale ID" });
    }
    const result = saleRefundRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid refund options",
        errors: result.error.flatten(),
      });
    }
    const { message, refundId } = await salesService.createMultipleRefunds(
      getBusinessId(req),
      id,
      result.data,
    );
    res.status(200).json({ message, refundId });
  } catch (err) {
    sendSafeError(res, err, "Unable to create the refund.");
  }
}
export async function getDashboardSummary(req: Request, res: Response) {
  try {
    const period = req.query.period;
    const selectedPeriod = period === undefined ? "today" : period;
    if (typeof selectedPeriod !== "string") {
      return res.status(400).json({ message: "Invalid dashboard period" });
    }
    if (!isDashboardPeriod(selectedPeriod)) {
      return res.status(400).json({
        message:
          "Dashboard period must be today, yesterday, 7d, 30d, 60d, 90d, or 365d",
      });
    }
    const staleDaysQuery = req.query.staleDays;
    const staleDays = staleDaysQuery === undefined ? 60 : Number(staleDaysQuery);
    if (
      (typeof staleDaysQuery !== "undefined" &&
        typeof staleDaysQuery !== "string") ||
      ![30, 60, 90, 180].includes(staleDays)
    ) {
      return res.status(400).json({
        message: "Stale stock threshold must be 30, 60, 90, or 180 days",
      });
    }
    const staleLimitQuery = req.query.staleLimit;
    const staleLimit = staleLimitQuery === undefined ? 10 : Number(staleLimitQuery);
    if (
      (typeof staleLimitQuery !== "undefined" &&
        typeof staleLimitQuery !== "string") ||
      ![10, 20, 30, 50, 100].includes(staleLimit)
    ) {
      return res.status(400).json({
        message: "Stale stock limit must be 10, 20, 30, 50, or 100",
      });
    }
    // Optional location scope (?locationId) — validated against the
    // caller's server-side location assignments (403 when unauthorized).
    const locationId = await resolveOptionalLocationParam(req);
    const summary = await salesService.getDashboardSummary(
      getBusinessId(req),
      selectedPeriod,
      staleDays,
      staleLimit,
      locationId,
    );
    res.status(200).json(summary);
  } catch (err) {
    sendSafeError(res, err, "Unable to load the dashboard summary.");
  }
}
export async function getAvailableSerials(req: Request, res: Response) {
  try {
    const variantId = Number(req.params.variantId);
    if (isNaN(variantId)) {
      return res.status(400).json({ message: "Invalid Variant ID" });
    }
    const availableSerials = await salesService.getAvailableSerials(
      getBusinessId(req),
      variantId,
    );

    res.status(200).json(availableSerials);
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load available serials.");
  }
}

export async function updateAvailableSerial(req: Request, res: Response) {
  try {
    const variantId = Number(req.params.variantId);
    if (!Number.isInteger(variantId) || variantId <= 0) {
      return res.status(400).json({ message: "Invalid Variant ID" });
    }

    const result = updateAvailableSerialSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid serial number data",
        errors: result.error.flatten(),
      });
    }

    const serialNumber = await salesService.updateAvailableSerial(
      getBusinessId(req),
      variantId,
      result.data.currentSerial,
      result.data.serialNumber,
    );
    return res.status(200).json({ serialNumber });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the serial number.");
  }
}
