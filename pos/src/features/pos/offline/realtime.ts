import { create } from "zustand";
import axios from "../../../api/axios.js";

/**
 * Real-time register updates (Module 11) over Server-Sent Events.
 *
 * The client keeps ONE stream per register page. Events are convenience
 * signals only: they bump revision counters and the affected stores refresh
 * through their normal APIs (which re-validate everything server-side).
 * Real-time never replaces server-side validation.
 *
 * Reconnect strategy: EventSource reconnects on its own for transient
 * network errors, but our ticket is ONE-TIME — so on error we close the
 * stream and re-ticket with a small backoff.
 */

export type RealtimeEvent =
  | { kind: "sale.created"; locationId: number; saleId: number }
  | { kind: "held_sales.changed"; locationId: number }
  | { kind: "register.changed"; locationId: number }
  | { kind: "notification.created" }
  /** Catalog edits (multi-terminal): business-wide product cache refresh. */
  | { kind: "product.changed"; locationId: number | null }
  /** Customer create (multi-terminal): refresh open customer pickers. */
  | { kind: "customer.changed"; locationId: number | null }
  /** Terminal registry changes (multi-terminal): refresh binding UIs. */
  | { kind: "terminal.changed"; locationId: number };

interface RealtimeState {
  connected: boolean;
  /** Bumped on each event — consumers watch these to refetch. */
  stockRevision: number;
  holdsRevision: number;
  registerRevision: number;
  notificationRevision: number;
  productRevision: number;
  customerRevision: number;
  terminalRevision: number;
  start: () => void;
  stop: () => void;
}

let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 2_000;

export const useRealtimeStore = create<RealtimeState>()((set, get) => ({
  connected: false,
  stockRevision: 0,
  holdsRevision: 0,
  registerRevision: 0,
  notificationRevision: 0,
  productRevision: 0,
  customerRevision: 0,
  terminalRevision: 0,

  start: () => {
    if (source) return;
    void connect(set);
  },

  stop: () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    source?.close();
    source = null;
    set({ connected: false });
  },
}));

async function connect(
  set: (partial: Partial<RealtimeState>) => void,
): Promise<void> {
  try {
    const res = await axios.post<{ data: { ticket: string } }>(
      "/realtime/ticket",
    );
    const ticket = res.data.data.ticket;
    source = new EventSource(
      `${axios.defaults.baseURL ?? ""}/realtime/stream?ticket=${encodeURIComponent(ticket)}`,
    );
    source.onopen = () => {
      backoffMs = 2_000;
      set({ connected: true });
    };
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as RealtimeEvent;
        switch (event.kind) {
          case "sale.created":
            set((state) => ({ stockRevision: state.stockRevision + 1 }));
            break;
          case "held_sales.changed":
            set((state) => ({ holdsRevision: state.holdsRevision + 1 }));
            break;
          case "register.changed":
            set((state) => ({ registerRevision: state.registerRevision + 1 }));
            break;
          case "notification.created":
            set((state) => ({
              notificationRevision: state.notificationRevision + 1,
            }));
            break;
          case "product.changed":
            set((state) => ({ productRevision: state.productRevision + 1 }));
            break;
          case "customer.changed":
            set((state) => ({ customerRevision: state.customerRevision + 1 }));
            break;
          case "terminal.changed":
            set((state) => ({ terminalRevision: state.terminalRevision + 1 }));
            break;
        }
      } catch {
        // Malformed event — ignore.
      }
    };
    source.onerror = () => {
      set({ connected: false });
      source?.close();
      source = null;
      // The ticket was consumed; re-ticket with backoff. Give up silently
      // after the page is closed (stop() clears the timer).
      reconnectTimer = setTimeout(() => {
        void connect(set);
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    };
  } catch {
    // Ticket minting failed (offline / session issue) — retry with backoff.
    reconnectTimer = setTimeout(() => {
      void connect(set);
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 60_000);
  }
}
