import express from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getBusinessId,
  requireBusinessContext,
} from "../../middleware/business.js";
import { requireLocationAccess, getLocationId } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError } from "../../utils/handleError.js";
import {
  exportCustomers,
  exportExpenses,
  exportInventory,
  exportPurchases,
  exportSales,
  exportSalesLines,
  exportSuppliers,
  requireDateRange,
} from "./exports.service.js";

const router = express.Router();

const read = [requireAuth, requireBusinessContext()] as const;

function sendCsv(res: Response, file: { filename: string; contentType: string; body: string }) {
  res
    .status(200)
    .set("Content-Type", file.contentType)
    .set("Content-Disposition", `attachment; filename="${file.filename}"`)
    .send(file.body);
}

function optionalSearch(req: Request): string | undefined {
  const raw = req.query.search;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return `%${raw.trim().replace(/[%_]/g, "\\$&")}%`;
}

function optionalLocationId(req: Request): number | undefined {
  const raw = req.query.locationId;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestError("Invalid locationId.");
  }
  return id;
}

// Exports are permission-gated per entity; requireView is applied per route.
const requireView = (key: string) => requirePermission(key);

router.get(
  "/api/export/customers",
  ...read,
  requireView("customers.view"),
  async (req: Request, res: Response) => {
    try {
      const file = await exportCustomers(getBusinessId(req), optionalSearch(req));
      sendCsv(res, file);
    } catch (err: unknown) {
      sendSafeError(res, err, "Unable to export customers.");
    }
  },
);

router.get(
  "/api/export/suppliers",
  ...read,
  requireView("suppliers.view"),
  async (req: Request, res: Response) => {
    try {
      const file = await exportSuppliers(getBusinessId(req), optionalSearch(req));
      sendCsv(res, file);
    } catch (err: unknown) {
      sendSafeError(res, err, "Unable to export suppliers.");
    }
  },
);

router.get(
  "/api/export/sales",
  ...read,
  requirePermission("reports.sales.view"),
  async (req: Request, res: Response) => {
    try {
      const range = requireDateRange(req.query as Record<string, unknown>);
      const file = await exportSales(
        getBusinessId(req),
        range,
        optionalLocationId(req),
      );
      sendCsv(res, file);
    } catch (err: unknown) {
      sendSafeError(res, err, "Unable to export sales.");
    }
  },
);

router.get(
  "/api/export/sales-lines",
  ...read,
  requirePermission("reports.sales.view"),
  async (req: Request, res: Response) => {
    try {
      const range = requireDateRange(req.query as Record<string, unknown>);
      const file = await exportSalesLines(
        getBusinessId(req),
        range,
        optionalLocationId(req),
      );
      sendCsv(res, file);
    } catch (err: unknown) {
      sendSafeError(res, err, "Unable to export sale lines.");
    }
  },
);

router.get(
  "/api/export/purchases",
  ...read,
  requirePermission("reports.purchase.view"),
  async (req: Request, res: Response) => {
    try {
      const range = requireDateRange(req.query as Record<string, unknown>);
      const file = await exportPurchases(getBusinessId(req), range);
      sendCsv(res, file);
    } catch (err: unknown) {
      sendSafeError(res, err, "Unable to export purchases.");
    }
  },
);

router.get(
  "/api/export/expenses",
  ...read,
  requirePermission("reports.expense.view"),
  async (req: Request, res: Response) => {
    try {
      const range = requireDateRange(req.query as Record<string, unknown>);
      const file = await exportExpenses(getBusinessId(req), range);
      sendCsv(res, file);
    } catch (err: unknown) {
      sendSafeError(res, err, "Unable to export expenses.");
    }
  },
);

// Inventory is location-scoped: the X-Location-Id header (or default) is
// verified by the location middleware; cost columns need products.view_cost.
router.get(
  "/api/export/inventory",
  ...read,
  requireLocationAccess(),
  requirePermission("inventory.view"),
  async (req: Request, res: Response) => {
    try {
      const includeCost = callerHasPermission(req, "products.view_cost");
      const file = await exportInventory(
        getBusinessId(req),
        getLocationId(req),
        includeCost,
      );
      sendCsv(res, file);
    } catch (err: unknown) {
      sendSafeError(res, err, "Unable to export inventory.");
    }
  },
);

export default router;
