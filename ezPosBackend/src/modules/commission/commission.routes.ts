import express from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import {
  getBusinessId,
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import { db } from "../../db/schema/index.js";
import { sales } from "../../db/schema/sales.js";
import { and, eq } from "drizzle-orm";
import {
  createRule,
  listEntries,
  listRules,
  reassignSalesperson,
  transitionEntry,
  updateRule,
  getSalespersonPerformance,
  getTargetAchievements,
  listTargets,
  setTarget,
} from "./commission.service.js";

const router = express.Router();

const read = [requireAuth, requireBusinessContext()] as const;
const manage = [...read, requireFullAccess, requirePermission("commission.manage")] as const;

// ---- rules ----
router.get("/api/commission/rules", ...read, requirePermission("commission.view"), async (req: Request, res: Response) => {
  try {
    const data = await listRules(getBusinessId(req));
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load commission rules.");
  }
});

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  calcMethod: z.enum(["percentage_of_sales", "fixed_per_sale", "percentage_of_profit"]),
  rate: z.number().min(0).max(1_000_000),
  categoryId: z.number().int().positive().nullable().optional(),
  productId: z.number().int().positive().nullable().optional(),
  userId: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().optional(),
});

router.post("/api/commission/rules", ...manage, async (req: Request, res: Response) => {
  try {
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid commission rule.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await createRule(getBusinessId(req), req.user!.id, {
      name: parsed.data.name,
      calcMethod: parsed.data.calcMethod,
      rate: parsed.data.rate,
      categoryId: parsed.data.categoryId ?? null,
      productId: parsed.data.productId ?? null,
      userId: parsed.data.userId ?? null,
      isActive: parsed.data.isActive,
    });
    return res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the commission rule.");
  }
});

router.patch("/api/commission/rules/:ruleId", ...manage, async (req: Request, res: Response) => {
  try {
    const ruleId = Number(req.params.ruleId);
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      throw new BadRequestError("Invalid rule ID.");
    }
    const parsed = ruleSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid commission rule.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await updateRule(getBusinessId(req), req.user!.id, ruleId, parsed.data as import("./commission.service.js").CommissionRulePatch);
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the commission rule.");
  }
});

// ---- entries + lifecycle ----
router.get("/api/commission/entries", ...read, requirePermission("commission.view"), async (req: Request, res: Response) => {
  try {
    const data = await listEntries(getBusinessId(req), {
      ...(typeof req.query.status === "string" ? { status: req.query.status } : {}),
      ...(req.query.userId ? { userId: Number(req.query.userId) } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
      ...(req.query.offset ? { offset: Number(req.query.offset) } : {}),
    });
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load commission entries.");
  }
});

const transitionSchema = z.object({
  status: z.enum(["approved", "payable", "paid", "reversed"]),
  reason: z.string().trim().max(500).optional(),
});

router.post("/api/commission/entries/:entryId/status", ...manage, async (req: Request, res: Response) => {
  try {
    const entryId = Number(req.params.entryId);
    if (!Number.isInteger(entryId) || entryId <= 0) {
      throw new BadRequestError("Invalid entry ID.");
    }
    const parsed = transitionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid lifecycle transition.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await transitionEntry(
      getBusinessId(req),
      req.user!.id,
      entryId,
      parsed.data.status,
      parsed.data.reason,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the commission entry.");
  }
});

// ---- salesperson performance ----
router.get(
  "/api/commission/performance",
  ...read,
  requirePermission("commission.view"),
  async (req: Request, res: Response) => {
    try {
      const from = typeof req.query.from === "string" ? req.query.from : "";
      const to = typeof req.query.to === "string" ? req.query.to : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw new BadRequestError("Provide from/to dates (YYYY-MM-DD).");
      }
      const locationId = typeof req.query.locationId === "string" ? Number(req.query.locationId) : null;
      const data = await getSalespersonPerformance(
        getBusinessId(req),
        Number.isInteger(locationId) ? locationId : null,
        from,
        to,
      );
      return res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to load salesperson performance.");
    }
  },
);

// ---- salesperson reassignment ----
const reassignSchema = z.object({
  salespersonUserId: z.number().int().positive().nullable(),
});

router.post("/api/sales/:saleId/reassign-salesperson", ...manage, async (req: Request, res: Response) => {
  try {
    const saleId = Number(req.params.saleId);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      throw new BadRequestError("Invalid sale ID.");
    }
    const parsed = reassignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid salesperson.",
        errors: parsed.error.flatten(),
      });
    }
    // Validate the sale exists in the business for a clean 404.
    const [sale] = await db
      .select({ id: sales.id })
      .from(sales)
      .where(and(eq(sales.id, saleId), eq(sales.businessId, getBusinessId(req))))
      .limit(1);
    if (!sale) throw new NotFoundError("Sale not found.");
    await reassignSalesperson(
      getBusinessId(req),
      req.user!.id,
      saleId,
      parsed.data.salespersonUserId,
    );
    return res.status(200).json({ success: true });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to reassign the salesperson.");
  }
});

// ---- targets ----
router.get("/api/targets", ...read, requirePermission("commission.view"), async (req: Request, res: Response) => {
  try {
    const data = await listTargets(getBusinessId(req));
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load targets.");
  }
});

router.get("/api/targets/achievement", ...read, requirePermission("commission.view"), async (req: Request, res: Response) => {
  try {
    const locationId = typeof req.query.locationId === "string" ? Number(req.query.locationId) : null;
    const data = await getTargetAchievements(
      getBusinessId(req),
      Number.isInteger(locationId) ? locationId : null,
    );
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load target achievements.");
  }
});

const targetSchema = z.object({
  userId: z.number().int().positive(),
  periodType: z.enum(["daily", "weekly", "monthly", "custom"]),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  targetAmount: z.number().min(0).max(1_000_000_000),
});

router.put("/api/targets", ...manage, requirePermission("targets.manage"), async (req: Request, res: Response) => {
  try {
    const parsed = targetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid target.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await setTarget(getBusinessId(req), req.user!.id, parsed.data);
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to save the target.");
  }
});

export default router;
