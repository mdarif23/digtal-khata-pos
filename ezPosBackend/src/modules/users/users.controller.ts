import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import {
  createStaffUser,
  listMembers,
  resetMemberPassword,
  updateMember,
} from "./users.service.js";
import {
  createStaffUserSchema,
  resetStaffPasswordSchema,
  updateStaffUserSchema,
} from "./users.validation.js";

export async function getUsers(req: Request, res: Response) {
  try {
    const data = await listMembers(getBusinessId(req));
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load users.");
  }
}

export async function postUser(req: Request, res: Response) {
  try {
    const result = createStaffUserSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid user data.",
        errors: result.error.flatten(),
      });
    }
    const data = await createStaffUser(
      getBusinessId(req),
      result.data,
      req.user?.id ?? null,
    );
    return res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the user.");
  }
}

export async function patchUser(req: Request, res: Response) {
  try {
    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid user ID." });
    }
    const result = updateStaffUserSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid user data.",
        errors: result.error.flatten(),
      });
    }
    if (!req.user || !req.membership) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    const data = await updateMember(
      getBusinessId(req),
      req.user.id,
      req.membership.permissions,
      targetUserId,
      result.data,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the user.");
  }
}

export async function postUserPasswordReset(req: Request, res: Response) {
  try {
    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid user ID." });
    }
    const result = resetStaffPasswordSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid password.",
        errors: result.error.flatten(),
      });
    }
    if (!req.user || !req.membership) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    await resetMemberPassword(
      getBusinessId(req),
      req.user.id,
      req.membership.permissions,
      targetUserId,
      result.data.password,
    );
    return res
      .status(200)
      .json({ success: true, message: "Password updated." });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to reset the password.");
  }
}
