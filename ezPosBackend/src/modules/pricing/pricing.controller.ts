import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import * as pricingService from "./pricing.service.js";
import * as pricingRulesService from "./pricing.rules.service.js";
import {
  applyPriceSchema,
  priceHistoryQuerySchema,
  pricingPreviewSchema,
  pricingRuleCreateSchema,
  pricingRuleUpdateSchema,
  pricingSettingsUpdateSchema,
} from "./pricing.validation.js";

/**
 * Pricing module controller (settings, preview, rules, materialization,
 * history). Cost fields in ANY pricing response are stripped for callers
 * without products.view_cost — same contract as the product catalog
 * (rbac/sanitize.ts).
 */

/** Strip cost-shaped fields from a pricing payload. */
function stripCostFields<T extends Record<string, unknown>>(row: T): T {
  const { cost: _cost, costAtChange: _costAtChange, ...rest } = row;
  return rest as T;
}

function includeCost(req: Request): boolean {
  return callerHasPermission(req, "products.view_cost");
}

export async function getPricingSettings(req: Request, res: Response) {
  try {
    const settings = await pricingService.getPricingSettingsView(
      getBusinessId(req),
    );
    return res.status(200).json({ success: true, data: settings });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load pricing settings.");
  }
}

export async function putPricingSettings(req: Request, res: Response) {
  try {
    const parsed = pricingSettingsUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid pricing settings.",
        errors: parsed.error.flatten(),
      });
    }
    const settings = await pricingService.upsertPricingSettings(
      getBusinessId(req),
      parsed.data,
    );
    return res.status(200).json({ success: true, data: settings });
  } catch (err) {
    return sendSafeError(res, err, "Unable to save pricing settings.");
  }
}

export async function postPreview(req: Request, res: Response) {
  try {
    const parsed = pricingPreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid pricing preview request.",
        errors: parsed.error.flatten(),
      });
    }
    const rows = await pricingService.previewVariantPricing(
      getBusinessId(req),
      parsed.data,
    );
    // Cost visibility: pricing.view callers without products.view_cost never
    // see cost figures (same rule as the product catalog).
    const data = includeCost(req)
      ? rows
      : rows.map((row) => ({ ...row, cost: null }));
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendSafeError(res, err, "Unable to calculate price previews.");
  }
}

// ---------------------------------------------------------------------------
// Rules (Phase 2)
// ---------------------------------------------------------------------------

export async function listRules(req: Request, res: Response) {
  try {
    const rows = await pricingRulesService.listRules(getBusinessId(req));
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to list pricing rules.");
  }
}

export async function createRule(req: Request, res: Response) {
  try {
    const parsed = pricingRuleCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid pricing rule.",
        errors: parsed.error.flatten(),
      });
    }
    const rule = await pricingRulesService.createRule(
      getBusinessId(req),
      req.user!.id,
      {
        categoryId: parsed.data.categoryId ?? null,
        productId: parsed.data.productId ?? null,
        variantId: parsed.data.variantId ?? null,
        method: parsed.data.method,
        percentage: parsed.data.percentage ?? null,
        fixedPrice: parsed.data.fixedPrice ?? null,
        isActive: parsed.data.isActive ?? true,
      },
    );
    return res.status(201).json({ success: true, data: rule });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the pricing rule.");
  }
}

export async function patchRule(req: Request, res: Response) {
  try {
    const ruleId = Number(req.params.id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const parsed = pricingRuleUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid pricing rule update.",
        errors: parsed.error.flatten(),
      });
    }
    const rule = await pricingRulesService.updateRule(
      getBusinessId(req),
      req.user!.id,
      ruleId,
      parsed.data,
    );
    return res.status(200).json({ success: true, data: rule });
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the pricing rule.");
  }
}

export async function deleteRule(req: Request, res: Response) {
  try {
    const ruleId = Number(req.params.id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const rule = await pricingRulesService.deleteRule(getBusinessId(req), ruleId);
    return res.status(200).json({ success: true, data: rule });
  } catch (err) {
    return sendSafeError(res, err, "Unable to delete the pricing rule.");
  }
}

// ---------------------------------------------------------------------------
// Effective pricing + materialization (Phase 2)
// ---------------------------------------------------------------------------

export async function getVariantPricing(req: Request, res: Response) {
  try {
    const variantId = Number(req.params.variantId);
    if (!Number.isInteger(variantId) || variantId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const view = await pricingRulesService.getVariantPricingView(
      getBusinessId(req),
      variantId,
    );
    const data = includeCost(req) ? view : stripCostFields(view);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load the effective pricing.");
  }
}

export async function applyVariantPrice(req: Request, res: Response) {
  try {
    const variantId = Number(req.params.variantId);
    if (!Number.isInteger(variantId) || variantId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid ID." });
    }
    const parsed = applyPriceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid apply-price request.",
        errors: parsed.error.flatten(),
      });
    }
    const result = await pricingRulesService.applyRecommendedPrice(
      getBusinessId(req),
      req.user!.id,
      variantId,
      parsed.data.reason ?? null,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to apply the price change.");
  }
}

export async function listPriceHistory(req: Request, res: Response) {
  try {
    const parsed = priceHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid price history query.",
        errors: parsed.error.flatten(),
      });
    }
    const { rows, meta } = await pricingRulesService.listPriceHistory(
      getBusinessId(req),
      parsed.data,
    );
    const data = includeCost(req) ? rows : rows.map(stripCostFields);
    return res.status(200).json({ success: true, rows: data, meta });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load the price history.");
  }
}
