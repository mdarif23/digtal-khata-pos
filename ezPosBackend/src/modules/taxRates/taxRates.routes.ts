import express from "express";
import * as taxRatesController from "./taxRates.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();

const read = [requireAuth, requireBusinessContext()] as const;
const write = [...read, requireFullAccess] as const;

router.get(
  "/api/tax-rates",
  ...read,
  requirePermission("taxes.view"),
  taxRatesController.listTaxRates,
);
router.post(
  "/api/tax-rates",
  ...write,
  requirePermission("taxes.manage"),
  taxRatesController.createTaxRate,
);
router.patch(
  "/api/tax-rates/:id",
  ...write,
  requirePermission("taxes.manage"),
  taxRatesController.updateTaxRate,
);
router.delete(
  "/api/tax-rates/:id",
  ...write,
  requirePermission("taxes.manage"),
  taxRatesController.deactivateTaxRate,
);
router.get(
  "/api/products/:productId/tax-rates",
  ...read,
  requirePermission("taxes.view"),
  taxRatesController.getProductTaxRates,
);
router.put(
  "/api/products/:productId/tax-rates",
  ...write,
  requirePermission("taxes.manage"),
  taxRatesController.setProductTaxRates,
);

export default router;
