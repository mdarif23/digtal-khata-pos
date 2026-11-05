import { Router, raw, type Request, type Response } from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getBusinessId,
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { resolveRequestLocation } from "../../middleware/location.js";
import { requirePermission, callerHasPermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { env } from "../../config/env.js";
import { generateTemplate, assertUploadAcceptable, FileParseError } from "./fileParser.service.js";
import {
  createImportSession,
  updateImportMapping,
  validateImportSession,
  executeImportSession,
  listImportHistory,
  getSessionDetail,
  buildErrorReport,
} from "./importSession.service.js";
import { buildProductExport } from "./export.service.js";

// Product import/export (audit-approved routes). Permissions reuse the
// existing product catalog keys — import-execute needs products.create
// (create mode) or products.edit (update/upsert modes); export needs
// products.view with products.view_cost gating the cost column.

const router = Router();

function sendError(res: Response, err: unknown, fallback: string) {
  if (err instanceof FileParseError) {
    res.status(400).json({ success: false, message: err.message, code: err.code });
    return;
  }
  if (
    err instanceof BadRequestError ||
    err instanceof NotFoundError ||
    err instanceof ConflictError
  ) {
    const status =
      err instanceof NotFoundError ? 404 : err instanceof ConflictError ? 409 : 400;
    res.status(status).json({ success: false, message: err.message });
    return;
  }
  sendSafeError(res, err, fallback);
}

router.get(
  "/api/products/import/template",
  requireAuth,
  requireBusinessContext(),
  requirePermission("products.view"),
  async (req: Request, res: Response) => {
    try {
      const format = req.query.format === "xlsx" ? "xlsx" : "csv";
      const template = await generateTemplate(format);
      res
        .status(200)
        .set("Content-Type", template.contentType)
        .set(
          "Content-Disposition",
          `attachment; filename="${template.filename}"`,
        )
        .send(template.bytes);
    } catch (err) {
      sendError(res, err, "Unable to generate the import template.");
    }
  },
);

// Raw body for this route only: the import file arrives as bytes
// (presign requires external object storage; this keeps the flow
// self-contained and equally capped). Filename travels as a query param.
router.post(
  "/api/products/import/upload",
  // Raw bytes for this route only (json/global parses would corrupt the
  // file; the 15 MB cap matches MEDIA_MAX_UPLOAD_MB).
  raw({ type: () => true, limit: `${env.mediaMaxUploadMb + 1}mb` }),
  requireAuth,
  requireBusinessContext(),
  requirePermission("products.create"),
  requireFullAccess,
  async (req: Request, res: Response) => {
    try {
      const filename = String(req.query.filename ?? "import.csv");
      const worksheet = req.query.worksheet ? String(req.query.worksheet) : null;
      const headerRow = req.query.headerRow ? Number(req.query.headerRow) : 1;
      const bytes = req.body as Buffer;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new BadRequestError("Upload body is empty.");
      }
      assertUploadAcceptable({
        filename,
        mimeType: req.headers["content-type"] ?? null,
        bytes,
        maxMb: env.mediaMaxUploadMb,
      });
      const result = await createImportSession({
        businessId: getBusinessId(req),
        userId: req.user!.id,
        filename,
        mimeType: req.headers["content-type"] ?? null,
        bytes,
        worksheet,
        headerRow,
        maxFileMb: env.mediaMaxUploadMb,
      });
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      sendError(res, err, "Unable to process the import file.");
    }
  },
);

router.get(
  "/api/products/import-history",
  requireAuth,
  requireBusinessContext(),
  requirePermission("products.view"),
  async (req: Request, res: Response) => {
    try {
      const rows = await listImportHistory(getBusinessId(req));
      res.status(200).json({ success: true, data: rows });
    } catch (err) {
      sendError(res, err, "Unable to load import history.");
    }
  },
);

router.get(
  "/api/products/import/:id",
  requireAuth,
  requireBusinessContext(),
  requirePermission("products.view"),
  async (req: Request, res: Response) => {
    try {
      const data = await getSessionDetail(getBusinessId(req), Number(req.params.id));
      res.status(200).json({ success: true, data });
    } catch (err) {
      sendError(res, err, "Import session not found.");
    }
  },
);

router.patch(
  "/api/products/import/:id",
  requireAuth,
  requireBusinessContext(),
  requirePermission("products.create"),
  requireFullAccess,
  async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        mapping?: Record<string, string>;
        mode?: "create" | "update" | "upsert" | "skip";
        matchBy?: "variant_sku" | "product_sku" | "barcode";
        options?: { updateFields?: string[]; createMissingMasterData?: boolean } | null;
      };
      if (!body.mapping) throw new BadRequestError("Column mapping is required.");
      const data = await updateImportMapping({
        businessId: getBusinessId(req),
        userId: req.user!.id,
        sessionId: Number(req.params.id),
        mapping: body.mapping,
        ...(body.mode ? { mode: body.mode } : {}),
        ...(body.matchBy ? { matchBy: body.matchBy } : {}),
        options: body.options ?? null,
      });
      res.status(200).json({ success: true, data });
    } catch (err) {
      sendError(res, err, "Unable to save the mapping.");
    }
  },
);

router.post(
  "/api/products/import/:id/validate",
  requireAuth,
  requireBusinessContext(),
  requirePermission("products.create"),
  requireFullAccess,
  async (req: Request, res: Response) => {
    try {
      const data = await validateImportSession({
        businessId: getBusinessId(req),
        userId: req.user!.id,
        sessionId: Number(req.params.id),
      });
      res.status(200).json({ success: true, data });
    } catch (err) {
      sendError(res, err, "Unable to validate the import.");
    }
  },
);

router.post(
  "/api/products/import/:id/execute",
  requireAuth,
  requireBusinessContext(),
  requireFullAccess,
  async (req: Request, res: Response) => {
    try {
      const businessId = getBusinessId(req);
      const sessionId = Number(req.params.id);
      // Update/upsert modes modify existing products → products.edit.
      const detail = await getSessionDetail(businessId, sessionId);
      if (detail.session.mode !== "create") {
        if (!callerHasPermission(req, "products.edit")) {
          res.status(403).json({
            success: false,
            message: "Update modes require the products.edit permission.",
          });
          return;
        }
      }
      const data = await executeImportSession({
        businessId,
        userId: req.user!.id,
        sessionId,
        defaultLocationId: (await resolveRequestLocation(req)).locationId,
      });
      res.status(200).json({ success: true, data });
    } catch (err) {
      sendError(res, err, "Unable to execute the import.");
    }
  },
);

router.get(
  "/api/products/import/:id/errors",
  requireAuth,
  requireBusinessContext(),
  requirePermission("products.view"),
  async (req: Request, res: Response) => {
    try {
      const report = await buildErrorReport(getBusinessId(req), Number(req.params.id));
      if (!report) {
        res.status(404).json({ success: false, message: "No errors to report." });
        return;
      }
      res
        .status(200)
        .set("Content-Type", "text/csv; charset=utf-8")
        .set("Content-Disposition", `attachment; filename="${report.filename}"`)
        .send(report.csv);
    } catch (err) {
      sendError(res, err, "Unable to build the error report.");
    }
  },
);

router.get(
  "/api/products/export",
  requireAuth,
  requireBusinessContext(),
  requirePermission("products.view"),
  async (req: Request, res: Response) => {
    try {
      const format = req.query.format === "xlsx" ? "xlsx" : "csv";
      const includeCost = callerHasPermission(req, "products.view_cost");
      const data = await buildProductExport(getBusinessId(req), {
        format,
        includeCost,
        categoryId: req.query.categoryId ? Number(req.query.categoryId) : null,
        brandId: req.query.brandId ? Number(req.query.brandId) : null,
        status: req.query.status ? String(req.query.status) : null,
        productIds: req.query.productIds
          ? String(req.query.productIds)
              .split(",")
              .map((id) => Number(id))
              .filter((id) => Number.isInteger(id) && id > 0)
          : null,
        locationId: req.query.locationId ? Number(req.query.locationId) : null,
      });
      res
        .status(200)
        .set("Content-Type", data.contentType)
        .set("Content-Disposition", `attachment; filename="${data.filename}"`)
        .send(data.bytes);
    } catch (err) {
      sendError(res, err, "Unable to export products.");
    }
  },
);

export default router;
