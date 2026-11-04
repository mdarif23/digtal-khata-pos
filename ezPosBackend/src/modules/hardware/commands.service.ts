import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  hardwareCommands,
  posTerminals,
} from "../../db/schema/posTerminals.js";
import { sales } from "../../db/schema/sales.js";
import { recordAudit } from "../../services/audit.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import {
  toCommandView,
  type HardwareCommandView,
} from "./terminals.service.js";

type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Drawer kicks are immediate-need: unclaimed commands die fast. */
export const COMMAND_TTL_MS = 15_000;
const COMMAND_TTL_MIN_MS = 5_000;
const COMMAND_TTL_MAX_MS = 60_000;

/**
 * Bridge acks progress a command one way. `unknown_outcome` is a swept or
 * bridge-reported limbo that a later true outcome may still correct;
 * completed/failed/expired are immutable. No retry ever re-arms a drawer
 * kick — a new kick is a new explicit command.
 */
const ACK_TRANSITIONS: Record<string, string[]> = {
  received: ["validated", "executing", "completed", "failed", "unknown_outcome"],
  validated: ["executing", "completed", "failed", "unknown_outcome"],
  executing: ["completed", "failed", "unknown_outcome"],
  unknown_outcome: ["completed", "failed"],
};

export function canAck(from: string, to: string): boolean {
  return (ACK_TRANSITIONS[from] ?? []).includes(to);
}

async function assertExecutableTerminal(
  tx: Tx,
  businessId: number,
  terminalId: number,
): Promise<typeof posTerminals.$inferSelect> {
  const [terminal] = await tx
    .select()
    .from(posTerminals)
    .where(
      and(
        eq(posTerminals.id, terminalId),
        eq(posTerminals.businessId, businessId),
      ),
    )
    .for("update");
  if (!terminal) {
    throw new NotFoundError("Terminal not found.");
  }
  if (terminal.status !== "active") {
    throw new BadRequestError("This terminal is deactivated.");
  }
  if (terminal.secretHash === null) {
    throw new BadRequestError(
      "This terminal has not been paired with a hardware bridge yet.",
    );
  }
  return terminal;
}

export interface CreateCommandInput {
  businessId: number;
  requesterId: number | null;
  terminalId: number;
  locationId: number;
  type: "drawer_open";
  saleId?: number | null;
  reason?: string | null;
  ttlMs?: number;
}

/** Authors a targeted hardware command. */
export async function createCommand(
  input: CreateCommandInput,
): Promise<HardwareCommandView> {
  const ttl = Math.min(
    Math.max(input.ttlMs ?? COMMAND_TTL_MS, COMMAND_TTL_MIN_MS),
    COMMAND_TTL_MAX_MS,
  );
  const command = await db.transaction(async (tx) => {
    const terminal = await assertExecutableTerminal(
      tx,
      input.businessId,
      input.terminalId,
    );
    // A command must target a terminal in the caller's own location — the
    // drawer you kick is the drawer you are standing at.
    if (terminal.locationId !== input.locationId) {
      throw new NotFoundError("Terminal not found.");
    }

    let saleId: number | null = null;
    if (input.saleId !== undefined && input.saleId !== null) {
      const [sale] = await tx
        .select({ id: sales.id, locationId: sales.locationId })
        .from(sales)
        .where(
          and(eq(sales.id, input.saleId), eq(sales.businessId, input.businessId)),
        );
      if (!sale) {
        throw new NotFoundError("Sale not found.");
      }
      if (sale.locationId === null || sale.locationId !== terminal.locationId) {
        throw new BadRequestError(
          "The drawer command must target the sale's own location terminal.",
        );
      }
      saleId = sale.id;
    }

    const [row] = await tx
      .insert(hardwareCommands)
      .values({
        businessId: input.businessId,
        terminalId: input.terminalId,
        type: input.type,
        requestedBy: input.requesterId,
        saleId,
        reason: input.reason?.slice(0, 200) ?? null,
        expiresAt: new Date(Date.now() + ttl),
      })
      .returning();
    if (!row) {
      throw new Error("Hardware command insert returned no row.");
    }
    return row;
  });
  recordAudit({
    businessId: input.businessId,
    actorUserId: input.requesterId,
    action: "hardware.command_created",
    entityType: "hardware_command",
    entityId: command.id,
    metadata: {
      terminalId: input.terminalId,
      type: input.type,
      saleId: command.saleId,
    },
  });
  return toCommandView(command);
}

/**
 * Server-side sweep: unclaimed commands past their expiry die. Claimed
 * commands (received/validated) that were never settled fall to
 * unknown_outcome — we cannot know whether the drawer physically opened.
 */
export async function expireStaleCommands(terminalId: number): Promise<void> {
  const now = new Date();
  await db
    .update(hardwareCommands)
    .set({ status: "expired", settledAt: now })
    .where(
      and(
        eq(hardwareCommands.terminalId, terminalId),
        eq(hardwareCommands.status, "pending"),
        lt(hardwareCommands.expiresAt, now),
      ),
    );
  await db
    .update(hardwareCommands)
    .set({ status: "unknown_outcome" })
    .where(
      and(
        eq(hardwareCommands.terminalId, terminalId),
        inArray(hardwareCommands.status, ["received", "validated"]),
        lt(hardwareCommands.expiresAt, now),
      ),
    );
}

/**
 * The bridge claims its pending commands. Claims atomically move them to
 * `received` so a claim can never return the same command twice.
 */
export async function claimPendingCommands(
  terminalId: number,
  limit = 10,
): Promise<HardwareCommandView[]> {
  await expireStaleCommands(terminalId);
  const claimed = await db.transaction(async (tx) => {
    const pending = await tx
      .select({ id: hardwareCommands.id })
      .from(hardwareCommands)
      .where(
        and(
          eq(hardwareCommands.terminalId, terminalId),
          eq(hardwareCommands.status, "pending"),
        ),
      )
      .orderBy(hardwareCommands.id)
      .limit(Math.min(Math.max(limit, 1), 20))
      .for("update", { skipLocked: true });
    if (pending.length === 0) return [];
    const ids = pending.map((row) => row.id);
    const rows = await tx
      .update(hardwareCommands)
      .set({ status: "received", claimedAt: new Date() })
      .where(inArray(hardwareCommands.id, ids))
      .returning();
    return rows;
  });
  return claimed.map(toCommandView);
}

export interface AckInput {
  businessId: number;
  terminalId: number;
  commandId: number;
  status: "validated" | "executing" | "completed" | "failed" | "unknown_outcome";
  detail?: Record<string, unknown> | null;
}

/** Records a bridge ack, enforcing the one-way transition state machine. */
export async function ackCommand(input: AckInput): Promise<HardwareCommandView> {
  const settled = ["completed", "failed"] as const;
  const row = await db.transaction(async (tx) => {
    const [command] = await tx
      .select()
      .from(hardwareCommands)
      .where(
        and(
          eq(hardwareCommands.id, input.commandId),
          eq(hardwareCommands.businessId, input.businessId),
        ),
      )
      .for("update");
    if (!command || command.terminalId !== input.terminalId) {
      // Foreign command vs missing one are indistinguishable on purpose.
      throw new NotFoundError("Command not found.");
    }
    if (!canAck(command.status, input.status)) {
      throw new ConflictError(
        `A ${command.status} command cannot transition to ${input.status}.`,
      );
    }
    const [updated] = await tx
      .update(hardwareCommands)
      .set({
        status: input.status,
        result: input.detail ?? command.result,
        ...(settled.includes(input.status as (typeof settled)[number])
          ? { settledAt: new Date() }
          : {}),
      })
      .where(eq(hardwareCommands.id, command.id))
      .returning();
    if (!updated) {
      throw new Error("Hardware command ack returned no row.");
    }
    return updated;
  });
  if (settled.includes(input.status as (typeof settled)[number])) {
    recordAudit({
      businessId: input.businessId,
      actorUserId: null,
      action:
        input.status === "completed"
          ? "hardware.command_completed"
          : "hardware.command_failed",
      entityType: "hardware_command",
      entityId: row.id,
      metadata: { terminalId: input.terminalId, detail: input.detail ?? null },
    });
  }
  return toCommandView(row);
}

/** Command status for the POS UI (also sweeps expiry first). */
export async function getCommandStatus(
  businessId: number,
  commandId: number,
): Promise<HardwareCommandView> {
  const [terminalRow] = await db
    .select({ terminalId: hardwareCommands.terminalId })
    .from(hardwareCommands)
    .where(
      and(
        eq(hardwareCommands.id, commandId),
        eq(hardwareCommands.businessId, businessId),
      ),
    );
  if (!terminalRow) {
    throw new NotFoundError("Command not found.");
  }
  await expireStaleCommands(terminalRow.terminalId);
  const [row] = await db
    .select()
    .from(hardwareCommands)
    .where(eq(hardwareCommands.id, commandId));
  if (!row) {
    throw new NotFoundError("Command not found.");
  }
  return toCommandView(row);
}
