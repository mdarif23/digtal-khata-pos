import express from "express";
import * as controller from "./storefront.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessAccess,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";

/**
 * Hosted storefront platform — portal management routes (website platform
 * stage 1). All routes are business-member authenticated via
 * requireBusinessAccess; reads need `storefront.view`, writes need
 * `storefront.manage` plus an active subscription (requireFullAccess).
 *
 * Public shopper-facing reads go through /api/internal/* (renderer token),
 * NOT through these routes.
 */
const router = express.Router();

const read = [
  requireAuth,
  requireBusinessAccess(),
  requirePermission("storefront.view"),
] as const;

const write = [
  requireAuth,
  requireBusinessAccess(),
  requireFullAccess,
  requirePermission("storefront.manage"),
] as const;

const sf = "/api/businesses/:businessId/storefronts";

// Storefronts (register literal segments before :storefrontId).
router.post(`${sf}`, ...write, controller.createStorefront);
router.get(`${sf}`, ...read, controller.listStorefronts);
router.get(`${sf}/subdomain-available`, ...read, controller.getSubdomainAvailability);
router.get(`${sf}/media`, ...read, controller.listMedia);
router.post(`${sf}/media/presign`, ...write, controller.presignMedia);
router.post(`${sf}/media/register`, ...write, controller.registerMedia);
router.delete(`${sf}/media/:mediaId`, ...write, controller.deleteMedia);
router.get(`${sf}/:storefrontId`, ...read, controller.getStorefront);
router.patch(`${sf}/:storefrontId`, ...write, controller.updateStorefront);
router.patch(`${sf}/:storefrontId/draft-config`, ...write, controller.updateDraftConfig);
router.delete(`${sf}/:storefrontId`, ...write, controller.archiveStorefront);
router.post(`${sf}/:storefrontId/publish`, ...write, controller.publishStorefront);
router.post(`${sf}/:storefrontId/unpublish`, ...write, controller.unpublishStorefront);
router.get(`${sf}/:storefrontId/versions`, ...read, controller.listStorefrontVersions);
router.post(
  `${sf}/:storefrontId/versions/:versionId/restore`,
  ...write,
  controller.restoreStorefrontVersion,
);
router.post(`${sf}/:storefrontId/subdomain`, ...write, controller.changeSubdomain);
router.post(`${sf}/:storefrontId/preview-token`, ...write, controller.createPreviewToken);

// Domains
router.get(`${sf}/:storefrontId/domains`, ...read, controller.listDomains);
router.post(`${sf}/:storefrontId/domains`, ...write, controller.addDomain);
router.post(
  `${sf}/:storefrontId/domains/:domainId/verify`,
  ...write,
  controller.verifyDomain,
);
router.post(
  `${sf}/:storefrontId/domains/:domainId/make-primary`,
  ...write,
  controller.makePrimaryDomain,
);
router.delete(
  `${sf}/:storefrontId/domains/:domainId`,
  ...write,
  controller.removeDomain,
);

// Content pages
router.get(`${sf}/:storefrontId/pages`, ...read, controller.listPages);
router.post(`${sf}/:storefrontId/pages`, ...write, controller.createPage);
router.patch(`${sf}/:storefrontId/pages/:pageId`, ...write, controller.updatePage);
router.delete(`${sf}/:storefrontId/pages/:pageId`, ...write, controller.deletePage);

// Product visibility
router.get(`${sf}/:storefrontId/products`, ...read, controller.listVisibility);
router.put(
  `${sf}/:storefrontId/products/:productId`,
  ...write,
  controller.upsertVisibility,
);
router.delete(
  `${sf}/:storefrontId/products/:productId`,
  ...write,
  controller.deleteVisibility,
);

// Delivery zones
router.get(`${sf}/:storefrontId/delivery-zones`, ...read, controller.listZones);
router.post(`${sf}/:storefrontId/delivery-zones`, ...write, controller.createZone);
router.patch(
  `${sf}/:storefrontId/delivery-zones/:zoneId`,
  ...write,
  controller.updateZone,
);
router.delete(
  `${sf}/:storefrontId/delivery-zones/:zoneId`,
  ...write,
  controller.deleteZone,
);

// Payment methods (configuration; capture lands in the payments stage)
router.get(`${sf}/:storefrontId/payment-methods`, ...read, controller.getPaymentMethods);
router.put(`${sf}/:storefrontId/payment-methods`, ...write, controller.updatePaymentMethods);

export default router;
