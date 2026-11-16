import express from "express";
import * as controller from "./quotations.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";
import { requireSurfaceModes } from "../../middleware/storefront.js";

const router = express.Router();

const read = [requireAuth, requireBusinessContext()] as const;
const write = [
  ...read,
  requireLocationAccess(),
  requireFullAccess,
] as const;
// WB-04: conversion creates a counter (pos-channel) sale through the sale
// engine — the POST /api/sales surface gate is not on this path, so gate the
// route itself. Refunds/exchanges stay deliberately mode-neutral; this is
// new-sale creation.
const convert = [
  ...write,
  requireSurfaceModes(
    ["physical_only", "omnichannel"],
    "Converting a quotation creates a counter sale, which is not active for an online-only business. Switch the operating model in Settings → Business Operations.",
  ),
] as const;

router.get(
  "/api/quotations",
  ...read,
  requirePermission("quotations.view"),
  controller.getQuotations,
);
router.get(
  "/api/quotations/:quotationId",
  ...read,
  requirePermission("quotations.view"),
  controller.getQuotation,
);
router.post(
  "/api/quotations",
  ...write,
  requirePermission("quotations.create"),
  controller.postQuotation,
);
router.patch(
  "/api/quotations/:quotationId",
  ...write,
  requirePermission("quotations.create"),
  controller.patchQuotation,
);
router.post(
  "/api/quotations/:quotationId/status",
  ...write,
  requirePermission("quotations.create"),
  controller.postTransition,
);
// Conversion creates a sale — the dedicated convert permission (and the
// counter-sale surface gate, WB-04).
router.post(
  "/api/quotations/:quotationId/convert",
  ...convert,
  requirePermission("quotations.convert"),
  controller.postConvert,
);

export default router;
