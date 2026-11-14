import express from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getBusinessId,
  requireBusinessContext,
} from "../../middleware/business.js";
import {
  requireLocationAccess,
  getLocationId,
  resolveOptionalLocationParam,
} from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { recordAudit } from "../../services/audit.js";
import { sendSafeError } from "../../utils/safeError.js";
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

// Exports are permission-gated per entity; requireView is applied per route.
const requireView = (key: string) => requirePermission(key);

router.get(
  "/api/export/customers",
  ...read,
  // Q1-2: the full customer book (name/phone/email/address, up to 50k rows)
  // is PII — bulk exfiltration is a ledger-tier capability, not something
  // the cashier default holds, and every export leaves an audit record.
  requireView("customers.view_ledger"),
  async (req: Request, res: Response) => {
    try {
      const file = await exportCustomers(getBusinessId(req), optionalSearch(req));
      void recordAudit({
        businessId: getBusinessId(req),
        actorUserId: req.user?.id ?? null,
        action: "data.exported",
        entityType: "customers",
        entityId: null,
        metadata: { rows: file.body.split("\n").length - 1, format: "csv" },
      });
      sendCsv(res, file);
    } catch (err: unknown) {
      sendSafeError(res, err, "Unable to export customers.");
    }
  },
);

router.get(
  "/api/export/suppliers",
  ...read,
  requireView("suppliers.view_ledger"),
  async (req: Request, res: Response) => {
    try {
      const file = await exportSuppliers(getBusinessId(req), optionalSearch(req));
      void recordAudit({
        businessId: getBusinessId(req),
        actorUserId: req.user?.id ?? null,
        action: "data.exported",
        entityType: "suppliers",
        entityId: null,
        metadata: { rows: file.body.split("\n").length - 1, format: "csv" },
      });
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
      // L1-1: the requested location is validated against the caller's
      // server-side assignments (reports do this; exports skipped it, so a
      // restricted user could read another location's sales via CSV).
      const file = await exportSales(
        getBusinessId(req),
        range,
        await resolveOptionalLocationParam(req),
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
        await resolveOptionalLocationParam(req),
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
