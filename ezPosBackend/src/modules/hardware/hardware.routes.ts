import express from "express";
import * as hardwareController from "./hardware.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();

router.post(
  "/api/hardware/drawer-kick",
  requireAuth,
  requireBusinessContext(),
  requireFullAccess,
  requirePermission("pos.create_sale"),
  hardwareController.drawerKick,
);

export default router;
