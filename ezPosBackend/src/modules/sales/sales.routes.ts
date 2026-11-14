import express from "express";
import * as salesController from "./sales.controller.js";
import * as salesExchangeController from "./salesExchange.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requireTerminalContext } from "../../middleware/terminalContext.js";
import { requireAnyPermission, requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
// Location-aware: the X-Location-Id header (or the business default) is
// validated against membership + assignment before any handler runs.
const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
// Writes additionally resolve the optional X-Terminal-Id header (terminal
// attribution + revocation enforcement; strict mode via pos_settings).
const write = [...read, requireTerminalContext(), requireFullAccess] as const;

router.get(
  "/api/sold_products",
  ...read,
  requirePermission("sales.view"),
  salesController.getSalesData,
);
router.post(
  "/api/sales",
  ...write,
  requirePermission("pos.create_sale"),
  salesController.createSale,
);
// Server-authoritative cart totals (incl. rules-based taxes) so the
// checkout display always matches what createSale will charge.
router.post(
  "/api/sales/quote",
  ...read,
  requirePermission("pos.view"),
  salesExchangeController.quote,
);
router.get(
  "/api/sales/:id/receipt",
  ...read,
  requirePermission("sales.view"),
  salesController.getSaleReceipt,
);
// Refund endpoints are POST (state-changing) — full access required.
router.post(
  "/api/sold_products/refund/:id",
  ...write,
  requirePermission("sales.return"),
  salesController.createSingleRefund,
);
router.post(
  "/api/sold_products/refunds_all/:id",
  ...write,
  requirePermission("sales.return"),
  salesController.createMultipleRefunds,
);
// Exchange: refund of returned items + linked replacement sale + difference
// settlement, atomically. Serial-tracked replacements are rejected (v1).
router.post(
  "/api/sales/:id/exchange",
  ...write,
  requirePermission("sales.return"),
  salesExchangeController.createExchange,
);
router.get(
  "/api/dashboard_summary",
  ...read,
  requirePermission("dashboard.view"),
  salesController.getDashboardSummary,
);
router.get(
  "/api/variants/:variantId/serials",
  ...read,
  // A1-021: the POS serial picker routes serial products here at add-to-cart
  // time — gating it on inventory.view alone meant cashiers could not sell
  // serial-tracked items AT ALL. pos.create_sale holders may read the
  // AVAILABLE serial list (read-only, business-scoped); inventory.view
  // keeps working for stock screens.
  requireAnyPermission(["pos.create_sale", "inventory.view"]),
  salesController.getAvailableSerials,
);
router.patch(
  "/api/variants/:variantId/serials",
  ...write,
  requirePermission("sales.edit"),
  salesController.updateAvailableSerial,
);
export default router;
