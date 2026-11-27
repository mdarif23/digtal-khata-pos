import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  pricingPromotions,
  promotionCampaigns,
} from "../../db/schema/pricing.js";
import {
  BadRequestError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAudit } from "../../services/audit.js";
import { getBusinessTimezone } from "../../services/ledger.js";
import { businessLocalToUtcWall } from "../../utils/money.js";
import { campaignUpdateSchema } from "./campaigns.validation.js";

/**
 * Promotional campaigns CRUD (Bundle & Combo Phase 4). Campaigns organize
 * promotions into seasonal groups: the engine gates attached promotions on
 * the campaign's active flag, date window and location, and breaks priority
 * ties with the campaign's priority. Deleting a campaign SET NULLs its
 * promotions' campaign_id — the promotions survive, unorganized.
 */

type CampaignRow = typeof promotionCampaigns.$inferSelect;

async function resolveDateBound(
  businessId: number,
  value: Date | string | null | undefined,
  boundary: "start" | "end",
): Promise<Date | null | undefined> {
  if (value == null || value instanceof Date) return value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(value);
  const tz = await getBusinessTimezone(db, businessId);
  const wall = businessLocalToUtcWall(
    value,
    boundary === "start" ? "00:00:00" : "23:59:59.999",
    tz,
  );
  return new Date(`${wall.replace(" ", "T")}Z`);
}

export async function listCampaigns(businessId: number) {
  const rows = await db
    .select()
    .from(promotionCampaigns)
    .where(eq(promotionCampaigns.businessId, businessId))
    .orderBy(asc(promotionCampaigns.id));
  if (rows.length === 0) return [];
  const counts = await db
    .select({
      campaignId: pricingPromotions.campaignId,
      total: sql<string>`COUNT(*)`,
    })
    .from(pricingPromotions)
    .where(eq(pricingPromotions.businessId, businessId))
    .groupBy(pricingPromotions.campaignId);
  const countByCampaign = new Map<number, number>();
  for (const row of counts) {
    if (row.campaignId != null) countByCampaign.set(row.campaignId, Number(row.total));
  }
  return rows.map((row) => ({
    ...row,
    promotionCount: countByCampaign.get(row.id) ?? 0,
  }));
}

export async function getCampaign(businessId: number, campaignId: number) {
  const [row] = await db
    .select()
    .from(promotionCampaigns)
    .where(
      and(
        eq(promotionCampaigns.id, campaignId),
        eq(promotionCampaigns.businessId, businessId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Campaign not found.");
  const [countRow] = await db
    .select({ total: sql<string>`COUNT(*)` })
    .from(pricingPromotions)
    .where(
      and(
        eq(pricingPromotions.businessId, businessId),
        eq(pricingPromotions.campaignId, campaignId),
      ),
    );
  return { ...row, promotionCount: Number(countRow?.total ?? 0) };
}

export async function createCampaign(
  businessId: number,
  actorUserId: number | null,
  payload: {
    name: string;
    description?: string | null | undefined;
    startsAt?: Date | string | null | undefined;
    endsAt?: Date | string | null | undefined;
    priority?: number | undefined;
    locationId?: number | null | undefined;
    isActive?: boolean | undefined;
  },
) {
  const [created] = await db
    .insert(promotionCampaigns)
    .values({
      businessId,
      name: payload.name,
      description: payload.description ?? null,
      startsAt: (await resolveDateBound(businessId, payload.startsAt, "start")) ?? null,
      endsAt: (await resolveDateBound(businessId, payload.endsAt, "end")) ?? null,
      priority: (payload.priority as number | undefined) ?? 0,
      locationId: (payload.locationId as number | null | undefined) ?? null,
      isActive: payload.isActive ?? true,
    })
    .returning();
  if (!created) throw new Error("Campaign insert returned no row.");
  recordAudit({
    businessId,
    actorUserId,
    action: "pricing.campaign.create",
    entityType: "promotion_campaign",
    entityId: created.id,
    metadata: { name: created.name, isActive: created.isActive },
  });
  return created;
}

export async function updateCampaign(
  businessId: number,
  actorUserId: number | null,
  campaignId: number,
  payload: Record<string, unknown>,
) {
  const [existing] = await db
    .select()
    .from(promotionCampaigns)
    .where(
      and(
        eq(promotionCampaigns.id, campaignId),
        eq(promotionCampaigns.businessId, businessId),
      ),
    )
    .limit(1);
  if (!existing) throw new NotFoundError("Campaign not found.");
  const merged = {
    name: (payload.name as string | undefined) ?? existing.name,
    description:
      payload.description !== undefined
        ? (payload.description as string | null)
        : existing.description,
    startsAt:
      payload.startsAt !== undefined
        ? ((await resolveDateBound(businessId, payload.startsAt as Date | string | null, "start")) ?? null)
        : existing.startsAt,
    endsAt:
      payload.endsAt !== undefined
        ? ((await resolveDateBound(businessId, payload.endsAt as Date | string | null, "end")) ?? null)
        : existing.endsAt,
    priority: (payload.priority as number | undefined) ?? existing.priority,
    locationId:
      payload.locationId !== undefined
        ? (payload.locationId as number | null)
        : existing.locationId,
    isActive: (payload.isActive as boolean | undefined) ?? existing.isActive,
  };
  const parsed = campaignUpdateSchema.safeParse(merged);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid campaign update: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const [updated] = await db
    .update(promotionCampaigns)
    .set({
      name: merged.name,
      description: merged.description,
      startsAt: merged.startsAt,
      endsAt: merged.endsAt,
      priority: merged.priority,
      locationId: merged.locationId,
      isActive: merged.isActive,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(promotionCampaigns.id, campaignId),
        eq(promotionCampaigns.businessId, businessId),
      ),
    )
    .returning();
  if (!updated) throw new Error("Campaign update returned no row.");
  recordAudit({
    businessId,
    actorUserId,
    action: "pricing.campaign.update",
    entityType: "promotion_campaign",
    entityId: campaignId,
    metadata: { name: updated.name, isActive: updated.isActive },
  });
  return updated;
}

export async function deleteCampaign(businessId: number, campaignId: number) {
  // Attached promotions survive with campaign_id NULL (plain FK SET NULL);
  // their sale_items.price_adjustments snapshots are untouched by design.
  const [deleted] = await db
    .delete(promotionCampaigns)
    .where(
      and(
        eq(promotionCampaigns.id, campaignId),
        eq(promotionCampaigns.businessId, businessId),
      ),
    )
    .returning();
  if (!deleted) throw new NotFoundError("Campaign not found.");
  recordAudit({
    businessId,
    actorUserId: null,
    action: "pricing.campaign.delete",
    entityType: "promotion_campaign",
    entityId: campaignId,
    metadata: { name: deleted.name },
  });
  return deleted;
}

export type { CampaignRow };
