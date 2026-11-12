import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { bomComponents } from "../../db/schema/bom.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";

/**
 * Composite products / Bill of Materials (Phase 4 — master prompt Feature 9).
 *
 * Two assembly modes, both traceable:
 *  - ASSEMBLE-ON-SALE (default): a sale of a composite variant deducts the
 *    COMPONENT quantities through the standard FIFO machinery — the
 *    composite itself holds no stock. Refunds restock the components via
 *    the persisted batch consumptions.
 *  - PRODUCTION RUNS: pre-assembly consumes components and creates finished
 *    composite stock (batch with summed component cost).
 *
 * Circular references are rejected at write time (DFS through the BOM graph)
 * and chains are depth-capped at evaluation time as a second guard.
 */

export const BOM_MAX_DEPTH = 10;

export interface BomComponent {
  id: number;
  componentVariantId: number;
  componentName: string;
  componentSku: string | null;
  quantity: number;
  wastePercent: number;
}

export interface BomDefinition {
  parentVariantId: number;
  components: BomComponent[];
}

/** Loads the BOM for one variant (empty when the variant is not composite). */
export async function getBom(
  businessId: number,
  parentVariantId: number,
): Promise<BomDefinition> {
  const rows = await db
    .select({
      id: bomComponents.id,
      componentVariantId: bomComponents.componentVariantId,
      quantity: bomComponents.quantity,
      wastePercent: bomComponents.wastePercent,
      componentName: products.name,
      componentSku: productVariants.sku,
    })
    .from(bomComponents)
    .innerJoin(
      productVariants,
      eq(productVariants.id, bomComponents.componentVariantId),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(bomComponents.businessId, businessId),
        eq(bomComponents.parentVariantId, parentVariantId),
      ),
    )
    .orderBy(bomComponents.id);
  return {
    parentVariantId,
    components: rows.map((row) => ({
      id: row.id,
      componentVariantId: row.componentVariantId,
      componentName: row.componentName,
      componentSku: row.componentSku,
      quantity: Number(row.quantity),
      wastePercent: Number(row.wastePercent),
    })),
  };
}

/** BOMs for MANY variants in one query (sale-time pre-pass). */
export async function getBomsForVariants(
  businessId: number,
  variantIds: number[],
): Promise<Map<number, BomDefinition["components"]>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db
    .select({
      parentVariantId: bomComponents.parentVariantId,
      id: bomComponents.id,
      componentVariantId: bomComponents.componentVariantId,
      quantity: bomComponents.quantity,
      wastePercent: bomComponents.wastePercent,
      componentName: products.name,
    })
    .from(bomComponents)
    .innerJoin(
      productVariants,
      eq(productVariants.id, bomComponents.componentVariantId),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(bomComponents.businessId, businessId),
        inArray(bomComponents.parentVariantId, variantIds),
      ),
    )
    .orderBy(bomComponents.id);
  const byParent = new Map<number, BomDefinition["components"]>();
  for (const row of rows) {
    const list = byParent.get(row.parentVariantId) ?? [];
    list.push({
      id: row.id,
      componentVariantId: row.componentVariantId,
      componentName: row.componentName,
      componentSku: null,
      quantity: Number(row.quantity),
      wastePercent: Number(row.wastePercent),
    });
    byParent.set(row.parentVariantId, list);
  }
  return byParent;
}

/**
 * Replaces a variant's BOM. Circular references are rejected with a DFS
 * through the EXISTING graph (after simulating the replacement), and a
 * component may not be the parent itself.
 */
export async function setBom(
  businessId: number,
  parentVariantId: number,
  input: {
    components: {
      componentVariantId: number;
      quantity: number;
      wastePercent?: number | undefined;
    }[];
  },
): Promise<BomDefinition> {
  if (input.components.length === 0) {
    // Empty list clears the BOM (variant stops being composite).
    await db
      .delete(bomComponents)
      .where(
        and(
          eq(bomComponents.businessId, businessId),
          eq(bomComponents.parentVariantId, parentVariantId),
        ),
      );
    return { parentVariantId, components: [] };
  }
  const componentIds = input.components.map((c) => c.componentVariantId);
  if (new Set(componentIds).size !== componentIds.length) {
    throw new BadRequestError(
      "The same component appears more than once — combine the quantities.",
    );
  }
  for (const component of input.components) {
    if (component.componentVariantId === parentVariantId) {
      throw new BadRequestError("A product cannot be a component of itself.");
    }
    if (component.quantity <= 0) {
      throw new BadRequestError("Component quantities must be positive.");
    }
    const waste = component.wastePercent ?? 0;
    if (waste < 0 || waste > 100) {
      throw new BadRequestError("Waste percent must be between 0 and 100.");
    }
  }
  // Components must exist in the business.
  const existing = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.businessId, businessId),
        inArray(productVariants.id, componentIds),
      ),
    );
  const existingIds = new Set(existing.map((row) => row.id));
  for (const id of componentIds) {
    if (!existingIds.has(id)) {
      throw new BadRequestError(`Component variant ${id} was not found.`);
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(bomComponents)
      .where(
        and(
          eq(bomComponents.businessId, businessId),
          eq(bomComponents.parentVariantId, parentVariantId),
        ),
      );
    await tx.insert(bomComponents).values(
      input.components.map((component) => ({
        businessId,
        parentVariantId,
        componentVariantId: component.componentVariantId,
        quantity: component.quantity,
        wastePercent: component.wastePercent ?? 0,
      })),
    );
    // Circular guard AFTER the write (inside the tx — rolls back on cycle).
    await assertAcyclic(tx, businessId, parentVariantId);
  });

  return getBom(businessId, parentVariantId);
}

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** DFS cycle check from the parent through the current bom_components rows. */
async function assertAcyclic(
  tx: TxLike,
  businessId: number,
  parentVariantId: number,
): Promise<void> {
  const edges = await tx
    .select({
      parent: bomComponents.parentVariantId,
      component: bomComponents.componentVariantId,
    })
    .from(bomComponents)
    .where(eq(bomComponents.businessId, businessId));
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.parent) ?? [];
    list.push(edge.component);
    adjacency.set(edge.parent, list);
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();

  function dfs(node: number, depth: number): void {
    if (visiting.has(node)) {
      throw new ConflictError(
        "Circular BOM detected — a product cannot depend on itself through its components.",
      );
    }
    if (visited.has(node) || depth > BOM_MAX_DEPTH) return;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      dfs(next, depth + 1);
    }
    visiting.delete(node);
    visited.add(node);
  }

  dfs(parentVariantId, 0);
}

/** Estimated component cost for one composite unit (for the editor UI). */
export async function computeBomUnitCost(
  businessId: number,
  parentVariantId: number,
): Promise<number> {
  const bom = await getBom(businessId, parentVariantId);
  if (bom.components.length === 0) return 0;
  // Cost basis: the component's latest batch purchase price (valuation
  // continuity with FIFO consumption).
  const { inventoryBatches } = await import("../../db/schema/inventoryBatches.js");
  const rows = await db
    .select({
      variantId: inventoryBatches.variantId,
      purchasePrice: inventoryBatches.purchasePrice,
      batchId: inventoryBatches.id,
    })
    .from(inventoryBatches)
    .where(
      and(
        eq(inventoryBatches.businessId, businessId),
        inArray(
          inventoryBatches.variantId,
          bom.components.map((c) => c.componentVariantId),
        ),
        sql`${inventoryBatches.quantityRemaining} > 0`,
      ),
    )
    .orderBy(inventoryBatches.id);
  const priceById = new Map<number, number>();
  for (const row of rows) {
    if (row.variantId === null) continue;
    // Later batches win (last write per variant id in the map).
    priceById.set(row.variantId, Number(row.purchasePrice ?? 0));
  }
  let total = 0;
  for (const component of bom.components) {
    const unitCost = priceById.get(component.componentVariantId) ?? 0;
    total += unitCost * component.quantity * (1 + component.wastePercent / 100);
  }
  return roundMoney(total);
}

/** Flattens a BOM to leaf components (resolves nested composites). */
export async function flattenBom(
  businessId: number,
  parentVariantId: number,
  quantity: number,
): Promise<{ componentVariantId: number; quantity: number }[]> {
  const bom = await getBom(businessId, parentVariantId);
  if (bom.components.length === 0) {
    throw new NotFoundError(`Variant ${parentVariantId} has no BOM.`);
  }
  const out = new Map<number, number>();
  const queue: { variantId: number; qty: number; depth: number }[] = [
    { variantId: parentVariantId, qty: quantity, depth: 0 },
  ];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.depth > BOM_MAX_DEPTH) {
      throw new ConflictError("BOM nesting exceeds the depth cap.");
    }
    const definition = node.variantId === parentVariantId
      ? bom
      : await getBom(businessId, node.variantId);
    if (definition.components.length === 0) {
      out.set(
        node.variantId,
        (out.get(node.variantId) ?? 0) + node.qty,
      );
      continue;
    }
    for (const component of definition.components) {
      const needed = node.qty * component.quantity * (1 + component.wastePercent / 100);
      queue.push({
        variantId: component.componentVariantId,
        qty: needed,
        depth: node.depth + 1,
      });
    }
  }
  return [...out.entries()].map(([componentVariantId, qty]) => ({
    componentVariantId,
    quantity: roundMoney(qty),
  }));
}
