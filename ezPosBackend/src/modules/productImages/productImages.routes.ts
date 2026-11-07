import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessContext } from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import { env } from "../../config/env.js";
import {
  deleteProductImage,
  listProductImages,
  presignProductImage,
  registerProductImage,
} from "./productImages.service.js";

// Product image upload — Phase 5 of the product-module refactor. Reuses the
// expense-attachment presign architecture: browser PUTs bytes directly to
// S3/MinIO; Express only signs URLs and persists the reference.

const router = Router();

router.post(
  "/api/products/:id/images/presign",
  requireAuth,
  requireBusinessContext(),
  requirePermission("products.edit"),
  async (req: Request, res: Response) => {
    try {
      const data = await presignProductImage({
        businessId: getBusinessId(req),
        productId: Number(req.params.id),
        contentType: String(req.body?.contentType ?? ""),
        sizeBytes: Number(req.body?.sizeBytes ?? 0),
        maxMb: env.mediaMaxUploadMb,
      });
      res.status(200).json({ success: true, data });
    } catch (err) {
      sendSafeError(res, err, "Unable to sign the image upload.");
    }
  },
);

router.post(
  "/api/products/:id/images",
  requireAuth,
  requireBusinessContext(),
  requirePermission("products.edit"),
  async (req: Request, res: Response) => {
    try {
      const row = await registerProductImage({
        businessId: getBusinessId(req),
        productId: Number(req.params.id),
        actorUserId: req.user!.id,
        objectKey: String(req.body?.objectKey ?? ""),
        contentType: String(req.body?.contentType ?? ""),
      });
      res.status(201).json({ success: true, data: row });
    } catch (err) {
      sendSafeError(res, err, "Unable to attach the image.");
    }
  },
);

router.get(
  "/api/products/:id/images",
  requireAuth,
  requireBusinessContext(),
  requirePermission("products.view"),
  async (req: Request, res: Response) => {
    try {
      const rows = await listProductImages(
        getBusinessId(req),
        Number(req.params.id),
      );
      res.status(200).json({ success: true, data: rows });
    } catch (err) {
      sendSafeError(res, err, "Unable to load product images.");
    }
  },
);

router.delete(
  "/api/products/:id/images/:imageId",
  requireAuth,
  requireBusinessContext(),
  requirePermission("products.edit"),
  async (req: Request, res: Response) => {
    try {
      const data = await deleteProductImage({
        businessId: getBusinessId(req),
        productId: Number(req.params.id),
        imageId: Number(req.params.imageId),
        actorUserId: req.user!.id,
      });
      res.status(200).json({ success: true, data });
    } catch (err) {
      sendSafeError(res, err, "Unable to remove the image.");
    }
  },
);

export default router;
