import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import {
  listNotifications,
  markAllRead,
  markRead,
} from "./notifications.service.js";

export async function getNotifications(req: Request, res: Response) {
  try {
    res
      .status(200)
      .json({ success: true, data: await listNotifications(getBusinessId(req)) });
  } catch (err) {
    sendSafeError(res, err, "Unable to load notifications right now.");
  }
}

export async function readAll(req: Request, res: Response) {
  try {
    await markAllRead(getBusinessId(req));
    res.status(200).json({ success: true });
  } catch (err) {
    sendSafeError(res, err, "Unable to mark notifications read right now.");
  }
}

export async function readOne(req: Request, res: Response) {
  const notificationId = Number(req.params.notificationId);
  if (!Number.isInteger(notificationId) || notificationId <= 0) {
    return res
      .status(400)
      .json({ success: false, message: "A valid notification ID is required." });
  }
  try {
    await markRead(getBusinessId(req), notificationId);
    res.status(200).json({ success: true });
  } catch (err) {
    sendSafeError(res, err, "Unable to mark the notification read right now.");
  }
}
