import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import * as groupsService from "./customerGroups.service.js";
import {
  assignMembersSchema,
  createGroupSchema,
  groupPricingCreateSchema,
  groupPricingUpdateSchema,
  updateGroupSchema,
} from "./customerGroups.validation.js";

/**
 * Customer groups + group pricing controller (Phase 4). Writes require
 * pricing.customer_groups.manage; reads require pricing.view.
 */

function parseId(raw: string | string[] | undefined): number | null {
  if (Array.isArray(raw)) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function listGroups(req: Request, res: Response) {
  try {
    const rows = await groupsService.listGroups(getBusinessId(req));
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to list customer groups.");
  }
}

export async function createGroup(req: Request, res: Response) {
  try {
    const parsed = createGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer group.",
        errors: parsed.error.flatten(),
      });
    }
    const group = await groupsService.createGroup(getBusinessId(req), req.user!.id, {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      isDefault: parsed.data.isDefault ?? false,
    });
    return res.status(201).json({ success: true, data: group });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the customer group.");
  }
}

export async function updateGroup(req: Request, res: Response) {
  try {
    const groupId = parseId(req.params.id);
    if (groupId == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const parsed = updateGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer group update.",
        errors: parsed.error.flatten(),
      });
    }
    const group = await groupsService.updateGroup(
      getBusinessId(req),
      req.user!.id,
      groupId,
      parsed.data,
    );
    return res.status(200).json({ success: true, data: group });
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the customer group.");
  }
}

export async function deleteGroup(req: Request, res: Response) {
  try {
    const groupId = parseId(req.params.id);
    if (groupId == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const group = await groupsService.deleteGroup(getBusinessId(req), groupId);
    return res.status(200).json({ success: true, data: group });
  } catch (err) {
    return sendSafeError(res, err, "Unable to delete the customer group.");
  }
}

export async function assignMembers(req: Request, res: Response) {
  try {
    const groupId = parseId(req.params.id);
    if (groupId == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const parsed = assignMembersSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid member assignment.",
        errors: parsed.error.flatten(),
      });
    }
    const result = await groupsService.assignMembers(
      getBusinessId(req),
      req.user!.id,
      groupId,
      parsed.data.customerIds,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to assign group members.");
  }
}

export async function removeMember(req: Request, res: Response) {
  try {
    const groupId = parseId(req.params.id);
    const customerId = parseId(req.params.customerId);
    if (groupId == null || customerId == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const result = await groupsService.removeMember(
      getBusinessId(req),
      groupId,
      customerId,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to remove the group member.");
  }
}

export async function listGroupMembers(req: Request, res: Response) {
  try {
    const groupId = parseId(req.params.id);
    if (groupId == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const rows = await groupsService.listGroupMembers(getBusinessId(req), groupId);
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to list group members.");
  }
}

export async function listGroupPricing(req: Request, res: Response) {
  try {
    const groupId = parseId(req.params.id);
    if (groupId == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const rows = await groupsService.listGroupPricing(getBusinessId(req), groupId);
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to list group pricing.");
  }
}

export async function createGroupPricing(req: Request, res: Response) {
  try {
    const groupId = parseId(req.params.id);
    if (groupId == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const parsed = groupPricingCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid group pricing rule.",
        errors: parsed.error.flatten(),
      });
    }
    const row = await groupsService.createGroupPricing(
      getBusinessId(req),
      req.user!.id,
      groupId,
      {
        categoryId: parsed.data.categoryId ?? null,
        productId: parsed.data.productId ?? null,
        variantId: parsed.data.variantId ?? null,
        discountType: parsed.data.discountType,
        discountValue: parsed.data.discountValue,
        minPurchaseAmount: parsed.data.minPurchaseAmount ?? 0,
        minQuantity: parsed.data.minQuantity ?? null,
        maxDiscountAmount: parsed.data.maxDiscountAmount ?? null,
        validFrom: parsed.data.validFrom ?? null,
        validTo: parsed.data.validTo ?? null,
        stacksWithPromotions: parsed.data.stacksWithPromotions ?? false,
        isActive: parsed.data.isActive ?? true,
      },
    );
    return res.status(201).json({ success: true, data: row });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the group pricing rule.");
  }
}

export async function updateGroupPricing(req: Request, res: Response) {
  try {
    const groupId = parseId(req.params.id);
    const pricingId = parseId(req.params.pricingId);
    if (groupId == null || pricingId == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const parsed = groupPricingUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid group pricing update.",
        errors: parsed.error.flatten(),
      });
    }
    const row = await groupsService.updateGroupPricing(
      getBusinessId(req),
      req.user!.id,
      groupId,
      pricingId,
      parsed.data,
    );
    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the group pricing rule.");
  }
}

export async function deleteGroupPricing(req: Request, res: Response) {
  try {
    const groupId = parseId(req.params.id);
    const pricingId = parseId(req.params.pricingId);
    if (groupId == null || pricingId == null) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const row = await groupsService.deleteGroupPricing(
      getBusinessId(req),
      groupId,
      pricingId,
    );
    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    return sendSafeError(res, err, "Unable to delete the group pricing rule.");
  }
}
