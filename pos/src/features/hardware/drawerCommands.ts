import {
  createDrawerCommandApi,
  getCommandStatusApi,
  getTerminalsApi,
  type HardwareCommand,
  type TerminalSummary,
} from "./terminals.api";
import { useHardwareStore } from "../../hardware/deviceManager";

/**
 * Drawer-open orchestration for the web POS.
 *
 * Priority order:
 * 1. A paired hardware-bridge terminal — the backend authors an audited
 *    command; the Windows bridge executes it physically. The sale is long
 *    committed before any of this runs; hardware failures never roll back.
 * 2. The WebUSB printer path (existing behavior) — Chrome-only, needs a
 *    user gesture per session.
 * 3. Nothing — the caller decides (toasts inform the cashier).
 *
 * The chosen terminal is remembered per browser ("this counter's drawer").
 * When the location has exactly one paired terminal it is used without
 * configuration; multi-terminal locations pick explicitly in settings.
 *
 * Note for the bridge phase: an HTTPS POS page fetching the LOCAL bridge
 * directly would hit Chrome's Local Network Access permission prompt —
 * this client deliberately talks only to the BACKEND, which relays to the
 * bridge over an outbound persistent channel (no LNA friction).
 */

const TERMINAL_PREF_KEY = "ezpos.drawerTerminalId";

const SETTLED = new Set(["completed", "failed", "expired", "unknown_outcome"]);

export function getPreferredTerminalId(): number | null {
  const raw = localStorage.getItem(TERMINAL_PREF_KEY);
  if (raw === null) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function setPreferredTerminalId(terminalId: number | null): void {
  if (terminalId === null) {
    localStorage.removeItem(TERMINAL_PREF_KEY);
  } else {
    localStorage.setItem(TERMINAL_PREF_KEY, String(terminalId));
  }
}

export interface DrawerOpenOutcome {
  opened: boolean;
  via: "terminal" | "usb" | "none";
  /** Status of the terminal command when one was authored. */
  commandStatus?: HardwareCommand["status"] | undefined;
  error?: string | undefined;
}

/** Fetches the location's paired, active terminals. */
export async function listPairedTerminals(): Promise<TerminalSummary[]> {
  try {
    const terminals = await getTerminalsApi();
    return terminals.filter((t) => t.paired && t.status === "active");
  } catch {
    return [];
  }
}

/**
 * Resolves the terminal to target: the remembered preference, else the
 * single paired terminal at this location, else none (ambiguous).
 */
export async function resolveDrawerTerminal(): Promise<TerminalSummary | null> {
  const terminals = await listPairedTerminals();
  if (terminals.length === 0) return null;
  const preferredId = getPreferredTerminalId();
  const preferred =
    preferredId !== null
      ? terminals.find((t) => t.id === preferredId)
      : undefined;
  if (preferred) return preferred;
  if (terminals.length === 1) return terminals[0]!;
  // Multiple terminals and no preference — do not guess which drawer.
  return null;
}

async function pollCommand(
  commandId: number,
  timeoutMs = 8_000,
): Promise<HardwareCommand> {
  const deadline = Date.now() + timeoutMs;
  let last: HardwareCommand | null = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    try {
      last = await getCommandStatusApi(commandId);
      if (SETTLED.has(last.status)) return last;
    } catch {
      // Status polling is best-effort; the backend ledger holds the truth.
    }
  }
  return (
    last ?? {
      id: commandId,
      status: "unknown_outcome",
    } as HardwareCommand
  );
}

/** Authors a drawer-open command and waits for the bridge's outcome. */
export async function openDrawerViaTerminal(
  terminalId: number,
  saleId?: number,
): Promise<DrawerOpenOutcome> {
  try {
    const command = await createDrawerCommandApi(terminalId, saleId);
    const settled = await pollCommand(command.id);
    return {
      opened: settled.status === "completed",
      via: "terminal",
      commandStatus: settled.status,
      error:
        settled.status === "completed"
          ? undefined
          : settled.status === "failed"
            ? "The bridge could not open the drawer."
            : settled.status === "expired"
              ? "No bridge claimed the drawer command in time."
              : "The drawer outcome is unknown — check the bridge.",
    };
  } catch (error) {
    return {
      opened: false,
      via: "terminal",
      error: error instanceof Error ? error.message : "Drawer command failed.",
    };
  }
}

/** The WebUSB path, unchanged — for counters without a bridge terminal. */
async function openDrawerViaUsb(): Promise<DrawerOpenOutcome> {
  const hardware = useHardwareStore.getState();
  const result = await hardware.kickDrawer();
  return {
    opened: result.ok,
    via: "usb",
    error: result.ok ? undefined : result.error,
  };
}

/**
 * Full orchestration used after cash sales and by the manual kick button.
 * Fire-and-forget safe: resolves a result, never throws.
 */
export async function requestDrawerOpen(options: {
  saleId?: number;
  /** Manual kicks without a sale need the without-sale permission server-side. */
  reason?: string;
} = {}): Promise<DrawerOpenOutcome> {
  const terminal = await resolveDrawerTerminal();
  if (terminal) {
    const outcome = await openDrawerViaTerminal(terminal.id, options.saleId);
    if (outcome.opened || outcome.commandStatus !== undefined) {
      return outcome;
    }
    // Command authoring itself failed — fall through to USB if configured.
  }
  const hardware = useHardwareStore.getState();
  if (hardware.mode === "usb" && hardware.connected) {
    return openDrawerViaUsb();
  }
  return {
    opened: false,
    via: "none",
    error: terminal
      ? undefined
      : "No paired terminal at this location — pair one in Hardware settings.",
  };
}
