import type { Request, Response } from "express";
import { z } from "zod";
import * as notificationsService from "../../services/notifications.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

const readSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) });
const prefSchema = z.object({
  kind: z.string().trim().min(1).max(40),
  muted: z.boolean(),
});

export async function list(req: Request, res: Response) {
  try {
    const rows = await notificationsService.listNotifications(
      getBusinessId(req),
      req.user!.id,
    );
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to list notifications.");
  }
}

export async function unread(req: Request, res: Response) {
  try {
    const count = await notificationsService.unreadCount(
      getBusinessId(req),
      req.user!.id,
    );
    return res.status(200).json({ success: true, data: { count } });
  } catch (err) {
    return sendSafeError(res, err, "Unable to count notifications.");
  }
}

export async function markRead(req: Request, res: Response) {
  try {
    const parsed = readSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, message: "Provide notification ids." });
    }
    await notificationsService.assertNotificationsInBusiness(
      getBusinessId(req),
      parsed.data.ids,
    );
    await notificationsService.markRead(
      getBusinessId(req),
      req.user!.id,
      parsed.data.ids,
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    return sendSafeError(res, err, "Unable to mark notifications read.");
  }
}

export async function markAllRead(req: Request, res: Response) {
  try {
    await notificationsService.markAllRead(getBusinessId(req), req.user!.id);
    return res.status(200).json({ success: true });
  } catch (err) {
    return sendSafeError(res, err, "Unable to mark notifications read.");
  }
}

export async function getPrefs(req: Request, res: Response) {
  try {
    const prefs = await notificationsService.getPrefs(
      getBusinessId(req),
      req.user!.id,
    );
    return res.status(200).json({ success: true, data: prefs });
  } catch (err) {
    return sendSafeError(res, err, "Unable to read preferences.");
  }
}

export async function setPref(req: Request, res: Response) {
  try {
    const parsed = prefSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid preference." });
    }
    await notificationsService.setPref(
      req.user!.id,
      parsed.data.kind,
      parsed.data.muted,
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    return sendSafeError(res, err, "Unable to save the preference.");
  }
}
