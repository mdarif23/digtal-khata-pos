import express from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../middleware/auth.js";
import {
  getBusinessId,
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError } from "../../utils/handleError.js";
import { db } from "../../db/schema/index.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { productionRunItems, productionRuns } from "../../db/schema/bom.js";
import {
  computeBomUnitCost,
  flattenBom,
  getBom,
  setBom,
} from "./bom.service.js";
import { consumeStockFifo } from "../sales/sales.service.js";
import { recordAudit, recordAuditInTx } from "../../services/audit.js";
import { roundMoney } from "../../utils/roundMoney.js";

const router = express.Router();

const read = [requireAuth, requireBusinessContext()] as const;
const write = [...read, requireFullAccess] as const;

const setSchema = z.object({
  components: z
    .array(
      z.object({
        componentVariantId: z.number().int().positive(),
        quantity: z.number().positive().max(1_000_000),
        wastePercent: z.number().min(0).max(100).optional(),
      }),
    )
    .max(100),
});

router.get(
  "/api/variants/:variantId/bom",
  ...read,
  requirePermission("products.view"),
  async (req: Request, res: Response) => {
    try {
      const variantId = Number(req.params.variantId);
      if (!Number.isInteger(variantId) || variantId <= 0) {
        throw new BadRequestError("Invalid variant ID.");
      }
      const bom = await getBom(getBusinessId(req), variantId);
      const estimatedUnitCost =
        bom.components.length > 0
          ? await computeBomUnitCost(getBusinessId(req), variantId)
          : 0;
      return res
        .status(200)
        .json({ success: true, data: { ...bom, estimatedUnitCost } });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to load the BOM.");
    }
  },
);

router.put(
  "/api/variants/:variantId/bom",
  ...write,
  requirePermission("products.manage_variants"),
  async (req: Request, res: Response) => {
    try {
      const variantId = Number(req.params.variantId);
      if (!Number.isInteger(variantId) || variantId <= 0) {
        throw new BadRequestError("Invalid variant ID.");
      }
      const parsed = setSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid BOM definition.",
          errors: parsed.error.flatten(),
        });
      }
      const bom = await setBom(getBusinessId(req), variantId, parsed.data);
      recordAudit({
        businessId: getBusinessId(req),
        actorUserId: req.user?.id ?? null,
        action: "bom.updated",
        entityType: "variant",
        entityId: variantId,
        afterState: { componentCount: bom.components.length },
      });
      return res.status(200).json({ success: true, data: bom });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to save the BOM.");
    }
  },
);

/**
 * Production run (Phase 4): consumes components through FIFO at the
 * location, creates a finished composite batch with the summed component
 * cost, and records traceable movements. One transaction.
 */
const runSchema = z.object({
  locationId: z.number().int().positive(),
  quantity: z.number().positive().max(1_000_000),
  notes: z.string().trim().max(1000).optional(),
});

router.post(
  "/api/variants/:variantId/production-runs",
  ...write,
  requirePermission("inventory.adjust"),
  async (req: Request, res: Response) => {
    try {
      const variantId = Number(req.params.variantId);
      if (!Number.isInteger(variantId) || variantId <= 0) {
        throw new BadRequestError("Invalid variant ID.");
      }
      const parsed = runSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid production run.",
          errors: parsed.error.flatten(),
        });
      }
      const businessId = getBusinessId(req);
      const userId = req.user!.id;
      const { locationId, quantity } = parsed.data;
      const notes = parsed.data.notes ?? null;

      const flat = await flattenBom(businessId, variantId, quantity);
      if (flat.length === 0) {
        throw new BadRequestError("This variant has no BOM to assemble.");
      }

      const result = await db.transaction(async (tx) => {
        let totalCost = 0;
        const consumedRows: {
          componentVariantId: number;
          quantityConsumed: number;
          unitCost: number;
        }[] = [];
        for (const component of flat) {
          const consumed = await consumeStockFifo(
            tx,
            businessId,
            locationId,
            component.componentVariantId,
            component.quantity,
          );
          const consumedUnits = consumed.consumed.reduce(
            (sum, c) => sum + c.quantity,
            0,
          );
          totalCost += consumed.totalCost;
          consumedRows.push({
            componentVariantId: component.componentVariantId,
            quantityConsumed: component.quantity,
            unitCost:
              consumedUnits > 0
                ? roundMoney(consumed.totalCost / consumedUnits)
                : 0,
          });
          await tx.insert(inventoryMovements).values({
            businessId,
            variantId: component.componentVariantId,
            locationId,
            movementType: "adjustment",
            quantity: -component.quantity,
            referenceType: "production_run",
            referenceId: null,
          });
        }
        totalCost = roundMoney(totalCost);

        const [run] = await tx
          .insert(productionRuns)
          .values({
            businessId,
            locationId,
            parentVariantId: variantId,
            quantity,
            componentCost: totalCost,
            notes,
            createdBy: userId,
          })
          .returning({ id: productionRuns.id });
        if (!run) throw new Error("Production run insert returned no row.");

        for (const row of consumedRows) {
          await tx.insert(productionRunItems).values({
            businessId,
            runId: run.id,
            componentVariantId: row.componentVariantId,
            quantityConsumed: row.quantityConsumed,
            unitCost: row.unitCost,
          });
        }

        // Finished composite stock at the summed component cost.
        const unitCost = Number(quantity) > 0 ? roundMoney(totalCost / Number(quantity)) : 0;
        const [batch] = await tx
          .insert(inventoryBatches)
          .values({
            businessId,
            locationId,
            variantId,
            purchaseItemId: null,
            batchNumber: `PR-${run.id}-${Date.now()}`,
            purchasePrice: unitCost,
            quantityReceived: Number(quantity),
            quantityRemaining: Number(quantity),
          })
          .returning({ id: inventoryBatches.id });
        await tx
          .insert(inventoryStock)
          .values({
            businessId,
            locationId,
            variantId,
            quantity: Number(quantity),
          })
          .onConflictDoUpdate({
            target: [
              inventoryStock.businessId,
              inventoryStock.variantId,
              inventoryStock.locationId,
            ],
            set: {
              quantity: sql`${inventoryStock.quantity} + ${Number(quantity)}`,
            },
          });
        await tx.insert(inventoryMovements).values({
          businessId,
          variantId,
          locationId,
          batchId: batch?.id ?? null,
          movementType: "adjustment",
          quantity: Number(quantity),
          referenceType: "production_run",
          referenceId: run.id,
        });

        await recordAuditInTx(tx, {
          businessId,
          actorUserId: userId,
          action: "production_run.completed",
          entityType: "production_run",
          entityId: run.id,
          metadata: {
            variantId,
            quantity: Number(quantity),
            componentCost: totalCost,
          },
        });

        return { runId: run.id, totalCost, consumedRows };
      });

      return res.status(201).json({
        success: true,
        data: {
          runId: result.runId,
          componentCost: result.totalCost,
          components: result.consumedRows,
        },
      });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to run the production run.");
    }
  },
);

export default router;
