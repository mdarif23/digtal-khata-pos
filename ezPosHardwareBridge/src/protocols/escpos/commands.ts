/**
 * ESC/POS command builders.
 *
 * ONLY fixed, validated commands are built here — the bridge never forwards
 * arbitrary bytes from users or the network (master prompt §9.3). The
 * drawer kick is `ESC p m t1 t2` (1B 70 m t1 t2): m selects the drawer
 * connector pin (0 → pin 2, 1 → pin 5) and t1/t2 are on/off pulse times in
 * 2 ms units.
 */

const ESC = 0x1b;
const DLE = 0x10;
const EOT = 0x04;

/** Wire pulse units: each tN step is 2 ms. */
const PULSE_UNIT_MS = 2;
/** Upper bound: 255 units × 2 ms = 510 ms — beyond that is a stuck coil. */
const MAX_PULSE_MS = 510;

function clampPulse(value: number | undefined, fallback: number): number {
  const ms = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(Math.round(ms), PULSE_UNIT_MS), MAX_PULSE_MS);
}

export interface DrawerKickParams {
  /** Hardware drawer pin: 2 (drawer 1) or 5 (drawer 2). */
  pin: 2 | 5;
  onMs?: number;
  offMs?: number;
}

/** Hardware pin → ESC p m operand. */
export function drawerPinToOperand(pin: 2 | 5): number {
  return pin === 2 ? 0 : 1;
}

/** Builds the raw drawer-kick bytes with validated/clamped parameters. */
export function buildDrawerKick(params: DrawerKickParams): Uint8Array {
  const onMs = clampPulse(params.onMs, 50);
  const offMs = clampPulse(params.offMs, 500);
  const t1 = Math.round(onMs / PULSE_UNIT_MS);
  const t2 = Math.round(offMs / PULSE_UNIT_MS);
  const m = drawerPinToOperand(params.pin);
  return new Uint8Array([ESC, 0x70, m, t1, t2]);
}

/**
 * Drawer-kick connector status query (`DLE EOT 2`). Only meaningful on
 * transports that can READ back (raw TCP, serial) and only when the drawer
 * has a monitor switch on pin 3 — cheap drawers usually do not. The bridge
 * treats the answer as informational only.
 */
export function buildDrawerStatusQuery(): Uint8Array {
  return new Uint8Array([DLE, EOT, 0x02]);
}
