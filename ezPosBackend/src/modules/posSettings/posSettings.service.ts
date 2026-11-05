import { eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { posSettings } from "../../db/schema/posSettings.js";

export interface PosSettingsView {
  requireTerminal: boolean;
  allowMultipleDrawerSessions: boolean;
}

const DEFAULTS: PosSettingsView = {
  requireTerminal: false,
  allowMultipleDrawerSessions: false,
};

/**
 * Per-business POS policy. The row is created on demand; an absent row
 * reads as all-defaults so nothing has to be seeded.
 */
export async function getPosSettings(
  businessId: number,
): Promise<PosSettingsView> {
  const [row] = await db
    .select({
      requireTerminal: posSettings.requireTerminal,
      allowMultipleDrawerSessions: posSettings.allowMultipleDrawerSessions,
    })
    .from(posSettings)
    .where(eq(posSettings.businessId, businessId))
    .limit(1);
  return row ?? { ...DEFAULTS };
}

export async function updatePosSettings(
  businessId: number,
  patch: {
    requireTerminal?: boolean | undefined;
    allowMultipleDrawerSessions?: boolean | undefined;
  },
): Promise<PosSettingsView> {
  const current = await getPosSettings(businessId);
  const [row] = await db
    .insert(posSettings)
    .values({
      businessId,
      requireTerminal: patch.requireTerminal ?? current.requireTerminal,
      allowMultipleDrawerSessions:
        patch.allowMultipleDrawerSessions ?? current.allowMultipleDrawerSessions,
    })
    .onConflictDoUpdate({
      target: posSettings.businessId,
      set: {
        ...(patch.requireTerminal !== undefined
          ? { requireTerminal: patch.requireTerminal }
          : {}),
        ...(patch.allowMultipleDrawerSessions !== undefined
          ? { allowMultipleDrawerSessions: patch.allowMultipleDrawerSessions }
          : {}),
        updatedAt: new Date(),
      },
    })
    .returning({
      requireTerminal: posSettings.requireTerminal,
      allowMultipleDrawerSessions: posSettings.allowMultipleDrawerSessions,
    });
  if (!row) {
    throw new Error("POS settings update returned no row.");
  }
  return row;
}

export async function getAllowMultipleDrawerSessions(
  businessId: number,
): Promise<boolean> {
  const [row] = await db
    .select({
      allowMultiple: posSettings.allowMultipleDrawerSessions,
    })
    .from(posSettings)
    .where(eq(posSettings.businessId, businessId))
    .limit(1);
  return row?.allowMultiple ?? false;
}
