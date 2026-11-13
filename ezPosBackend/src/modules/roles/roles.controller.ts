import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import {
  createRole,
  deleteRole,
  listPermissionCatalog,
  listRoleUsers,
  listRoles,
  updateRole,
} from "./roles.service.js";
import {
  createRoleSchema,
  updateRoleSchema,
} from "./roles.validation.js";

export async function getRoles(req: Request, res: Response) {
  try {
    const data = await listRoles(getBusinessId(req));
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load roles.");
  }
}

export async function getPermissionCatalog(_req: Request, res: Response) {
  try {
    const data = await listPermissionCatalog();
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load the permission catalog.");
  }
}

export async function postRole(req: Request, res: Response) {
  try {
    const result = createRoleSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid role data.",
        errors: result.error.flatten(),
      });
    }
    const data = await createRole(
      getBusinessId(req),
      result.data,
      req.user?.id ?? null,
    );
    return res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the role.");
  }
}

export async function patchRole(req: Request, res: Response) {
  try {
    const roleId = Number(req.params.roleId);
    if (!Number.isInteger(roleId) || roleId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid role ID." });
    }
    const result = updateRoleSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid role data.",
        errors: result.error.flatten(),
      });
    }
    if (!req.user || !req.membership) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    const data = await updateRole(
      getBusinessId(req),
      req.user.id,
      req.membership.permissions,
      roleId,
      result.data,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the role.");
  }
}

export async function removeRole(req: Request, res: Response) {
  try {
    const roleId = Number(req.params.roleId);
    if (!Number.isInteger(roleId) || roleId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid role ID." });
    }
    if (!req.user || !req.membership) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    await deleteRole(
      getBusinessId(req),
      req.user.id,
      req.membership.permissions,
      roleId,
    );
    return res.status(200).json({ success: true });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to delete the role.");
  }
}

export async function getRoleUsers(req: Request, res: Response) {
  try {
    const roleId = Number(req.params.roleId);
    if (!Number.isInteger(roleId) || roleId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid role ID." });
    }
    const data = await listRoleUsers(getBusinessId(req), roleId);
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the role's users.");
  }
}
