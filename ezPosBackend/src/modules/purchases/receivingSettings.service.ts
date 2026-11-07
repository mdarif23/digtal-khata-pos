import { eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { purchaseReceivingSettings } from "../../db/schema/purchaseReceivingSettings.js";

/**
 * Per-business receiving configuration (migration 0052). Absent row =
 * defaults: over-receiving tolerance 0% — every over-receive requires the
 * `purchases.over_receive` permission.
 */
export async function getReceivingSettings(businessId: number): Promise<{
  overReceiveTolerancePercent: number;
}> {
  const [row] = await db
    .select({
      overReceiveTolerancePercent:
        purchaseReceivingSettings.overReceiveTolerancePercent,
    })
    .from(purchaseReceivingSettings)
    .where(eq(purchaseReceivingSettings.businessId, businessId))
    .limit(1);

  return {
    overReceiveTolerancePercent: Number(row?.overReceiveTolerancePercent ?? 0),
  };
}

export async function updateReceivingSettings(
  businessId: number,
  input: { overReceiveTolerancePercent: number },
): Promise<{ overReceiveTolerancePercent: number }> {
  const [row] = await db
    .insert(purchaseReceivingSettings)
    .values({
      businessId,
      overReceiveTolerancePercent: input.overReceiveTolerancePercent,
    })
    .onConflictDoUpdate({
      target: purchaseReceivingSettings.businessId,
      set: {
        overReceiveTolerancePercent: input.overReceiveTolerancePercent,
        updatedAt: new Date(),
      },
    })
    .returning({
      overReceiveTolerancePercent:
        purchaseReceivingSettings.overReceiveTolerancePercent,
    });

  return {
    overReceiveTolerancePercent: Number(row!.overReceiveTolerancePercent),
  };
}
