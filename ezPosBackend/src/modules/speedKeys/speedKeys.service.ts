import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  speedKeyLayouts,
  type SpeedKeyTile,
} from "../../db/schema/speedKeys.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { BadRequestError } from "../../utils/handleError.js";

/**
 * Speed keys (Phase 3 — master prompt Feature 2): configurable tile grids
 * that reference existing variants. The resolved layout for a caller is the
 * most specific one: user > register > business.
 */

const TILE_COLORS = new Set([
  "slate",
  "blue",
  "green",
  "amber",
  "red",
  "purple",
  "teal",
]);

export type ScopeType = "business" | "user" | "register";

export async function resolveLayout(
  businessId: number,
  userId: number,
  registerId: number | null,
): Promise<SpeedKeyTile[]> {
  const rows = await db
    .select()
    .from(speedKeyLayouts)
    .where(eq(speedKeyLayouts.businessId, businessId));
  const byKey = new Map(
    rows.map((row) => [`${row.scopeType}:${row.scopeId}`, row] as const),
  );
  const ordered = [
    byKey.get(`user:${userId}`),
    registerId !== null ? byKey.get(`register:${registerId}`) : undefined,
    byKey.get("business:0"),
  ];
  for (const row of ordered) {
    if (row) return (row.tiles ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return [];
}

async function validateTiles(businessId: number, tiles: SpeedKeyTile[]): Promise<void> {
  if (!Array.isArray(tiles) || tiles.length > 60) {
    throw new BadRequestError("A layout holds at most 60 tiles.");
  }
  const ids = [...new Set(tiles.map((t) => t.variantId))];
  for (const tile of tiles) {
    if (!Number.isInteger(tile.variantId) || tile.variantId <= 0) {
      throw new BadRequestError("Every tile needs a valid variantId.");
    }
    if (typeof tile.label !== "string" || tile.label.trim().length === 0 || tile.label.length > 40) {
      throw new BadRequestError("Tile labels must be 1-40 characters.");
    }
    if (!TILE_COLORS.has(tile.color)) {
      throw new BadRequestError(`Unknown tile color: ${tile.color}.`);
    }
    if (!Number.isInteger(tile.sortOrder) || tile.sortOrder < 0) {
      throw new BadRequestError("Tile order must be a non-negative integer.");
    }
  }
  if (ids.length === 0) return; // empty layout clears the grid
  const existing = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.businessId, businessId),
        inArray(productVariants.id, ids),
      ),
    );
  const existingIds = new Set(existing.map((row) => row.id));
  for (const id of ids) {
    if (!existingIds.has(id)) {
      throw new BadRequestError(`Variant ${id} does not exist in this business.`);
    }
  }
}

export async function saveLayout(
  businessId: number,
  userId: number,
  scopeType: ScopeType,
  scopeId: number,
  tiles: SpeedKeyTile[],
): Promise<SpeedKeyTile[]> {
  validateTiles(businessId, tiles);
  const normalized = tiles
    .map((tile, idx) => ({ ...tile, sortOrder: tile.sortOrder ?? idx }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  await db
    .insert(speedKeyLayouts)
    .values({
      businessId,
      scopeType,
      scopeId,
      tiles: normalized,
      updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: [
        speedKeyLayouts.businessId,
        speedKeyLayouts.scopeType,
        speedKeyLayouts.scopeId,
      ],
      set: { tiles: normalized, updatedBy: userId, updatedAt: new Date() },
    });
  return normalized;
}
