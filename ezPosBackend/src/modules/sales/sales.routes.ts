import express from "express";
import * as salesController from "./sales.controller.js";
import * as salesExchangeController from "./salesExchange.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import {
  requireLocationAccess,
  requireOptionalLocation,
} from "../../middleware/location.js";
import { requireTerminalContext } from "../../middleware/terminalContext.js";
import { requireAnyPermission, requirePermission } from "../../middleware/permissions.js";
import { requireSurfaceModes } from "../../middleware/storefront.js";

const PHYSICAL_SURFACE_MODES = ["physical_only", "omnichannel"] as const;

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
// The dashboard is meaningful without any physical counter (online-only
// businesses): location resolves when one exists, stays absent otherwise,
// and the service already treats the location scope as optional.
const dashboardRead = [
  requireAuth,
  requireBusinessContext(),
  requireOptionalLocation(),
] as const;

router.get(
  "/api/sold_products",
  ...read,
  requirePermission("sales.view"),
  salesController.getSalesData,
);
// Counter checkout belongs to the physical surface: blocked (403
// SURFACE_NOT_ACTIVE) for online-only businesses even via direct API calls.
// Refund/exchange/list routes below stay mode-neutral — online refunds flow
// through the same endpoints.
router.post(
  "/api/sales",
  requireAuth,
  requireBusinessContext(),
  requireSurfaceModes(
    [...PHYSICAL_SURFACE_MODES],
    "Counter sales are not active for an online-only business. Switch the operating model in Settings → Business Operations.",
  ),
  requireLocationAccess(),
  requireTerminalContext(),
  requireFullAccess,
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
  ...dashboardRead,
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
// P3 Phase 2 (F.1): the POS batch picker — the serial endpoint's access
// model applied to batches (pos.create_sale holders may read the AVAILABLE
// batch list for add-to-cart; location-scoped; expiry-policy aware).
router.get(
  "/api/variants/:variantId/batches",
  ...read,
  requireAnyPermission(["pos.create_sale", "inventory.view"]),
  salesController.getAvailableBatches,
);
// P3 Phase 3 (E1-003): sale void — atomic batch-aware reversal. Backend
// permission enforcement (sales.void); UI visibility is not authorization.
router.post(
  "/api/sales/:id/cancel",
  ...write,
  requirePermission("sales.void"),
  salesController.cancelSale,
);
export default router;
