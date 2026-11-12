import { eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  posSettings,
  type ApprovalRequiredConfig,
} from "../../db/schema/posSettings.js";

export interface PosSettingsView {
  requireTerminal: boolean;
  allowMultipleDrawerSessions: boolean;
  /** Phase 1: reject cash sales without an open register session. */
  requireOpenDrawer: boolean;
  /** Phase 1: which sensitive ops demand a manager approval token. */
  approvalRequired: ApprovalRequiredConfig;
}

const DEFAULTS: PosSettingsView = {
  requireTerminal: false,
  allowMultipleDrawerSessions: false,
  requireOpenDrawer: false,
  approvalRequired: {},
};

const APPROVAL_KEYS = [
  "sale_refund",
  "cash_movement",
  "below_minimum_price",
] as const;

function sanitizeApprovalConfig(
  value: unknown,
): ApprovalRequiredConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const source = value as Record<string, unknown>;
  const out: ApprovalRequiredConfig = {};
  for (const key of APPROVAL_KEYS) {
    if (typeof source[key] === "boolean") {
      out[key] = source[key] as boolean;
    }
  }
  return out;
}

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
      requireOpenDrawer: posSettings.requireOpenDrawer,
      approvalRequired: posSettings.approvalRequired,
    })
    .from(posSettings)
    .where(eq(posSettings.businessId, businessId))
    .limit(1);
  return row
    ? { ...row, approvalRequired: sanitizeApprovalConfig(row.approvalRequired) }
    : { ...DEFAULTS };
}

export async function updatePosSettings(
  businessId: number,
  patch: {
    requireTerminal?: boolean | undefined;
    allowMultipleDrawerSessions?: boolean | undefined;
    requireOpenDrawer?: boolean | undefined;
    /** Raw client value — sanitized against the known keys before storing. */
    approvalRequired?: Record<string, unknown> | undefined;
  },
): Promise<PosSettingsView> {
  const current = await getPosSettings(businessId);
  const approvalRequired = patch.approvalRequired
    ? { ...current.approvalRequired, ...sanitizeApprovalConfig(patch.approvalRequired) }
    : current.approvalRequired;
  const [row] = await db
    .insert(posSettings)
    .values({
      businessId,
      requireTerminal: patch.requireTerminal ?? current.requireTerminal,
      allowMultipleDrawerSessions:
        patch.allowMultipleDrawerSessions ?? current.allowMultipleDrawerSessions,
      requireOpenDrawer: patch.requireOpenDrawer ?? current.requireOpenDrawer,
      approvalRequired,
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
        ...(patch.requireOpenDrawer !== undefined
          ? { requireOpenDrawer: patch.requireOpenDrawer }
          : {}),
        ...(patch.approvalRequired !== undefined
          ? { approvalRequired }
          : {}),
        updatedAt: new Date(),
      },
    })
    .returning({
      requireTerminal: posSettings.requireTerminal,
      allowMultipleDrawerSessions: posSettings.allowMultipleDrawerSessions,
      requireOpenDrawer: posSettings.requireOpenDrawer,
      approvalRequired: posSettings.approvalRequired,
    });
  if (!row) {
    throw new Error("POS settings update returned no row.");
  }
  return { ...row, approvalRequired: sanitizeApprovalConfig(row.approvalRequired) };
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

/** Phase 1 gate input: does this business demand an open drawer for cash sales? */
export async function getRequireOpenDrawer(
  businessId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ requireOpenDrawer: posSettings.requireOpenDrawer })
    .from(posSettings)
    .where(eq(posSettings.businessId, businessId))
    .limit(1);
  return row?.requireOpenDrawer ?? false;
}
