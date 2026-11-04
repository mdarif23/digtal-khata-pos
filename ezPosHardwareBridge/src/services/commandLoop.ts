import type {
  AckStatus,
  BridgeCommand,
  BridgeConfig,
  DrawerAdapter,
  TerminalCredentials,
} from "../types.js";
import { DrawerKickError } from "../types.js";
import {
  ackCommand,
  claimCommands,
  AuthError,
} from "./bridgeClient.js";
import { createDrawerAdapter } from "../adapters/index.js";

/**
 * The command loop: claim → validate → execute → acknowledge.
 *
 * Safety rules (master prompt §10.3):
 * - Each claimed command is acknowledged through the one-way backend state
 *   machine; the bridge NEVER re-executes a command whose outcome is
 *   uncertain — an ambiguous kick is acked `unknown_outcome` and left to
 *   the human to verify.
 * - Adapter failures before any bytes leave the machine ack `failed`
 *   (retryable by the cashier, explicitly); failures after a write may
 *   have reached the printer ack `unknown_outcome`.
 * - Auth failures stop the loop (rotated/deleted terminal) — no retry
 *   hammering.
 */

export interface LoopHooks {
  log?: (message: string) => void;
  onError?: (message: string) => void;
}

/**
 * Executes one claim/execute/ack cycle. Returns the number of commands
 * handled. `adapterFactory` is a test seam — real deployments use the
 * configured-printer factory, automated tests inject scripted mock
 * adapters (master prompt §17: hardware tests run on mock adapters).
 */
export async function runOnce(
  config: BridgeConfig,
  credentials: TerminalCredentials,
  hooks: LoopHooks = {},
  adapterFactory: (printer: BridgeConfig["printers"][number]) => DrawerAdapter = createDrawerAdapter,
): Promise<number> {
  const commands = await claimCommands(config.backendUrl, credentials);
  for (const command of commands) {
    await executeCommand(config, credentials, command, hooks, adapterFactory);
  }
  return commands.length;
}

export async function executeCommand(
  config: BridgeConfig,
  credentials: TerminalCredentials,
  command: BridgeCommand,
  hooks: LoopHooks = {},
  adapterFactory: (printer: BridgeConfig["printers"][number]) => DrawerAdapter = createDrawerAdapter,
): Promise<void> {
  const log = hooks.log ?? (() => undefined);
  const onError = hooks.onError ?? log;
  const ack = async (status: AckStatus, detail?: Record<string, unknown>) => {
    try {
      await ackCommand(
        config.backendUrl,
        credentials,
        command.id,
        status,
        detail,
      );
    } catch (error) {
      // A failed ack leaves the backend to sweep the command to
      // unknown_outcome — the safe default. Log and continue.
      onError(
        `Command #${command.id}: ack ${status} failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  if (command.type !== "drawer_open") {
    await ack("failed", { reason: `unsupported command type ${command.type}` });
    return;
  }
  await ack("validated");

  const adapter: DrawerAdapter | null = pickAdapter(config, adapterFactory);
  if (adapter === null) {
    await ack("failed", { reason: "no printer configured on this bridge" });
    return;
  }

  await ack("executing");
  try {
    const result = await adapter.kick();
    // Bytes were handed to the printer/spooler — report completed with the
    // honest caveat that no drawer-open sensor confirms the physics.
    await ack("completed", result.detail);
    log(`Command #${command.id}: drawer kick delivered via ${String(result.detail.adapter)}.`);
  } catch (error) {
    if (error instanceof DrawerKickError && !error.bytesSent) {
      // Nothing left this machine — a plain, retryable failure.
      await ack("failed", { adapter: adapter.printer.kind, error: error.message });
      onError(`Command #${command.id}: ${error.message}`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await ack("unknown_outcome", { adapter: adapter.printer.kind, error: message });
    onError(`Command #${command.id}: ${message} — outcome reported as unknown.`);
  } finally {
    adapter.dispose();
  }
}

/** First configured printer wins (a drawer is one physical device). */
function pickAdapter(
  config: BridgeConfig,
  factory: (printer: BridgeConfig["printers"][number]) => DrawerAdapter,
): DrawerAdapter | null {
  const printer = config.printers[0];
  if (!printer) return null;
  try {
    return factory(printer);
  } catch (error) {
    // Config/adapter construction errors are reported per-command; the
    // loop stays alive so a fix takes effect without a bridge restart.
    return {
      printer,
      kick: async () => {
        // Construction failed before anything could be sent — retryable.
        throw new DrawerKickError(
          error instanceof Error ? error.message : String(error),
          false,
        );
      },
      dispose: () => undefined,
    };
  }
}

export interface RunLoopOptions {
  hooks?: LoopHooks;
  /** Maximum backoff between failed cycles (ms). */
  maxBackoffMs?: number;
  /** Injected clock/sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Stop predicate checked every cycle. */
  shouldStop?: () => boolean;
}

/**
 * Long-running loop with exponential backoff on network errors.
 * Auth failures throw immediately — the process should exit and the
 * operator should re-pair or check the terminal's status.
 */
export async function runLoop(
  config: BridgeConfig,
  credentials: TerminalCredentials,
  options: RunLoopOptions = {},
): Promise<void> {
  const log = options.hooks?.log ?? (() => undefined);
  const onError = options.hooks?.onError ?? log;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  let backoff = config.pollIntervalMs;

  while (options.shouldStop?.() !== true) {
    try {
      const handled = await runOnce(config, credentials, options.hooks ?? {});
      backoff = config.pollIntervalMs;
      if (handled > 0) {
        log(`Handled ${handled} command(s).`);
      }
    } catch (error) {
      if (error instanceof AuthError) {
        onError(
          "The backend rejected this terminal (rotated, deactivated, or deleted). " +
            "Re-pair the bridge or check the terminal in ezPos → Hardware.",
        );
        throw error;
      }
      onError(
        `Claim cycle failed — ${error instanceof Error ? error.message : String(error)}; retrying in ${Math.round(backoff / 1000)}s.`,
      );
      await sleep(backoff);
      backoff = Math.min(backoff * 2, maxBackoffMs);
      continue;
    }
    await sleep(config.pollIntervalMs);
  }
}
