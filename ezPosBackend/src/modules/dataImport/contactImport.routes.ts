import express from "express";
import type { Request, Response } from "express";
import { raw } from "body-parser";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessContext, requireFullAccess, getBusinessId } from "../../middleware/business.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import { env } from "../../config/env.js";
import {
  BadRequestError,
} from "../../utils/handleError.js";
import {
  buildContactErrorReport,
  createContactImportSession,
  executeContactImport,
  generateContactTemplate,
  getContactSessionDetail,
  listContactImportHistory,
  type ContactEntity,
} from "./contactImport.service.js";

const router = express.Router();

function entityOf(value: string): ContactEntity {
  if (value === "customers" || value === "suppliers") return value;
  throw new BadRequestError("Unknown import entity.");
}

function readPerms(entity: ContactEntity): { view: string; edit: string } {
  return entity === "customers"
    ? { view: "customers.view", edit: "customers.edit" }
    : { view: "suppliers.view", edit: "suppliers.edit" };
}

// Template downloads — same convention as the product import template.
router.get(
  "/api/import/:entity/template",
  requireAuth,
  requireBusinessContext(),
  async (req: Request, res: Response) => {
    try {
      const entity = entityOf(String(req.params.entity));
      const perms = readPerms(entity);
      // Route-level guard: the :entity parameter decides which permission
      // applies, so requirePermission is called inline per request.
      if (!callerHasPermission(req, perms.view)) {
        return res
          .status(403)
          .json({ success: false, message: `Missing ${perms.view}.` });
      }
      const format = req.query.format === "xlsx" ? "xlsx" : "csv";
      const template = await generateContactTemplate(entity, format);
      return res
        .status(200)
        .set("Content-Type", template.contentType)
        .set("Content-Disposition", `attachment; filename="${template.filename}"`)
        .send(template.bytes);
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to generate the import template.");
    }
  },
);

// Raw bytes upload (same pattern as the product import upload).
router.post(
  "/api/import/:entity/upload",
  raw({ type: () => true, limit: `${env.mediaMaxUploadMb + 1}mb` }),
  requireAuth,
  requireBusinessContext(),
  requireFullAccess,
  async (req: Request, res: Response) => {
    try {
      const entity = entityOf(String(req.params.entity));
      const perms = readPerms(entity);
      if (!callerHasPermission(req, perms.edit)) {
        return res
          .status(403)
          .json({ success: false, message: `Missing ${perms.edit}.` });
      }
      const filename = String(req.query.filename ?? "import.csv");
      const bytes = req.body as Buffer;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new BadRequestError("Upload body is empty.");
      }
      const result = await createContactImportSession({
        businessId: getBusinessId(req),
        userId: req.user!.id,
        entity,
        filename,
        mimeType: req.headers["content-type"] ?? null,
        bytes,
        maxFileMb: env.mediaMaxUploadMb,
      });
      return res.status(201).json({ success: true, data: result });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to process the import file.");
    }
  },
);

router.get(
  "/api/import/sessions/:sessionId",
  requireAuth,
  requireBusinessContext(),
  async (req: Request, res: Response) => {
    try {
      const sessionId = Number(req.params.sessionId);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        throw new BadRequestError("Invalid session ID.");
      }
      const data = await getContactSessionDetail(getBusinessId(req), sessionId);
      return res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to load the import session.");
    }
  },
);

router.get(
  "/api/import/sessions/:sessionId/errors",
  requireAuth,
  requireBusinessContext(),
  async (req: Request, res: Response) => {
    try {
      const sessionId = Number(req.params.sessionId);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        throw new BadRequestError("Invalid session ID.");
      }
      const report = await buildContactErrorReport(getBusinessId(req), sessionId);
      return res
        .status(200)
        .set("Content-Type", report.contentType)
        .set("Content-Disposition", `attachment; filename="${report.filename}"`)
        .send(report.bytes);
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to build the error report.");
    }
  },
);

/**
 * Executes the import IN THE BACKGROUND: the session row flips to 'running'
 * immediately and the response returns so the wizard can poll
 * GET /api/import/sessions/:id for progress. POST /resume re-drives a
 * session left 'running' by a crash — execution is idempotent per row.
 */
router.post(
  "/api/import/sessions/:sessionId/execute",
  requireAuth,
  requireBusinessContext(),
  requireFullAccess,
  async (req: Request, res: Response) => {
    try {
      const sessionId = Number(req.params.sessionId);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        throw new BadRequestError("Invalid session ID.");
      }
      const businessId = getBusinessId(req);
      const userId = req.user!.id;
      // Fire-and-forget: failures land on the session row (status failed /
      // row-level results), never lost to an HTTP timeout.
      void executeContactImport({ businessId, userId, sessionId }).catch(() => {});
      return res
        .status(202)
        .json({ success: true, data: { sessionId, status: "running" } });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to start the import.");
    }
  },
);

router.post(
  "/api/import/sessions/:sessionId/resume",
  requireAuth,
  requireBusinessContext(),
  requireFullAccess,
  async (req: Request, res: Response) => {
    try {
      const sessionId = Number(req.params.sessionId);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        throw new BadRequestError("Invalid session ID.");
      }
      const businessId = getBusinessId(req);
      const userId = req.user!.id;
      void executeContactImport({ businessId, userId, sessionId }).catch(() => {});
      return res
        .status(202)
        .json({ success: true, data: { sessionId, status: "running" } });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to resume the import.");
    }
  },
);

router.get(
  "/api/import/:entity/history",
  requireAuth,
  requireBusinessContext(),
  async (req: Request, res: Response) => {
    try {
      const entity = entityOf(String(req.params.entity));
      const perms = readPerms(entity);
      if (!callerHasPermission(req, perms.view)) {
        return res
          .status(403)
          .json({ success: false, message: `Missing ${perms.view}.` });
      }
      const data = await listContactImportHistory(getBusinessId(req), [entity]);
      return res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to load import history.");
    }
  },
);

export default router;
