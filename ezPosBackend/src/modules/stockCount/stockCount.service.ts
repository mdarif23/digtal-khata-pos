import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  foldVariantOptionRows,
  variantNameFromMap,
  variantOptionsFromMap,
} from "../../utils/variantDisplay.js";
import { variantOptions } from "../../db/schema/variantOptions.js";
import { variantValues } from "../../db/schema/variantValues.js";
import {
  stockCountLines,
  stockCountSessions,
} from "../../db/schema/stockCount.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAuditInTx } from "../../services/audit.js";
import { publishRealtime } from "../realtime/realtime.service.js";
import { postStockCountLedgerEntry } from "../landed-cost/landed-cost.ledger.js";

/**
 * Stock-count sessions (Module 2A/2B): create a count (whole location or a
 * variant subset for cycle counts), count by barcode/SKU (partial counts
 * fine), then approve — the variance applied is counted − CURRENT stock
 * (row-locked at approval), so concurrent movements between counting and
 * approval can never desync inventory. Untracked lines are unaffected.
 */

export interface CreateSessionInput {
  businessId: number;
  locationId: number;
  actorUserId: number;
  note?: string | null;
  /** Cycle-count subset: only these variants are lined up. */
  variantIds?: number[] | undefined;
}

export async function createStockCountSession(input: CreateSessionInput) {
  return db.transaction(async (tx) => {
    let lines: { variantId: number; expected: number }[];
    if (input.variantIds && input.variantIds.length > 0) {
      const uniqueIds = [...new Set(input.variantIds)];
      const rows = await tx
        .select({
          variantId: inventoryStock.variantId,
          quantity: inventoryStock.quantity,
        })
        .from(inventoryStock)
        .where(
          and(
            eq(inventoryStock.businessId, input.businessId),
            eq(inventoryStock.locationId, input.locationId),
            inArray(inventoryStock.variantId, uniqueIds),
          ),
        );
      if (rows.length !== uniqueIds.length) {
        throw new NotFoundError(
          "One or more variants have no stock record at this location.",
        );
      }
      lines = rows.map((r) => ({
        variantId: r.variantId,
        expected: Number(r.quantity ?? 0),
      }));
    } else {
      // Whole-location count: every stocked variant.
      const rows = await tx
        .select({
          variantId: inventoryStock.variantId,
          quantity: inventoryStock.quantity,
        })
        .from(inventoryStock)
        .where(
          and(
            eq(inventoryStock.businessId, input.businessId),
            eq(inventoryStock.locationId, input.locationId),
          ),
        );
      if (rows.length === 0) {
        throw new BadRequestError(
          "This location has no stock to count yet.",
        );
      }
      lines = rows.map((r) => ({
        variantId: r.variantId,
        expected: Number(r.quantity ?? 0),
      }));
    }

    const [session] = await tx
      .insert(stockCountSessions)
      .values({
        businessId: input.businessId,
        locationId: input.locationId,
        createdByUserId: input.actorUserId,
        note: input.note ?? null,
        scope:
          input.variantIds && input.variantIds.length > 0
            ? { variantIds: input.variantIds }
            : null,
      })
      .returning({ id: stockCountSessions.id });
    if (!session) throw new Error("Session insert returned no row.");

    await tx.insert(stockCountLines).values(
      lines.map((line) => ({
        businessId: input.businessId,
        sessionId: session.id,
        variantId: line.variantId,
        expectedQuantity: line.expected,
      })),
    );

    await recordAuditInTx(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      action: "stock_count.created",
      entityType: "stock_count_session",
      entityId: session.id,
      metadata: {
        locationId: input.locationId,
        lineCount: lines.length,
        scoped: Boolean(input.variantIds?.length),
      },
    });
    return { sessionId: session.id, lineCount: lines.length };
  });
}

export async function listStockCountSessions(
  businessId: number,
  locationId: number,
) {
  return db
    .select({
      id: stockCountSessions.id,
      status: stockCountSessions.status,
      note: stockCountSessions.note,
      createdAt: stockCountSessions.createdAt,
      completedAt: stockCountSessions.completedAt,
      createdByUserId: stockCountSessions.createdByUserId,
    })
    .from(stockCountSessions)
    .where(
      and(
        eq(stockCountSessions.businessId, businessId),
        eq(stockCountSessions.locationId, locationId),
      ),
    )
    .orderBy(desc(stockCountSessions.id))
    .limit(100);
}

/** One session with its lines and product names (for the count screen). */
export async function getStockCountSession(
  businessId: number,
  locationId: number,
  sessionId: number,
) {
  const [session] = await db
    .select()
    .from(stockCountSessions)
    .where(
      and(
        eq(stockCountSessions.id, sessionId),
        eq(stockCountSessions.businessId, businessId),
        eq(stockCountSessions.locationId, locationId),
      ),
    )
    .limit(1);
  if (!session) throw new NotFoundError("Stock-count session not found.");

  const lines = await db
    .select({
      id: stockCountLines.id,
      variantId: stockCountLines.variantId,
      productName: products.name,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      expectedQuantity: stockCountLines.expectedQuantity,
      countedQuantity: stockCountLines.countedQuantity,
      countedAt: stockCountLines.countedAt,
    })
    .from(stockCountLines)
    .innerJoin(
      productVariants,
      eq(productVariants.id, stockCountLines.variantId),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(stockCountLines.sessionId, sessionId))
    .orderBy(stockCountLines.id);

  // Option labels batched per distinct variant — sibling variants of one
  // product must be distinguishable on the count screen.
  const variantIds = [...new Set(lines.map((l) => l.variantId))];
  let optionsByVariant = new Map<number, string[]>();
  if (variantIds.length > 0) {
    const optRows = await db
      .select({
        variantId: variantValues.variantId,
        value: variantOptions.value,
      })
      .from(variantValues)
      .innerJoin(variantOptions, eq(variantValues.optionId, variantOptions.id))
      .where(inArray(variantValues.variantId, variantIds))
      .orderBy(asc(variantValues.optionId));
    optionsByVariant = foldVariantOptionRows(optRows);
  }

  const linesWithLabels = lines.map((line) => ({
    ...line,
    variantOptions: variantOptionsFromMap(optionsByVariant, line.variantId),
    variantName: variantNameFromMap(optionsByVariant, line.variantId, line.productName),
  }));

  const counted = lines.filter((l) => l.countedQuantity !== null).length;
  return { session, lines: linesWithLabels, counted, total: lines.length };
}

/** Submits physical quantities for a set of lines (partial counts fine). */
export async function submitStockCount(
  businessId: number,
  locationId: number,
  sessionId: number,
  actorUserId: number,
  counts: { variantId: number; countedQuantity: number }[],
) {
  if (counts.length === 0) {
    throw new BadRequestError("No counted quantities submitted.");
  }
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ id: stockCountSessions.id, status: stockCountSessions.status })
      .from(stockCountSessions)
      .where(
        and(
          eq(stockCountSessions.id, sessionId),
          eq(stockCountSessions.businessId, businessId),
          eq(stockCountSessions.locationId, locationId),
        ),
      )
      .for("update");
    if (!session) throw new NotFoundError("Stock-count session not found.");
    if (session.status !== "open") {
      throw new ConflictError("Only open sessions accept counts.");
    }
    for (const count of counts) {
      if (!Number.isInteger(count.countedQuantity) || count.countedQuantity < 0) {
        throw new BadRequestError(
          "Counted quantities must be non-negative integers.",
        );
      }
    }
    for (const count of counts) {
      await tx
        .update(stockCountLines)
        .set({
          countedQuantity: count.countedQuantity,
          countedByUserId: actorUserId,
          countedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stockCountLines.sessionId, sessionId),
            eq(stockCountLines.variantId, count.variantId),
          ),
        );
    }
    return { recorded: counts.length };
  });
}

/**
 * Approval: applies every counted line as counted − CURRENT stock inside
 * one transaction. Lines not counted are skipped (partial counts). The
 * row-locked delta closes the count/approve race by construction.
 */
export async function approveStockCount(
  businessId: number,
  locationId: number,
  sessionId: number,
  actorUserId: number,
) {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ id: stockCountSessions.id, status: stockCountSessions.status })
      .from(stockCountSessions)
      .where(
        and(
          eq(stockCountSessions.id, sessionId),
          eq(stockCountSessions.businessId, businessId),
          eq(stockCountSessions.locationId, locationId),
        ),
      )
      .for("update");
    if (!session) throw new NotFoundError("Stock-count session not found.");
    if (session.status !== "open") {
      throw new ConflictError("Only open sessions can be approved.");
    }

    const lines = await tx
      .select({
        variantId: stockCountLines.variantId,
        countedQuantity: stockCountLines.countedQuantity,
      })
      .from(stockCountLines)
      .where(eq(stockCountLines.sessionId, sessionId));
    const countedLines = lines.filter((l) => l.countedQuantity !== null);
    if (countedLines.length === 0) {
      throw new ConflictError("Nothing has been counted yet.");
    }

    let applied = 0;
    // Finance & Growth ledger inputs: value leaving/entering inventory at
    // batch landed cost (shrinkage consumes FIFO; increases enter at the
    // variant's average landed cost).
    let shrinkageValue = 0;
    let increaseValue = 0;
    for (const line of countedLines) {
      const [stock] = await tx
        .select({ id: inventoryStock.id, quantity: inventoryStock.quantity })
        .from(inventoryStock)
        .where(
          and(
            eq(inventoryStock.businessId, businessId),
            eq(inventoryStock.locationId, locationId),
            eq(inventoryStock.variantId, line.variantId),
          ),
        )
        .for("update");
      if (!stock) continue; // stock record vanished — skip, reported below
      const current = Number(stock.quantity ?? 0);
      const delta = (line.countedQuantity as number) - current;
      if (delta === 0) continue;

      // Q5 fix: keep batch quantities in step with the stock row so cost
      // truth (batches) never diverges from quantity truth (stock).
      // Decreases consume the location's batches FIFO (shrinkage leaves
      // with their own landed cost); increases enter as a new ADJ batch
      // valued at the variant's average landed cost.
      if (delta < 0) {
        const batches = await tx
          .select({
            id: inventoryBatches.id,
            quantityRemaining: inventoryBatches.quantityRemaining,
            landedCostPerUnit: inventoryBatches.landedCostPerUnit,
          })
          .from(inventoryBatches)
          .where(
            and(
              eq(inventoryBatches.variantId, line.variantId),
              eq(inventoryBatches.businessId, businessId),
              eq(inventoryBatches.locationId, locationId),
              gt(inventoryBatches.quantityRemaining, 0),
            ),
          )
          .orderBy(asc(inventoryBatches.id))
          .for("update");
        let toRemove = -delta;
        for (const batch of batches) {
          if (toRemove <= 0) break;
          const take = Math.min(batch.quantityRemaining, toRemove);
          await tx
            .update(inventoryBatches)
            .set({ quantityRemaining: batch.quantityRemaining - take })
            .where(
              and(
                eq(inventoryBatches.id, batch.id),
                eq(inventoryBatches.businessId, businessId),
              ),
            );
          shrinkageValue += take * Number(batch.landedCostPerUnit ?? 0);
          toRemove -= take;
        }
      } else {
        const [avgRow] = await tx
          .select({
            avgCost: sql<string | null>`SUM(${inventoryBatches.quantityRemaining} * ${inventoryBatches.landedCostPerUnit}) / NULLIF(SUM(${inventoryBatches.quantityRemaining}), 0)`,
          })
          .from(inventoryBatches)
          .where(
            and(
              eq(inventoryBatches.variantId, line.variantId),
              eq(inventoryBatches.businessId, businessId),
            ),
          );
        const unitCost = Number(avgRow?.avgCost ?? 0);
        increaseValue += delta * unitCost;
        await tx.insert(inventoryBatches).values({
          businessId,
          variantId: line.variantId,
          locationId,
          batchNumber: `ADJ-${Date.now()}-${line.variantId}`,
          purchasePrice: unitCost,
          quantityReceived: delta,
          quantityRemaining: delta,
        });
      }

      await tx
        .update(inventoryStock)
        .set({ quantity: current + delta })
        .where(eq(inventoryStock.id, stock.id));
      await tx.insert(inventoryMovements).values({
        businessId,
        variantId: line.variantId,
        locationId,
        movementType: "adjustment",
        quantity: delta,
        referenceType: "stock_count_session",
        referenceId: sessionId,
      });
      applied += 1;
    }

    await tx
      .update(stockCountSessions)
      .set({
        status: "completed",
        approvedByUserId: actorUserId,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(stockCountSessions.id, sessionId));

    // Finance & Growth: post the count variance to the ledger at batch
    // landed cost (DR 5070/CR 1050 for shrinkage, reversed for gains;
    // no-op before activation; idempotent per session).
    await postStockCountLedgerEntry(tx, {
      businessId,
      sessionId,
      shrinkageValue,
      increaseValue,
      locationId,
      actorUserId,
    });

    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "stock_count.approved",
      entityType: "stock_count_session",
      entityId: sessionId,
      metadata: {
        locationId,
        countedLines: countedLines.length,
        adjustmentsApplied: applied,
      },
    });

    publishRealtime(businessId, locationId, {
      kind: "stock.changed",
      locationId,
    });

    return {
      sessionId,
      countedLines: countedLines.length,
      adjustmentsApplied: applied,
    };
  });
}

export async function cancelStockCount(
  businessId: number,
  locationId: number,
  sessionId: number,
  actorUserId: number,
) {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ id: stockCountSessions.id, status: stockCountSessions.status })
      .from(stockCountSessions)
      .where(
        and(
          eq(stockCountSessions.id, sessionId),
          eq(stockCountSessions.businessId, businessId),
          eq(stockCountSessions.locationId, locationId),
        ),
      )
      .for("update");
    if (!session) throw new NotFoundError("Stock-count session not found.");
    if (session.status !== "open") {
      throw new ConflictError("Only open sessions can be cancelled.");
    }
    await tx
      .update(stockCountSessions)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(stockCountSessions.id, sessionId));
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "stock_count.cancelled",
      entityType: "stock_count_session",
      entityId: sessionId,
      metadata: { locationId },
    });
    return { cancelled: true };
  });
}
