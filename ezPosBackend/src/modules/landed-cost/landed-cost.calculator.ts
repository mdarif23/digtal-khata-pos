import {
  allocateByBasis,
  amountToMicros,
  lineNetValueMicros,
  microsToAmount,
  microsToPerUnit,
  quantityToMillis,
  weightToKgQuads,
} from "./landed-cost.money.js";
import type { LandedCostAllocationMethod } from "./landed-cost.types.js";

/**
 * Pure landed-cost allocation engine (Part E). No database access — the
 * caller assembles allocation lines from the purchase, its batches and
 * variant weights; the engine produces exact, reconciled allocations.
 *
 * All authoritative arithmetic is BigInt micros; the only rounding is the
 * deterministic largest-remainder distribution, so:
 *   Σ allocatedAmount === total being allocated — always.
 */

export interface AllocationBatchInput {
  batchId: number;
  batchNumber: string;
  /** Received quantity of this batch (numeric(12,3)). */
  quantityReceived: number | string;
}

export interface AllocationLineInput {
  purchaseItemId: number;
  variantId: number;
  /** Line unit cost (numeric(12,2)) — the ORIGINAL purchase cost. */
  unitCost: number | string;
  /** Line discount (numeric(12,2)). */
  discount: number | string;
  /**
   * Ordered quantity for the line (Part F cumulative targets). When omitted
   * the line is treated as fully received (ordered = Σ batch quantities).
   */
  quantityOrdered?: number | string;
  batches: AllocationBatchInput[];
  /** Variant unit weight (numeric(12,4)) + unit; null = not set. */
  variantWeight?: number | string | null;
  variantWeightUnit?: string | null;
  /** Product-level default weight in kg (products.shipping_weight_kg). */
  productDefaultWeightKg?: number | string | null;
}

export interface ManualLineInput {
  purchaseItemId: number;
  /** User-allocated amount for this line (2-dp currency). */
  amount: number | string;
}

export interface AllocationBatchResult {
  batchId: number;
  batchNumber: string;
  quantitySnapshot: number;
  basisValue: number;
  allocatedAmount: number;
  allocatedPerUnit: number;
  weightSnapshot: number | null;
}

export interface AllocationLineResult {
  purchaseItemId: number;
  variantId: number;
  batches: AllocationBatchResult[];
  lineAllocatedAmount: number;
  /** Cumulative target for the complete order (Part F). */
  lineTotalTargetAmount: number;
  /** Portion of the target attributable to received units (capitalizable now). */
  lineReceivedTargetAmount: number;
  orderedQuantity: number;
  receivedQuantity: number;
}

export interface AllocationEngineResult {
  lines: AllocationLineResult[];
  /** Sum of all allocated amounts — always equals the received target. */
  allocatedTotal: number;
  /** The requested total minus received targets — the not-yet-received reserve. */
  pendingTotal: number;
}

export interface LandedCostValidationIssue {
  code: string;
  message: string;
  field?: string;
}

export class LandedCostValidationError extends Error {
  readonly issues: LandedCostValidationIssue[];
  constructor(issues: LandedCostValidationIssue[]) {
    super(issues.map((i) => i.message).join("; "));
    this.name = "LandedCostValidationError";
    this.issues = issues;
  }
}

function resolveWeightQuads(line: AllocationLineInput): bigint | null {
  if (
    line.variantWeight !== null &&
    line.variantWeight !== undefined &&
    Number(line.variantWeight) > 0
  ) {
    return weightToKgQuads(line.variantWeight, line.variantWeightUnit);
  }
  if (
    line.productDefaultWeightKg !== null &&
    line.productDefaultWeightKg !== undefined &&
    Number(line.productDefaultWeightKg) > 0
  ) {
    // Product default ships as kg (products.shipping_weight_kg).
    return weightToKgQuads(line.productDefaultWeightKg, "kg");
  }
  return null;
}

/**
 * Allocates `total` (2-dp currency) across the received batches of the
 * purchase lines using the given method. For `manual`, the per-line amounts
 * must sum to `total` exactly; each line's amount is then split across its
 * batches by batch quantity (FIFO order = batch id).
 */
export function calculateAllocation(options: {
  method: LandedCostAllocationMethod;
  total: number | string;
  lines: AllocationLineInput[];
  manualLines?: ManualLineInput[];
}): AllocationEngineResult {
  const { method, lines } = options;
  // Allocate on the 4-dp storage grid (quads = 1e-4 currency, what
  // allocated_amount numeric(14,4) stores). total is 2-dp, so the
  // conversion is exact and sum(allocations) == total EXACTLY at storage.
  const totalQuads = amountToMicros(options.total) / 100n;

  const issues: LandedCostValidationIssue[] = [];
  if (lines.length === 0) {
    issues.push({
      code: "no_lines",
      message: "No received purchase lines to allocate against.",
    });
  }
  // NOTE: received > ordered is legitimate since approved over-receiving
  // (migration 0052) — the received target is clamped at the line's total
  // target below, so over-received lines simply allocate everything with
  // nothing left pending.
  const seenItems = new Set<number>();
  for (const line of lines) {
    if (seenItems.has(line.purchaseItemId)) {
      issues.push({
        code: "duplicate_line",
        message: `Purchase item ${line.purchaseItemId} appears more than once.`,
        field: "lines",
      });
    }
    seenItems.add(line.purchaseItemId);
    const batchIds = new Set<number>();
    for (const batch of line.batches) {
      if (batchIds.has(batch.batchId)) {
        issues.push({
          code: "duplicate_batch",
          message: `Batch ${batch.batchId} appears more than once for item ${line.purchaseItemId}.`,
          field: "lines",
        });
      }
      batchIds.add(batch.batchId);
      if (Number(batch.quantityReceived) <= 0) {
        issues.push({
          code: "invalid_batch_quantity",
          message: `Batch ${batch.batchNumber} has a non-positive received quantity.`,
          field: "lines",
        });
      }
    }
    if (Number(line.unitCost) < 0 || Number(line.discount) < 0) {
      issues.push({
        code: "negative_line_cost",
        message: "Line costs and discounts must be non-negative.",
        field: "lines",
      });
    }
  }

  if (method === "weight") {
    for (const line of lines) {
      if (resolveWeightQuads(line) === null) {
        issues.push({
          code: "missing_weight",
          message: `Weight allocation needs a variant weight or a product default weight for purchase item ${line.purchaseItemId}.`,
          field: "lines",
        });
      }
    }
  }

  if (method === "manual") {
    const manual = options.manualLines ?? [];
    // Only lines with received batches participate in manual allocation —
    // ordered-but-unreceived lines hold their share as pending allocation.
    const receivedItems = new Set(
      lines
        .filter((line) => line.batches.length > 0)
        .map((line) => line.purchaseItemId),
    );
    const manualIds = new Set<number>();
    for (const m of manual) {
      if (manualIds.has(m.purchaseItemId)) {
        issues.push({
          code: "duplicate_manual_line",
          message: `Manual allocation for item ${m.purchaseItemId} appears more than once.`,
          field: "manualAllocations",
        });
      }
      manualIds.add(m.purchaseItemId);
      if (Number(m.amount) < 0) {
        issues.push({
          code: "negative_manual_amount",
          message: "Manual allocation amounts must be non-negative.",
          field: "manualAllocations",
        });
      }
      if (!receivedItems.has(m.purchaseItemId)) {
        issues.push({
          code: "unknown_manual_line",
          message: `Manual allocation references purchase item ${m.purchaseItemId} which has no received batches.`,
          field: "manualAllocations",
        });
      }
    }
    if (receivedItems.size > 0 && manualIds.size !== receivedItems.size) {
      issues.push({
        code: "incomplete_manual_allocation",
        message: "Every received line needs a manual allocation amount.",
        field: "manualAllocations",
      });
    }
    const manualTotal = manual.reduce(
      (sum, m) => sum + BigInt(Math.round(Number(m.amount) * 10_000)),
      0n,
    );
    if (manualTotal !== totalQuads) {
      issues.push({
        code: "manual_mismatch",
        message: "Manual allocations must sum exactly to the capitalizable total.",
        field: "manualAllocations",
      });
    }
  }

  if (issues.length > 0) throw new LandedCostValidationError(issues);

  // ---- line-level targets (Part F: complete-order target, received share) ----
  // Over-received lines (accepted > ordered, migration 0052) can produce a
  // received share above the line's total target — clamp so they simply
  // allocate the full target with nothing left pending.
  const clampReceivedTarget = (received: bigint, total: bigint): bigint =>
    received > total ? total : received;
  const orderedMillisOf = (line: AllocationLineInput) =>
    quantityToMillis(
      line.quantityOrdered ??
        line.batches.reduce((sum, b) => sum + Number(b.quantityReceived), 0),
    );
  const receivedMillisOf = (line: AllocationLineInput) =>
    line.batches.reduce(
      (sum, b) => sum + quantityToMillis(b.quantityReceived),
      0n,
    );

  let lineTargets: {
    line: AllocationLineInput;
    totalTargetQuads: bigint;
    receivedTargetQuads: bigint;
  }[];
  if (method === "manual") {
    // Manual amounts are user-defined per line for the whole document; the
    // received portion scales by quantity like every other method. Lines
    // without a manual entry (ordered but unreceived) hold their share as
    // pending allocation.
    const manualLines = options.manualLines ?? [];
    lineTargets = lines.flatMap((line) => {
      const manualEntry = manualLines.find(
        (m) => m.purchaseItemId === line.purchaseItemId,
      );
      if (!manualEntry) return [];
      const totalTargetQuads = amountToMicros(manualEntry.amount) / 100n;
      const orderedMillis = orderedMillisOf(line);
      const receivedMillis = receivedMillisOf(line);
      return [
        {
          line,
          totalTargetQuads,
          receivedTargetQuads: clampReceivedTarget(
            orderedMillis > 0n
              ? (totalTargetQuads * receivedMillis) / orderedMillis
              : totalTargetQuads,
            totalTargetQuads,
          ),
        },
      ];
    });
  } else if (method === "equal") {
    // "Equal across eligible lines": every received line shares the total
    // equally (line count = basis), then the received portion scales by
    // quantity like every other method. No weights needed — a line with
    // no received batches simply holds its share as pending.
    lineTargets = lines.map((line) => {
      const totalTargetQuads = totalQuads / BigInt(lines.length);
      const orderedMillis = orderedMillisOf(line);
      const receivedMillis = receivedMillisOf(line);
      return {
        line,
        totalTargetQuads,
        receivedTargetQuads: clampReceivedTarget(
          orderedMillis > 0n
            ? (totalTargetQuads * receivedMillis) / orderedMillis
            : totalTargetQuads,
          totalTargetQuads,
        ),
      };
    });
    // The equal split loses at most (n−1) quads of the total; hand the
    // remainder to the FIRST line so Σ targets === total exactly.
    const distributed = lineTargets.reduce(
      (sum, target) => sum + target.totalTargetQuads,
      0n,
    );
    const residual = totalQuads - distributed;
    if (residual !== 0n && lineTargets.length > 0) {
      lineTargets[0]!.totalTargetQuads += residual;
      lineTargets[0]!.receivedTargetQuads += residual;
    }
  } else {
    // Basis scale is per-method (only relative size matters within one
    // call): quantity millis, line net value micros, kg quads × qty.
    const orderedBasisOf = (line: AllocationLineInput): bigint => {
      if (method === "quantity") return orderedMillisOf(line);
      const costCents = BigInt(Math.round(Number(line.unitCost) * 100));
      const discountCents = BigInt(Math.round(Number(line.discount) * 100));
      if (method === "value")
        return lineNetValueMicros(orderedMillisOf(line), costCents, discountCents);
      return (
        (resolveWeightQuads(line)! * orderedMillisOf(line)) / 1000n
      );
    };
    const receivedBasisOf = (line: AllocationLineInput): bigint => {
      if (method === "quantity") return receivedMillisOf(line);
      const costCents = BigInt(Math.round(Number(line.unitCost) * 100));
      const discountCents = BigInt(Math.round(Number(line.discount) * 100));
      if (method === "value")
        return line.batches.reduce(
          (sum, b) =>
            sum +
            lineNetValueMicros(
              quantityToMillis(b.quantityReceived),
              costCents,
              discountCents,
            ),
          0n,
        );
      return line.batches.reduce(
        (sum, b) =>
          sum +
          (resolveWeightQuads(line)! * quantityToMillis(b.quantityReceived)) /
            1000n,
        0n,
      );
    };
    const basisItems = lines.map((line) => ({
      key: String(line.purchaseItemId),
      basisMicros: orderedBasisOf(line),
    }));
    const targets = allocateByBasis(totalQuads, basisItems);
    lineTargets = lines.map((line) => {
      const totalTargetQuads = targets.get(String(line.purchaseItemId))!;
      const orderedBasis = orderedBasisOf(line);
      return {
        line,
        totalTargetQuads,
        receivedTargetQuads: clampReceivedTarget(
          orderedBasis > 0n
            ? (totalTargetQuads * receivedBasisOf(line)) / orderedBasis
            : totalTargetQuads,
          totalTargetQuads,
        ),
      };
    });
  }

  // ---- distribute each line's target across its batches (by batch qty) ----
  const result: AllocationLineResult[] = [];
  let allocatedTotalQuads = 0n;
  let docReceivedTargetQuads = 0n;
  for (const { line, totalTargetQuads, receivedTargetQuads } of lineTargets) {
    const batchBasis = line.batches.map((batch) => ({
      key: String(batch.batchId),
      basisMicros: quantityToMillis(batch.quantityReceived),
    }));
    const batchShares = allocateByBasis(receivedTargetQuads, batchBasis);

    const batches: AllocationBatchResult[] = line.batches.map((batch) => {
      const allocatedQuads = batchShares.get(String(batch.batchId))!;
      const qtyMillis = quantityToMillis(batch.quantityReceived);
      // Informational per-unit at 6 dp; the authoritative figure is the
      // batch's allocated amount on the numeric(14,4) grid.
      const perUnitMicros =
        qtyMillis > 0n ? (allocatedQuads * 100_000n) / qtyMillis : 0n;
      const weightSnapshot =
        method === "weight"
          ? Number((resolveWeightQuads(line)! * qtyMillis) / 1000n) / 10_000
          : null;
      const basisMicros = batchBasis.find(
        (b) => b.key === String(batch.batchId),
      )!.basisMicros;
      // Display basis in the method's natural unit (qty / currency / kg).
      const basisValue =
        method === "quantity"
          ? Number(basisMicros) / 1000
          : Number(basisMicros) / 1_000_000;
      return {
        batchId: batch.batchId,
        batchNumber: batch.batchNumber,
        quantitySnapshot: Number(batch.quantityReceived),
        basisValue,
        allocatedAmount: Number(allocatedQuads) / 10_000,
        allocatedPerUnit: microsToPerUnit(perUnitMicros),
        weightSnapshot,
      };
    });

    const lineAllocatedQuads = line.batches.reduce(
      (sum, b) => sum + batchShares.get(String(b.batchId))!,
      0n,
    );
    allocatedTotalQuads += lineAllocatedQuads;
    docReceivedTargetQuads += receivedTargetQuads;
    const orderedQty = Number(
      line.quantityOrdered ?? line.batches.reduce(
        (sum, b) => sum + Number(b.quantityReceived),
        0,
      ),
    );
    result.push({
      purchaseItemId: line.purchaseItemId,
      variantId: line.variantId,
      batches,
      lineAllocatedAmount: Number(lineAllocatedQuads) / 10_000,
      lineTotalTargetAmount: Number(totalTargetQuads) / 10_000,
      lineReceivedTargetAmount: Number(receivedTargetQuads) / 10_000,
      orderedQuantity: orderedQty,
      receivedQuantity: Number(receivedMillisOf(line)) / 1000,
    });
  }

  return {
    lines: result,
    allocatedTotal: Number(allocatedTotalQuads) / 10_000,
    pendingTotal: Number(totalQuads - docReceivedTargetQuads) / 10_000,
  };
}
