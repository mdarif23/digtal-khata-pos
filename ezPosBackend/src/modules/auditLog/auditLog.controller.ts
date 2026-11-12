import type { Request, Response } from "express";
import { z } from "zod";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import { safeCsvCell } from "../../utils/csv.js";
import {
  exportAuditLog,
  listAuditLog,
  type AuditLogFilters,
} from "./auditLog.service.js";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const filterSchema = z.object({
  action: z.string().trim().max(80).optional(),
  actionPrefix: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(40).optional(),
  entityId: z.coerce.number().int().positive().optional(),
  actorUserId: z.coerce.number().int().positive().optional(),
  locationId: z.coerce.number().int().positive().optional(),
  from: z.string().regex(isoDate).optional(),
  to: z.string().regex(isoDate).optional(),
});

function filtersFromQuery(req: Request): AuditLogFilters {
  const parsed = filterSchema.safeParse(req.query);
  if (!parsed.success) {
    const flat = parsed.error.flatten().fieldErrors;
    const first = Object.values(flat)[0]?.[0];
    throw new Error(first ?? "Invalid audit filters.");
  }
  const v = parsed.data;
  return {
    action: v.action,
    actionPrefix: v.actionPrefix,
    entityType: v.entityType,
    entityId: v.entityId,
    actorUserId: v.actorUserId,
    locationId: v.locationId,
    from: v.from,
    to: v.to,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    offset: req.query.offset ? Number(req.query.offset) : undefined,
  };
}

export async function getAuditLog(req: Request, res: Response) {
  try {
    const data = await listAuditLog(getBusinessId(req), filtersFromQuery(req));
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load the audit log.");
  }
}

export async function getAuditLogExport(req: Request, res: Response) {
  try {
    const rows = await exportAuditLog(getBusinessId(req), filtersFromQuery(req));
    const header = [
      "id",
      "timestamp",
      "action",
      "entity_type",
      "entity_id",
      "actor_user_id",
      "actor_name",
      "actor_role",
      "location_id",
      "location_name",
      "request_id",
      "details",
      "before",
      "after",
    ];
    const lines = [
      header.map((h) => safeCsvCell(h)).join(","),
      ...rows.map((r) =>
        [
          r.id,
          r.createdAt?.toISOString() ?? "",
          r.action,
          r.entityType,
          r.entityId ?? "",
          r.actorUserId ?? "",
          r.actorName ?? "",
          r.actorRole ?? "",
          r.locationId ?? "",
          r.locationName ?? "",
          r.requestId ?? "",
          JSON.stringify(r.metadata ?? {}),
          r.beforeState ? JSON.stringify(r.beforeState) : "",
          r.afterState ? JSON.stringify(r.afterState) : "",
        ]
          .map((cell) => safeCsvCell(cell))
          .join(","),
      ),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(`\uFEFF${lines.join("\r\n")}`);
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to export the audit log.");
  }
}
