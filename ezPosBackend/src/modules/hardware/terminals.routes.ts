import express from "express";
import * as terminalsController from "./terminals.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import {
  requireAnyPermission,
  requirePermission,
} from "../../middleware/permissions.js";
import { requireSurfaceModes } from "../../middleware/storefront.js";
import { drawerCommandRateLimit } from "../../middleware/rateLimit.js";

const router = express.Router();

// POS terminals pair with cash drawers: physical surface only.
const surface = requireSurfaceModes(
  ["physical_only", "omnichannel"],
  "POS terminals are not active for an online-only business. Switch the operating model in Settings → Business Operations.",
);

// Terminal administration is location-scoped like register management.
const locationRead = [
  requireAuth,
  requireBusinessContext(),
  surface,
  requireLocationAccess(),
] as const;
const manage = [
  ...locationRead,
  requireFullAccess,
  requirePermission("pos_terminal.manage"),
] as const;
// Drawer operators (cash_drawer.open) may list terminals so the POS can
// target the right drawer; registry detail and command history stay
// pos_terminal.view.
const operatorView = [
  ...locationRead,
  requireAnyPermission([
    "pos_terminal.view",
    "cash_drawer.open",
    "cash_drawer.open_without_sale",
  ]),
] as const;
const view = [...locationRead, requirePermission("pos_terminal.view")] as const;

router.get("/api/terminals", ...operatorView, terminalsController.getTerminals);
router.get(
  "/api/terminals/:terminalId",
  ...view,
  terminalsController.getTerminalDetail,
);
router.patch(
  "/api/terminals/:terminalId",
  ...manage,
  terminalsController.patchTerminal,
);
router.delete(
  "/api/terminals/:terminalId",
  ...manage,
  terminalsController.deleteTerminalHandler,
);
router.post(
  "/api/terminals/pairing-code",
  ...manage,
  terminalsController.postPairingCode,
);
router.post(
  "/api/terminals/:terminalId/rotate-secret",
  ...manage,
  terminalsController.postRotateSecret,
);
router.get(
  "/api/terminals/:terminalId/commands",
  ...view,
  terminalsController.getTerminalCommands,
);

// Drawer commands: creating needs a drawer permission (chosen per payload
// inside the controller — sale-linked vs without-sale). Polling status is
// allowed for the drawer operators themselves, not only terminal viewers.
const commandRead = [
  ...locationRead,
  requireAnyPermission([
    "pos_terminal.view",
    "cash_drawer.open",
    "cash_drawer.open_without_sale",
  ]),
] as const;
router.post(
  "/api/hardware/commands",
  drawerCommandRateLimit,
  ...locationRead,
  requireFullAccess,
  terminalsController.postHardwareCommand,
);
router.get(
  "/api/hardware/commands/:commandId",
  ...commandRead,
  terminalsController.getHardwareCommandStatus,
);

export default router;
