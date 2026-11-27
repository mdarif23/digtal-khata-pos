import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  hardwareCommands,
  posTerminals,
  terminalPairingCodes,
} from "../../db/schema/posTerminals.js";
import { recordAudit } from "../../services/audit.js";
import { publishRealtime } from "../realtime/realtime.service.js";
import { locations } from "../../db/schema/locations.js";
import { sales } from "../../db/schema/sales.js";
import { registerSessions } from "../../db/schema/registers.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import {
  generateTerminalSecret,
  hashTerminalSecret,
} from "../../middleware/terminalAuth.js";

/** Ten minutes to type a code into the bridge — then it is dead. */
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** Unambiguous alphabet (no I/L/1/O/0) for human-typed pairing codes. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generatePairingCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return code;
}

export interface TerminalView {
  id: number;
  name: string;
  status: string;
  locationId: number;
  paired: boolean;
  deviceInfo: unknown;
  lastSeenAt: Date | null;
  pairedAt: Date | null;
  createdAt: Date | null;
}

function toView(row: typeof posTerminals.$inferSelect): TerminalView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    locationId: row.locationId,
    paired: row.secretHash !== null,
    deviceInfo: row.deviceInfo,
    lastSeenAt: row.lastSeenAt,
    pairedAt: row.pairedAt,
    createdAt: row.createdAt,
  };
}

/** Terminals at the caller's (server-verified) location. */
export async function listTerminals(
  businessId: number,
  locationId: number,
): Promise<TerminalView[]> {
  const rows = await db
    .select()
    .from(posTerminals)
    .where(
      and(
        eq(posTerminals.businessId, businessId),
        eq(posTerminals.locationId, locationId),
      ),
    )
    .orderBy(desc(posTerminals.id));
  return rows.map(toView);
}

export async function getTerminal(
  businessId: number,
  terminalId: number,
): Promise<TerminalView> {
  const [row] = await db
    .select()
    .from(posTerminals)
    .where(
      and(
        eq(posTerminals.id, terminalId),
        eq(posTerminals.businessId, businessId),
      ),
    );
  if (!row) {
    // Foreign terminal vs missing one are indistinguishable on purpose.
    throw new NotFoundError("Terminal not found.");
  }
  return toView(row);
}

export async function updateTerminal(
  businessId: number,
  terminalId: number,
  input: {
    name?: string;
    status?: "active" | "inactive";
    locationId?: number;
  },
  actorUserId: number | null,
): Promise<TerminalView> {
  const [existing] = await db
    .select()
    .from(posTerminals)
    .where(
      and(
        eq(posTerminals.id, terminalId),
        eq(posTerminals.businessId, businessId),
      ),
    );
  if (!existing) {
    throw new NotFoundError("Terminal not found.");
  }
  let targetLocationId = existing.locationId;
  if (input.locationId !== undefined && input.locationId !== existing.locationId) {
    // The terminal moves to another counter of the same business. Sales and
    // sessions already written keep their original attribution — history
    // records where things happened, not where the PC is now.
    const [location] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(
        and(eq(locations.id, input.locationId), eq(locations.businessId, businessId)),
      )
      .limit(1);
    if (!location) {
      throw new NotFoundError("Location not found.");
    }
    targetLocationId = input.locationId;
  }
  const targetName = input.name ?? existing.name;
  // (location_id, name) is unique among terminals — keep the friendly 409
  // the DB constraint would otherwise turn into a 500.
  const [clash] = await db
    .select({ id: posTerminals.id })
    .from(posTerminals)
    .where(
      and(
        eq(posTerminals.locationId, targetLocationId),
        eq(posTerminals.name, targetName),
      ),
    )
    .limit(1);
  if (clash && clash.id !== terminalId) {
    throw new ConflictError(
      "Another terminal at that location already uses this name.",
    );
  }
  const [updated] = await db
    .update(posTerminals)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(posTerminals.id, terminalId))
    .returning();
  if (!updated) {
    throw new Error("Terminal update returned no row.");
  }
  recordAudit({
    businessId,
    actorUserId,
    action: "pos_terminal.updated",
    entityType: "pos_terminal",
    entityId: terminalId,
    metadata: {
      name: input.name,
      status: input.status,
      locationId: input.locationId,
    },
  });
  publishRealtime(businessId, updated.locationId, {
    kind: "terminal.changed",
    locationId: updated.locationId,
  });
  return toView(updated);
}

/**
 * Revoking a terminal deletes its identity. Command history is audit
 * evidence — a terminal that has executed commands cannot be deleted;
 * deactivate it instead.
 */
export async function deleteTerminal(
  businessId: number,
  terminalId: number,
  actorUserId: number | null,
): Promise<{ id: number }> {
  const [existing] = await db
    .select({
      id: posTerminals.id,
      secretHash: posTerminals.secretHash,
      locationId: posTerminals.locationId,
    })
    .from(posTerminals)
    .where(
      and(
        eq(posTerminals.id, terminalId),
        eq(posTerminals.businessId, businessId),
      ),
    );
  if (!existing) {
    throw new NotFoundError("Terminal not found.");
  }
  const [command] = await db
    .select({ id: hardwareCommands.id })
    .from(hardwareCommands)
    .where(eq(hardwareCommands.terminalId, terminalId))
    .limit(1);
  if (command) {
    throw new ConflictError(
      "This terminal has command history. Deactivate it instead of deleting.",
    );
  }
  // Transaction history is audit evidence too: a terminal that rang sales
  // or held a drawer session cannot be deleted — deactivate it instead.
  const [attribution] = await db
    .select({ id: sales.id })
    .from(sales)
    .where(eq(sales.terminalId, terminalId))
    .limit(1);
  if (attribution) {
    throw new ConflictError(
      "This terminal has recorded sales. Deactivate it instead of deleting.",
    );
  }
  const [sessionRef] = await db
    .select({ id: registerSessions.id })
    .from(registerSessions)
    .where(eq(registerSessions.terminalId, terminalId))
    .limit(1);
  if (sessionRef) {
    throw new ConflictError(
      "This terminal has register session history. Deactivate it instead of deleting.",
    );
  }
  const [deleted] = await db
    .delete(posTerminals)
    .where(eq(posTerminals.id, terminalId))
    .returning({ id: posTerminals.id });
  if (!deleted) {
    throw new Error("Terminal delete returned no row.");
  }
  recordAudit({
    businessId,
    actorUserId,
    action: "pos_terminal.deleted",
    entityType: "pos_terminal",
    entityId: terminalId,
    metadata: { wasPaired: existing.secretHash !== null },
  });
  publishRealtime(businessId, existing.locationId, {
    kind: "terminal.changed",
    locationId: existing.locationId,
  });
  return deleted;
}

export interface PairingCodeIssue {
  code: string;
  expiresAt: Date;
  /** Set when the code targets a pre-created terminal (attach mode). */
  terminalId?: number;
}

/**
 * Registers a terminal by name — no hardware, no bridge. This is the
 * offline-selling path: a business that records sales offline needs a
 * terminal record for attribution, but receipt printing (browser/OS) and a
 * hand-opened drawer never needed the bridge. The bridge attaches later via
 * a per-terminal pairing code when drawer hardware actually exists.
 */
export async function createTerminal(
  businessId: number,
  locationId: number,
  rawName: string,
  userId: number | null,
): Promise<TerminalView> {
  const baseName = rawName.trim().slice(0, 100);
  if (baseName === "") {
    throw new BadRequestError("A terminal name is required.");
  }
  // Location-scoped name uniqueness: suffix until free (same convention as
  // the pairing-created terminal).
  let name = baseName;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const [clash] = await db
      .select({ id: posTerminals.id })
      .from(posTerminals)
      .where(
        and(eq(posTerminals.locationId, locationId), eq(posTerminals.name, name)),
      );
    if (!clash) break;
    name = `${baseName} (${attempt + 1})`.slice(0, 100);
  }
  const [row] = await db
    .insert(posTerminals)
    .values({
      businessId,
      locationId,
      name,
      createdBy: userId,
      // secretHash/pairedAt stay null — unpaired until a bridge attaches.
    })
    .returning();
  if (!row) {
    throw new Error("Terminal insert returned no row.");
  }
  recordAudit({
    businessId,
    actorUserId: userId,
    action: "pos_terminal.created",
    entityType: "pos_terminal",
    entityId: row.id,
    metadata: { name, via: "direct_create", hardwareless: true },
  });
  publishRealtime(businessId, locationId, {
    kind: "terminal.changed",
    locationId,
  });
  return toView(row);
}

/** A pos_terminal.manage holder mints a one-time code for their location. */
export async function mintPairingCode(
  businessId: number,
  locationId: number,
  userId: number,
  terminalId?: number,
): Promise<PairingCodeIssue> {
  if (terminalId !== undefined) {
    // Attach mode: the code targets a pre-created terminal. It must belong
    // to this business + location — a code can never reach across either.
    const [terminal] = await db
      .select({ id: posTerminals.id })
      .from(posTerminals)
      .where(
        and(
          eq(posTerminals.id, terminalId),
          eq(posTerminals.businessId, businessId),
          eq(posTerminals.locationId, locationId),
        ),
      );
    if (!terminal) {
      throw new NotFoundError("Terminal not found at this location.");
    }
  }
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
  await db.insert(terminalPairingCodes).values({
    businessId,
    locationId,
    ...(terminalId !== undefined ? { terminalId } : {}),
    codeHash: hashTerminalSecret(code),
    createdBy: userId,
    expiresAt,
  });
  return {
    code,
    expiresAt,
    ...(terminalId !== undefined ? { terminalId } : {}),
  };
}

export interface PairingResult {
  terminalId: number;
  terminalName: string;
  locationId: number;
  /** The bridge secret — returned exactly once, at pairing time. */
  secret: string;
}

/**
 * Bridge-side pairing exchange: a valid, unused, unexpired code is claimed
 * atomically (single-use), the terminal is created, and the secret is
 * returned once. The code creator (a verified pos_terminal.manage holder)
 * is recorded as the terminal's creator — the bridge itself holds no
 * authority beyond the code.
 */
export async function pairTerminal(
  code: string,
  deviceName: string | null,
  deviceInfo: unknown,
): Promise<PairingResult> {
  const normalized = code.trim().toUpperCase();
  if (normalized.length !== 8) {
    throw new BadRequestError("Invalid pairing code.");
  }
  const secret = generateTerminalSecret();
  const result = await db.transaction(async (tx) => {
    const [codeRow] = await tx
      .select({
        id: terminalPairingCodes.id,
        businessId: terminalPairingCodes.businessId,
        locationId: terminalPairingCodes.locationId,
        terminalId: terminalPairingCodes.terminalId,
        createdBy: terminalPairingCodes.createdBy,
        expiresAt: terminalPairingCodes.expiresAt,
        usedAt: terminalPairingCodes.usedAt,
      })
      .from(terminalPairingCodes)
      .where(eq(terminalPairingCodes.codeHash, hashTerminalSecret(normalized)));
    if (!codeRow) {
      throw new BadRequestError("Invalid pairing code.");
    }
    if (codeRow.usedAt !== null || codeRow.expiresAt.getTime() <= Date.now()) {
      throw new ConflictError(
        "This pairing code has already been used or has expired. Mint a new one.",
      );
    }
    // Atomic single-use claim: concurrent redemptions race on this update.
    const claimed = await tx
      .update(terminalPairingCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(terminalPairingCodes.id, codeRow.id),
          isNull(terminalPairingCodes.usedAt),
        ),
      );
    if (claimed.rowCount !== 1) {
      throw new ConflictError(
        "This pairing code has already been used. Mint a new one.",
      );
    }

    // Attach mode (migration 0094): the code was minted FOR a pre-created
    // terminal — the bridge binds to it instead of creating a duplicate.
    // Re-pairing an already-paired terminal is allowed (a lost bridge
    // reinstalls): the new secret replaces the old immediately.
    if (codeRow.terminalId !== null) {
      const [attached] = await tx
        .update(posTerminals)
        .set({
          secretHash: hashTerminalSecret(secret),
          pairedAt: new Date(),
          deviceInfo: deviceInfo ?? null,
          status: "active",
        })
        .where(
          and(
            eq(posTerminals.id, codeRow.terminalId),
            eq(posTerminals.businessId, codeRow.businessId),
            eq(posTerminals.locationId, codeRow.locationId),
          ),
        )
        .returning({ id: posTerminals.id, name: posTerminals.name });
      if (!attached) {
        throw new NotFoundError(
          "The terminal this code targets no longer exists at this location.",
        );
      }
      return {
        businessId: codeRow.businessId,
        locationId: codeRow.locationId,
        terminal: attached,
        attachedToExisting: true,
        createdBy: codeRow.createdBy,
      };
    }

    const businessId = codeRow.businessId;
    const baseName =
      typeof deviceName === "string" && deviceName.trim() !== ""
        ? deviceName.trim().slice(0, 100)
        : "POS Terminal";
    // Location-scoped name uniqueness: suffix until free.
    let name = baseName;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const [clash] = await tx
        .select({ id: posTerminals.id })
        .from(posTerminals)
        .where(
          and(
            eq(posTerminals.locationId, codeRow.locationId),
            eq(posTerminals.name, name),
          ),
        );
      if (!clash) break;
      name = `${baseName} (${attempt + 1})`.slice(0, 100);
    }

    const [terminal] = await tx
      .insert(posTerminals)
      .values({
        businessId,
        locationId: codeRow.locationId,
        name,
        secretHash: hashTerminalSecret(secret),
        pairedAt: new Date(),
        createdBy: codeRow.createdBy,
        deviceInfo: deviceInfo ?? null,
      })
      .returning({ id: posTerminals.id, name: posTerminals.name });
    if (!terminal) {
      throw new Error("Terminal insert returned no row.");
    }
    return {
      businessId,
      locationId: codeRow.locationId,
      terminal,
      attachedToExisting: false,
      createdBy: codeRow.createdBy,
    };
  });
  recordAudit({
    businessId: result.businessId,
    actorUserId: result.createdBy ?? null,
    action: "pos_terminal.paired",
    entityType: "pos_terminal",
    entityId: result.terminal.id,
    metadata: {
      name: result.terminal.name,
      via: "pairing_code",
      ...(result.attachedToExisting
        ? { attachedToExisting: true, rePaired: true }
        : {}),
    },
  });
  publishRealtime(result.businessId, result.locationId, {
    kind: "terminal.changed",
    locationId: result.locationId,
  });
  return {
    terminalId: result.terminal.id,
    terminalName: result.terminal.name,
    locationId: result.locationId,
    secret,
  };
}

/**
 * Regenerates the bridge secret for a PAIRED terminal. The old secret dies
 * immediately (hash replaced) — a lost bridge must re-pair.
 */
export async function rotateTerminalSecret(
  businessId: number,
  terminalId: number,
  actorUserId: number | null,
): Promise<{ terminalId: number; secret: string }> {
  const [existing] = await db
    .select({ id: posTerminals.id, secretHash: posTerminals.secretHash })
    .from(posTerminals)
    .where(
      and(
        eq(posTerminals.id, terminalId),
        eq(posTerminals.businessId, businessId),
      ),
    );
  if (!existing) {
    throw new NotFoundError("Terminal not found.");
  }
  if (existing.secretHash === null) {
    throw new BadRequestError("Pair the terminal before rotating its secret.");
  }
  const secret = generateTerminalSecret();
  await db
    .update(posTerminals)
    .set({ secretHash: hashTerminalSecret(secret), updatedAt: new Date() })
    .where(eq(posTerminals.id, terminalId));
  recordAudit({
    businessId,
    actorUserId,
    action: "pos_terminal.secret_rotated",
    entityType: "pos_terminal",
    entityId: terminalId,
    metadata: {},
  });
  return { terminalId, secret };
}

export interface HardwareCommandView {
  id: number;
  terminalId: number;
  type: string;
  status: string;
  requestedBy: number | null;
  saleId: number | null;
  reason: string | null;
  note: string | null;
  result: unknown;
  expiresAt: Date;
  claimedAt: Date | null;
  settledAt: Date | null;
  createdAt: Date | null;
}

export async function listTerminalCommands(
  businessId: number,
  terminalId: number,
  limit = 50,
): Promise<HardwareCommandView[]> {
  await getTerminal(businessId, terminalId); // 404-mask foreign terminals
  const rows = await db
    .select()
    .from(hardwareCommands)
    .where(eq(hardwareCommands.terminalId, terminalId))
    .orderBy(desc(hardwareCommands.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(toCommandView);
}

export function toCommandView(
  row: typeof hardwareCommands.$inferSelect,
): HardwareCommandView {
  return {
    id: row.id,
    terminalId: row.terminalId,
    type: row.type,
    status: row.status,
    requestedBy: row.requestedBy,
    saleId: row.saleId,
    reason: row.reason,
    note: row.note,
    result: row.result,
    expiresAt: row.expiresAt,
    claimedAt: row.claimedAt,
    settledAt: row.settledAt,
    createdAt: row.createdAt,
  };
}
