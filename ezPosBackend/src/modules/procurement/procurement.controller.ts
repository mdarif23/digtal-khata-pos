import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import * as priceCheckService from "./priceCheck.service.js";
import * as priceHistoryService from "./priceHistory.service.js";
import {
  createObservationSchema,
  listObservationsQuerySchema,
  observationIdParamSchema,
  updateObservationSchema,
} from "./schemas/priceCheck.schema.js";
import {
  priceHistoryQuerySchema,
  priceOverviewQuerySchema,
  variantIdParamSchema,
} from "./schemas/priceHistory.schema.js";

export async function getPriceOverview(req: Request, res: Response) {
  try {
    const parsed = priceOverviewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid query parameters",
        errors: parsed.error.flatten(),
      });
    }
    const result = await priceHistoryService.getPriceOverview(
      getBusinessId(req),
      parsed.data,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Failed to load the price overview.");
  }
}

export async function getVariantPriceHistory(req: Request, res: Response) {
  try {
    const parsedParams = variantIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: "Invalid variant id",
        errors: parsedParams.error.flatten(),
      });
    }
    const parsedQuery = priceHistoryQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({
        message: "Invalid query parameters",
        errors: parsedQuery.error.flatten(),
      });
    }
    const result = await priceHistoryService.getVariantPriceHistory(
      getBusinessId(req),
      parsedParams.data.variantId,
      parsedQuery.data,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Failed to load the price history.");
  }
}

export async function createObservation(req: Request, res: Response) {
  try {
    const parsed = createObservationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid price check data",
        errors: parsed.error.flatten(),
      });
    }
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const result = await priceCheckService.createObservation(
      getBusinessId(req),
      req.user.id,
      parsed.data,
    );
    return res.status(201).json({
      success: true,
      message: "Price observation recorded",
      data: result,
    });
  } catch (err) {
    return sendSafeError(res, err, "Failed to record the price observation.");
  }
}

export async function listObservations(req: Request, res: Response) {
  try {
    const parsed = listObservationsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid query parameters",
        errors: parsed.error.flatten(),
      });
    }
    const result = await priceCheckService.listObservations(
      getBusinessId(req),
      parsed.data,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Failed to load price check history.");
  }
}

export async function updateObservation(req: Request, res: Response) {
  try {
    const parsedParams = observationIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: "Invalid observation id",
        errors: parsedParams.error.flatten(),
      });
    }
    const parsed = updateObservationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid price check data",
        errors: parsed.error.flatten(),
      });
    }
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const result = await priceCheckService.updateObservation(
      getBusinessId(req),
      req.user.id,
      parsedParams.data.id,
      parsed.data,
    );
    return res.status(200).json({
      success: true,
      message: "Price observation updated",
      data: result,
    });
  } catch (err) {
    return sendSafeError(res, err, "Failed to update the price observation.");
  }
}

export async function deleteObservation(req: Request, res: Response) {
  try {
    const parsedParams = observationIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: "Invalid observation id",
        errors: parsedParams.error.flatten(),
      });
    }
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    await priceCheckService.deleteObservation(
      getBusinessId(req),
      req.user.id,
      parsedParams.data.id,
    );
    return res.status(200).json({
      success: true,
      message: "Price observation deleted",
    });
  } catch (err) {
    return sendSafeError(res, err, "Failed to delete the price observation.");
  }
}
