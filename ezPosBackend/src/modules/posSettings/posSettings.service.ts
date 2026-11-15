import { eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  posSettings,
  type ApprovalRequiredConfig,
} from "../../db/schema/posSettings.js";

export interface EmbeddedBarcodeConfig {
  prefixes: string[];
  pluLength: number;
  valueLength: number;
  decimals: number;
  mode: "weight" | "price";
  hasCheckDigit: boolean;
}

export interface PosSettingsView {
  requireTerminal: boolean;
  allowMultipleDrawerSessions: boolean;
  /** Phase 1: reject cash sales without an open register session. */
  requireOpenDrawer: boolean;
  /** Phase 1: which sensitive ops demand a manager approval token. */
  approvalRequired: ApprovalRequiredConfig;
  /** Phase 4 (Feature 10-B): embedded barcode parse config (null = default). */
  embeddedBarcode: EmbeddedBarcodeConfig | null;
  /**
   * P3 Phase 1 (F4): months until newly granted store credit expires
   * (null = no expiry — every existing business keeps today's behavior).
   */
  storeCreditExpiryMonths: number | null;
  /** P3 Phase 2: expired-batch selling policy ('block' | 'allow_with_approval'). */
  expiredBatchPolicy: "block" | "allow_with_approval";
  /** P3 Phase 2: near-expiry notification window in days. */
  expiryWarningDays: number;
}

const DEFAULTS: PosSettingsView = {
  requireTerminal: false,
  allowMultipleDrawerSessions: false,
  requireOpenDrawer: false,
  approvalRequired: {},
  embeddedBarcode: null,
  storeCreditExpiryMonths: null,
  expiredBatchPolicy: "block",
  expiryWarningDays: 7,
};

function sanitizeEmbeddedConfig(
  value: unknown,
): EmbeddedBarcodeConfig | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.prefixes) || source.prefixes.length === 0) return null;
  const prefixes = (source.prefixes as unknown[]).filter(
    (p): p is string => typeof p === "string" && /^\d{1,3}$/.test(p),
  );
  const pluLength = typeof source.pluLength === "number" ? source.pluLength : 0;
  const valueLength =
    typeof source.valueLength === "number" ? source.valueLength : 0;
  const decimals = typeof source.decimals === "number" ? source.decimals : 0;
  const mode = source.mode === "price" ? "price" : "weight";
  if (
    prefixes.length === 0 ||
    pluLength <= 0 ||
    valueLength <= 0 ||
    decimals < 0 ||
    decimals > 6
  ) {
    return null;
  }
  return {
    prefixes,
    pluLength,
    valueLength,
    decimals,
    mode,
    hasCheckDigit: source.hasCheckDigit === true,
  };
}

const APPROVAL_KEYS = [
  "sale_refund",
  "sale_cancel",
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
      embeddedBarcode: posSettings.embeddedBarcode,
      storeCreditExpiryMonths: posSettings.storeCreditExpiryMonths,
      expiredBatchPolicy: posSettings.expiredBatchPolicy,
      expiryWarningDays: posSettings.expiryWarningDays,
    })
    .from(posSettings)
    .where(eq(posSettings.businessId, businessId))
    .limit(1);
  return row
    ? {
        ...row,
        approvalRequired: sanitizeApprovalConfig(row.approvalRequired),
        embeddedBarcode: sanitizeEmbeddedConfig(row.embeddedBarcode),
        storeCreditExpiryMonths: row.storeCreditExpiryMonths ?? null,
        expiredBatchPolicy: row.expiredBatchPolicy,
        expiryWarningDays: row.expiryWarningDays ?? 7,
      }
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
    embeddedBarcode?: Record<string, unknown> | null | undefined;
    /** P3 Phase 1 (F4): null clears the policy (no expiry). */
    storeCreditExpiryMonths?: number | null | undefined;
    /** P3 Phase 2: expired-batch selling policy. */
    expiredBatchPolicy?: "block" | "allow_with_approval" | undefined;
    /** P3 Phase 2: near-expiry notification window in days (1-365). */
    expiryWarningDays?: number | undefined;
  },
): Promise<PosSettingsView> {
  const current = await getPosSettings(businessId);
  const approvalRequired = patch.approvalRequired
    ? { ...current.approvalRequired, ...sanitizeApprovalConfig(patch.approvalRequired) }
    : current.approvalRequired;
  const embeddedBarcode =
    patch.embeddedBarcode !== undefined
      ? sanitizeEmbeddedConfig(patch.embeddedBarcode)
      : current.embeddedBarcode;
  const [row] = await db
    .insert(posSettings)
    .values({
      businessId,
      requireTerminal: patch.requireTerminal ?? current.requireTerminal,
      allowMultipleDrawerSessions:
        patch.allowMultipleDrawerSessions ?? current.allowMultipleDrawerSessions,
      requireOpenDrawer: patch.requireOpenDrawer ?? current.requireOpenDrawer,
      approvalRequired,
      ...(patch.embeddedBarcode !== undefined
        ? {
            embeddedBarcode: sanitizeEmbeddedConfig(
              patch.embeddedBarcode,
            ) as unknown as {
              prefixes: string[];
              pluLength: number;
              valueLength: number;
              decimals: number;
              mode: "weight" | "price";
              hasCheckDigit: boolean;
            } | null,
          }
        : {}),
      ...(patch.storeCreditExpiryMonths !== undefined
        ? { storeCreditExpiryMonths: patch.storeCreditExpiryMonths }
        : {}),
      ...(patch.expiredBatchPolicy !== undefined
        ? { expiredBatchPolicy: patch.expiredBatchPolicy }
        : {}),
      ...(patch.expiryWarningDays !== undefined
        ? { expiryWarningDays: patch.expiryWarningDays }
        : {}),
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
        ...(patch.embeddedBarcode !== undefined
          ? { embeddedBarcode: sanitizeEmbeddedConfig(patch.embeddedBarcode) }
          : {}),
        ...(patch.storeCreditExpiryMonths !== undefined
          ? { storeCreditExpiryMonths: patch.storeCreditExpiryMonths }
          : {}),
        ...(patch.expiredBatchPolicy !== undefined
          ? { expiredBatchPolicy: patch.expiredBatchPolicy }
          : {}),
        ...(patch.expiryWarningDays !== undefined
          ? { expiryWarningDays: patch.expiryWarningDays }
          : {}),
        updatedAt: new Date(),
      },
    })
    .returning({
      requireTerminal: posSettings.requireTerminal,
      allowMultipleDrawerSessions: posSettings.allowMultipleDrawerSessions,
      requireOpenDrawer: posSettings.requireOpenDrawer,
      approvalRequired: posSettings.approvalRequired,
      embeddedBarcode: posSettings.embeddedBarcode,
      storeCreditExpiryMonths: posSettings.storeCreditExpiryMonths,
      expiredBatchPolicy: posSettings.expiredBatchPolicy,
      expiryWarningDays: posSettings.expiryWarningDays,
    });
  if (!row) {
    throw new Error("POS settings update returned no row.");
  }
  return {
    ...row,
    approvalRequired: sanitizeApprovalConfig(row.approvalRequired),
    embeddedBarcode: sanitizeEmbeddedConfig(row.embeddedBarcode),
    storeCreditExpiryMonths: row.storeCreditExpiryMonths ?? null,
    expiredBatchPolicy: row.expiredBatchPolicy,
    expiryWarningDays: row.expiryWarningDays ?? 7,
  };
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

/** P3 Phase 1 (F4): months until granted store credit expires; null = never. */
export async function getStoreCreditExpiryMonths(
  businessId: number,
): Promise<number | null> {
  const [row] = await db
    .select({ months: posSettings.storeCreditExpiryMonths })
    .from(posSettings)
    .where(eq(posSettings.businessId, businessId))
    .limit(1);
  return row?.months ?? null;
}

/** P3 Phase 2 (D7): expired-batch selling policy ('block' | 'allow_with_approval'). */
export async function getExpiredBatchPolicy(
  businessId: number,
): Promise<"block" | "allow_with_approval"> {
  const [row] = await db
    .select({ policy: posSettings.expiredBatchPolicy })
    .from(posSettings)
    .where(eq(posSettings.businessId, businessId))
    .limit(1);
  return row?.policy ?? "block";
}

/** P3 Phase 2 (F.5): near-expiry notification window in days (default 7). */
export async function getExpiryWarningDays(
  businessId: number,
): Promise<number> {
  const [row] = await db
    .select({ days: posSettings.expiryWarningDays })
    .from(posSettings)
    .where(eq(posSettings.businessId, businessId))
    .limit(1);
  return row?.days ?? 7;
}
