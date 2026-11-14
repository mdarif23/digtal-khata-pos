import type { Request, Response } from "express";
import * as salesService from "./sales.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { getTerminalId } from "../../middleware/terminalContext.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { resolveOptionalLocationParam } from "../../middleware/location.js";
import { listAccessibleLocationIds } from "../locations/locations.service.js";
import { WILDCARD_PERMISSION } from "../../rbac/permissions.js";
import { stripCostData } from "../../rbac/sanitize.js";
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
    const businessId = getBusinessId(req);
    // L1-2: scope the listing to the caller's server-verified location
    // assignments — the route chain checked ACCESS but the query was
    // business-wide, so restricted staff could read other locations' sales.
    // Owners (wildcard) keep the business-wide view.
    const membership = req.membership;
    const callerIsOwner =
      membership?.permissions.includes(WILDCARD_PERMISSION) ?? false;
    const accessibleLocationIds = callerIsOwner
      ? null
      : await listAccessibleLocationIds(businessId, req.user!.id, false);
    const salesData = await salesService.getSalesData(businessId, {
      accessibleLocationIds,
    });
    // Q1-1: per-line cost is margin data — callers without
    // products.view_cost never receive it (same rule as the catalog).
    res
      .status(200)
      .json(
        callerHasPermission(req, "products.view_cost")
          ? salesData
          : stripCostData(salesData),
      );
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
    // Price overrides (Phase 6) are their own permission: the cashier's
    // typed price replaces the DB selling price for the line only.
    const hasOverride = payload.items.some((item) => item.priceOverride != null);
    if (hasOverride && !callerHasPermission(req, "pricing.price_override")) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to override prices.",
      });
    }
    const sale = await salesService.createSale(
      getBusinessId(req),
      getLocationId(req),
      req.user!.id,
      payload,
      getTerminalId(req),
      {
        // Below-minimum lines are blocked unless the caller holds the
        // override permission (then a reason is mandatory and audited).
        allowBelowMinimum: callerHasPermission(req, "pricing.below_minimum_override"),
      },
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
    const { saleItemSaleId: _internal, ...refundResult } =
      await salesService.createSingleRefund(
        getBusinessId(req),
        id,
        result.data,
        req.user?.id ?? null,
      );
    void _internal;
    res.status(200).json(refundResult);
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
    const refundResult = await salesService.createMultipleRefunds(
      getBusinessId(req),
      id,
      result.data,
      req.user?.id ?? null,
    );
    res.status(200).json(refundResult);
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
