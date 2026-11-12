import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { managerApprovals, managerPins } from "../db/schema/managerApproval.js";
import {
  posSettings,
  type ApprovalRequiredConfig,
} from "../db/schema/posSettings.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../utils/handleError.js";

/**
 * Manager PIN approvals (Phase 1 — master prompt F12-D).
 *
 * Every sensitive operation may demand an approval bound to the EXACT
 * operation: the approving manager verifies THEIR OWN pin (per-user, argon2,
 * lockout after repeated failures) and receives a one-time, expiring token.
 * The operation endpoint consumes that token inside its transaction —
 * replay, expiry, wrong-op and payload-drift are all rejected.
 *
 * The approver must themselves hold the operation's underlying permission —
 * a PIN proves identity, the permission check proves authority.
 */

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;
export const MAX_PIN_FAILURES = 5;
export const PIN_LOCKOUT_MINUTES = 15;
export const APPROVAL_TTL_MINUTES = 10;

/** Operations that can demand a manager approval, with their authority. */
export const APPROVAL_OPS = {
  "register.reopen": { permission: "cash_register.manage" },
  "sale.refund": { permission: "sales.return" },
  "cash_movement": { permission: "cash_movement.create" },
  "pricing.below_minimum": { permission: "pricing.below_minimum_override" },
} as const;

export type ManagerOpType = keyof typeof APPROVAL_OPS;

export function isManagerOpType(value: string): value is ManagerOpType {
  return Object.prototype.hasOwnProperty.call(APPROVAL_OPS, value);
}

/** Ops that are approval-gated for every business (not configurable). */
export function isApprovalAlwaysRequired(op: ManagerOpType): boolean {
  return op === "register.reopen";
}

const PIN_PATTERN = new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`);
const TOKEN_PATTERN = /^[0-9a-f]{48}$/;

/** Stable JSON (sorted keys, recursive) so payload hashes are deterministic. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export async function setManagerPin(
  businessId: number,
  userId: number,
  pin: string,
): Promise<void> {
  if (!PIN_PATTERN.test(pin)) {
    throw new BadRequestError(
      `PIN must be ${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} digits.`,
    );
  }
  const pinHash = await hashPassword(pin);
  await db
    .insert(managerPins)
    .values({ businessId, userId, pinHash })
    .onConflictDoUpdate({
      target: [managerPins.businessId, managerPins.userId],
      set: {
        pinHash,
        // A successful set clears any lockout/counter — the user proved the
        // account by logging in and chose a new secret.
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      },
    });
}

export async function deleteManagerPin(
  businessId: number,
  userId: number,
): Promise<void> {
  await db
    .delete(managerPins)
    .where(
      and(eq(managerPins.businessId, businessId), eq(managerPins.userId, userId)),
    );
}

export async function hasManagerPin(
  businessId: number,
  userId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: managerPins.id })
    .from(managerPins)
    .where(and(eq(managerPins.businessId, businessId), eq(managerPins.userId, userId)))
    .limit(1);
  return row !== undefined;
}

export interface MintApprovalInput {
  pin: string;
  opType: ManagerOpType;
  entityType?: string | undefined;
  entityId?: number | undefined;
  /** Semantic payload the approval is bound to (hashed, compared on consume). */
  payload?: Record<string, unknown> | undefined;
  reason?: string | undefined;
  /** Whether the verifying user holds the op's underlying permission. */
  hasRequiredPermission: boolean;
}

export interface MintedApproval {
  token: string;
  expiresAt: Date;
}

/**
 * Verify the caller's pin and mint a one-time approval token. Throws
 * ForbiddenError on a wrong pin (and locks the account after repeated
 * failures) — never reveals whether the account exists.
 */
export async function verifyPinAndMintApproval(
  businessId: number,
  approverUserId: number,
  input: MintApprovalInput,
): Promise<MintedApproval> {
  if (!isManagerOpType(input.opType)) {
    throw new BadRequestError(`Unknown approval operation: ${input.opType}`);
  }
  if (!PIN_PATTERN.test(input.pin)) {
    throw new BadRequestError(
      `PIN must be ${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} digits.`,
    );
  }
  if (!input.hasRequiredPermission) {
    throw new ForbiddenError(
      "You do not have permission to approve this operation.",
    );
  }

  const [pinRow] = await db
    .select()
    .from(managerPins)
    .where(
      and(eq(managerPins.businessId, businessId), eq(managerPins.userId, approverUserId)),
    )
    .limit(1);
  if (!pinRow) {
    throw new NotFoundError(
      "No manager PIN is set for your account. Set one before approving operations.",
    );
  }
  if (pinRow.lockedUntil && pinRow.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.max(
      1,
      Math.ceil((pinRow.lockedUntil.getTime() - Date.now()) / 60_000),
    );
    throw new ConflictError(
      `Too many incorrect PIN attempts. Try again in ${minutes} minute(s).`,
    );
  }

  const pinOk = await verifyPassword(pinRow.pinHash, input.pin);
  if (!pinOk) {
    const attempts = pinRow.failedAttempts + 1;
    const lock = attempts >= MAX_PIN_FAILURES
      ? new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60_000)
      : null;
    await db
      .update(managerPins)
      .set({
        failedAttempts: lock ? 0 : attempts,
        lockedUntil: lock,
        updatedAt: new Date(),
      })
      .where(eq(managerPins.id, pinRow.id));
    throw new ForbiddenError(
      lock
        ? `Incorrect PIN. Account locked for ${PIN_LOCKOUT_MINUTES} minutes.`
        : "Incorrect PIN.",
    );
  }

  // Success: clear the failure counter.
  if (pinRow.failedAttempts !== 0 || pinRow.lockedUntil) {
    await db
      .update(managerPins)
      .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(managerPins.id, pinRow.id));
  }

  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MINUTES * 60_000);
  await db.insert(managerApprovals).values({
    businessId,
    approverUserId,
    opType: input.opType,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    payloadHash:
      input.payload !== undefined ? sha256(canonicalJson(input.payload)) : null,
    reason: input.reason ?? null,
    tokenHash: sha256(token),
    expiresAt,
  });
  return { token, expiresAt };
}

export interface ConsumeApprovalInput {
  token: string;
  opType: ManagerOpType;
  entityType?: string | undefined;
  entityId?: number | undefined;
  /** Must hash-match the payload the token was minted for (either side set). */
  payload?: Record<string, unknown> | undefined;
}

export interface ConsumedApproval {
  approverUserId: number;
  opType: ManagerOpType;
  reason: string | null;
}

/**
 * Consume a one-time approval token INSIDE the operation's transaction —
 * the consumed_at write commits or rolls back together with the operation it
 * authorizes, so a rolled-back refund does not burn the approval.
 */
export async function consumeApprovalInTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  businessId: number,
  input: ConsumeApprovalInput,
): Promise<ConsumedApproval> {
  if (!TOKEN_PATTERN.test(input.token)) {
    throw new ForbiddenError("Invalid approval token.");
  }
  const [approval] = await tx
    .select()
    .from(managerApprovals)
    .where(
      and(
        eq(managerApprovals.businessId, businessId),
        eq(managerApprovals.tokenHash, sha256(input.token)),
      ),
    )
    .for("update");
  if (!approval) {
    throw new ForbiddenError("Invalid approval token.");
  }
  if (approval.consumedAt) {
    throw new ConflictError("This approval was already used.");
  }
  if (approval.expiresAt.getTime() <= Date.now()) {
    throw new ConflictError("Approval expired — ask the manager to approve again.");
  }
  if (approval.opType !== input.opType) {
    throw new ForbiddenError("This approval is for a different operation.");
  }
  if (
    approval.entityType !== null &&
    input.entityType !== undefined &&
    approval.entityType !== input.entityType
  ) {
    throw new ForbiddenError("This approval is for a different record.");
  }
  if (
    approval.entityId !== null &&
    input.entityId !== undefined &&
    approval.entityId !== input.entityId
  ) {
    throw new ForbiddenError("This approval is for a different record.");
  }
  const inputHash =
    input.payload !== undefined ? sha256(canonicalJson(input.payload)) : null;
  if (approval.payloadHash !== inputHash) {
    throw new ForbiddenError(
      "This approval was minted for different operation details.",
    );
  }

  await tx
    .update(managerApprovals)
    .set({ consumedAt: new Date() })
    .where(eq(managerApprovals.id, approval.id));
  return {
    approverUserId: approval.approverUserId,
    opType: approval.opType,
    reason: approval.reason,
  };
}

/** Op type → pos_settings.approval_required key (reopen is not configurable). */
const CONFIG_KEY_BY_OP: Record<
  Exclude<ManagerOpType, "register.reopen">,
  keyof ApprovalRequiredConfig
> = {
  "sale.refund": "sale_refund",
  "cash_movement": "cash_movement",
  "pricing.below_minimum": "below_minimum_price",
};

/**
 * Whether the business requires an approval token for this op today.
 * register.reopen is always required; the rest read pos_settings.
 */
export async function isApprovalRequired(
  businessId: number,
  opType: ManagerOpType,
): Promise<boolean> {
  if (isApprovalAlwaysRequired(opType)) return true;
  const [row] = await db
    .select({ approvalRequired: posSettings.approvalRequired })
    .from(posSettings)
    .where(eq(posSettings.businessId, businessId))
    .limit(1);
  const configKey = CONFIG_KEY_BY_OP[opType as Exclude<ManagerOpType, "register.reopen">];
  return row?.approvalRequired?.[configKey] === true;
}
