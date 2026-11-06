/**
 * Terminal binding (multi-terminal Phase 1).
 *
 * A POS PC claims one registered terminal ("this browser IS Counter 2").
 * The binding is a convenience + attribution key, NOT a credential: the
 * user's session authorizes every request, and the backend re-validates the
 * terminal (business, location, active) on each sale. Revoked terminals are
 * rejected server-side with TERMINAL_REVOKED regardless of what is stored
 * here.
 *
 * Stored per user+business (same shape as the active-location key) so a
 * shared device never inherits another context's binding. Purposely
 * dependency-free — both the axios interceptor and the offline IndexedDB
 * scope read this module synchronously.
 */

const TERMINAL_KEY = "ezpos-terminal";

let current: { user: number | string; business: number | string; terminalId: number | null } = {
  user: "anon",
  business: "none",
  terminalId: null,
};

/** Call once per session bootstrap (before cart restore). */
export function bindTerminalScope(
  user: number | string,
  business: number | string,
): void {
  current = { user, business, terminalId: readPersistedTerminalId(user, business) };
}

/** The terminal bound to THIS session, if any — sent as X-Terminal-Id. */
export function currentTerminalId(): number | null {
  return current.terminalId;
}

export function readPersistedTerminalId(
  user: number | string,
  business: number | string,
): number | null {
  try {
    const raw = localStorage.getItem(TERMINAL_KEY);
    if (raw === null) return null;
    const match = /^u(.+)b(.+)t(\d+)$/.exec(raw);
    if (!match) return null;
    if (String(match[1]) !== String(user) || String(match[2]) !== String(business)) {
      return null;
    }
    return Number(match[3]);
  } catch {
    return null;
  }
}

/** Persists the binding for this user/business pair (null clears it). */
export function persistTerminalBinding(
  user: number | string,
  business: number | string,
  terminalId: number | null,
): void {
  current = { user, business, terminalId };
  try {
    if (terminalId === null) {
      localStorage.removeItem(TERMINAL_KEY);
    } else {
      localStorage.setItem(TERMINAL_KEY, `u${user}b${business}t${terminalId}`);
    }
  } catch {
    // localStorage unavailable — the binding still applies for this session.
  }
}
