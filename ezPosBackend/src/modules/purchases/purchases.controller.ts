import type { Request, Response } from "express";
import * as purchasesService from "./purchases.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import { createPurchaseSchema } from "./schemas/purchase.schema.js";
import { receiveItemsFormSchema } from "./schemas/receiveItem.schema.js";
import {
  updateReceivingSettingsSchema,
} from "./receivingSettings.schema.js";
import {
  resolveOutstandingSchema,
  resolveDiscrepancySchema,
} from "./outstandingResolution.schema.js";
import {
  resolveOutstandingQuantities,
  resolvePurchaseDiscrepancy,
  getPurchaseDiscrepancyDetail,
} from "./outstandingResolution.service.js";
import {
  listPurchases,
} from "./purchasesList.service.js";
import {
  purchaseListQuerySchema,
} from "./purchasesList.schema.js";
import type { ZodType } from "zod";

function parseListQuery<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const message = first
      ? `${first.path.join(".") || "query"}: ${first.message}`
      : "Invalid query parameters.";
    const err = new Error(message) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
  return result.data;
}
import {
  getReceivingSettings,
  updateReceivingSettings,
} from "./receivingSettings.service.js";

export async function createPurchase(req: Request, res: Response) {
  try {
    const result = createPurchaseSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid purchase data",
        errors: result.error.flatten(),
      });
    }
    const purchase = await purchasesService.createPurchase(
      getBusinessId(req),
      result.data,
    );
    return res.status(201).json({
      success: true,
      message: "Purchase created successfully",
      data: purchase,
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the purchase.");
  }
}
export async function getPurchasesSummary(req: Request, res: Response) {
  try {
    const result = await purchasesService.getPurchasesSummary(getBusinessId(req));
    res.status(200).json(result);
  } catch (err) {
    sendSafeError(res, err, "Unable to load purchases.");
  }
}
export async function getPurchasesItems(req: Request, res: Response) {
  try {
    const result = await purchasesService.getPurchasesItems(
      getBusinessId(req),
      getLocationId(req),
    );
    res.status(200).json(result);
  } catch (err) {
    sendSafeError(res, err, "Unable to load purchase items.");
  }
}
export async function createReceivePurchase(req: Request, res: Response) {
  try {
    const result = receiveItemsFormSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid Purchase Data",
        errors: result.error.flatten(),
      });
    }
    // The service returns the unified {success, message, data} envelope.
    // Over-receiving beyond tolerance requires purchases.over_receive.
    const received = await purchasesService.createReceivePurchase(
      getBusinessId(req),
      getLocationId(req),
      result.data,
      req.user?.id,
      callerHasPermission(req, "purchases.over_receive"),
    );
    res.status(201).json(received);
  } catch (err) {
    return sendSafeError(res, err, "Unable to receive the purchase.");
  }
}

export async function getPurchaseDetail(req: Request, res: Response) {
  try {
    const purchaseId = Number(req.params.id);
    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid purchase order id." });
    }
    const detail = await purchasesService.getPurchaseDetail(
      getBusinessId(req),
      purchaseId,
    );
    res.status(200).json(detail);
  } catch (err) {
    return sendSafeError(res, err, "Unable to load the purchase order.");
  }
}

export async function getReceivingSettingsHandler(req: Request, res: Response) {
  try {
    const settings = await getReceivingSettings(getBusinessId(req));
    res.status(200).json({ success: true, data: settings });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load receiving settings.");
  }
}

export async function updateReceivingSettingsHandler(
  req: Request,
  res: Response,
) {
  try {
    const result = updateReceivingSettingsSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid receiving settings.",
        errors: result.error.flatten(),
      });
    }
    const settings = await updateReceivingSettings(
      getBusinessId(req),
      result.data,
    );
    res.status(200).json({
      success: true,
      message: "Receiving settings updated.",
      data: settings,
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to update receiving settings.");
  }
}

export async function resolveOutstanding(req: Request, res: Response) {
  try {
    const purchaseId = Number(req.params.id);
    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid purchase order id." });
    }
    const result = resolveOutstandingSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid outstanding resolution.",
        errors: result.error.flatten(),
      });
    }
    const resolved = await resolveOutstandingQuantities(
      getBusinessId(req),
      purchaseId,
      req.user?.id ?? 0,
      result.data,
    );
    res.status(200).json(resolved);
  } catch (err) {
    return sendSafeError(res, err, "Unable to resolve the outstanding quantities.");
  }
}

export async function resolveDiscrepancy(req: Request, res: Response) {
  try {
    const purchaseId = Number(req.params.id);
    const discrepancyId = Number(req.params.discrepancyId);
    if (
      !Number.isInteger(purchaseId) ||
      purchaseId <= 0 ||
      !Number.isInteger(discrepancyId) ||
      discrepancyId <= 0
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid identifier." });
    }
    const result = resolveDiscrepancySchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid discrepancy resolution.",
        errors: result.error.flatten(),
      });
    }
    const resolved = await resolvePurchaseDiscrepancy(
      getBusinessId(req),
      purchaseId,
      discrepancyId,
      req.user?.id ?? 0,
      result.data,
    );
    res.status(200).json(resolved);
  } catch (err) {
    return sendSafeError(res, err, "Unable to resolve the discrepancy.");
  }
}

export async function getDiscrepancies(req: Request, res: Response) {
  try {
    const purchaseId = Number(req.params.id);
    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid purchase order id." });
    }
    const detail = await getPurchaseDiscrepancyDetail(
      getBusinessId(req),
      purchaseId,
    );
    res.status(200).json(detail);
  } catch (err) {
    return sendSafeError(res, err, "Unable to load the discrepancy trail.");
  }
}

export async function getPurchasesList(req: Request, res: Response) {
  try {
    const query = parseListQuery(purchaseListQuerySchema, req.query);
    const page = await listPurchases(getBusinessId(req), query);
    res.status(200).json(page);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 400) {
      return res
        .status(400)
        .json({ success: false, message: (err as Error).message });
    }
    return sendSafeError(res, err, "Unable to load the purchase list.");
  }
}
