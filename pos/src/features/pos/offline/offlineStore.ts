import { create } from "zustand";
import axios from "../../../api/axios.js";
import {
  appendSyncLog,
  getOutboxEntry,
  listOutbox,
  putOutboxEntry,
  readSyncLog,
  requestPersistentStorage,
  type OutboxEntry,
  type SyncLogEntry,
} from "./db.js";

/**
 * Offline POS state + synchronization engine (Module 10).
 *
 * A sale recorded offline lives in the durable outbox with a client-generated
 * transaction id that doubles as the backend's sale idempotency key —
 * replaying it can NEVER create a duplicate sale, no matter how many times
 * the sync engine retries (the backend returns the original invoice).
 *
 * Sync rules:
 * - only network failures keep an entry pending (backoff + auto-retry);
 * - a backend REJECTION marks the entry failed → requires manual review
 *   (stale price, deleted product, insufficient stock, offline payment not
 *   permitted) — failed entries are never silently dropped or retried;
 * - history (synced + failed + log) is visible to the cashier.
 */

export interface OfflineSaleInput {
  payload: unknown; // CreateSalePayload
  summary: OutboxEntry["summary"];
}

export type OfflineOpKind = Exclude<import("./db.js").OutboxEntry["kind"], undefined>;

export interface OfflineOpInput {
  kind: OfflineOpKind;
  opId?: string;
  payload: unknown;
  summary?: Partial<OutboxEntry["summary"]>;
}

interface OfflineState {
  online: boolean;
  /** True while the device has never reached the backend (catalog fallback active). */
  offlineMode: boolean;
  pendingCount: number;
  failedCount: number;
  syncing: boolean;
  lastSyncAt: string | null;
  history: OutboxEntry[];
  log: SyncLogEntry[];
  refresh: () => Promise<void>;
  recordOfflineSale: (input: OfflineSaleInput) => Promise<string>;
  recordOfflineOp: (input: OfflineOpInput) => Promise<string>;
  syncNow: () => Promise<{ synced: number; failed: number }>;
  retryFailed: () => Promise<void>;
  startWatchers: () => void;
}

let backoffMs = 5_000;
let backoffTimer: ReturnType<typeof setTimeout> | null = null;

function isNetworkError(err: unknown): boolean {
  return (
    // axios: no response = network/DNS/offline
    Boolean(err) &&
    typeof err === "object" &&
    "response" in err &&
    (err as { response?: unknown }).response === undefined
  );
}

function currentBackoff(): number {
  const value = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 5 * 60_000);
  return value;
}

export const useOfflineStore = create<OfflineState>()((set, get) => ({
  online: navigator.onLine,
  offlineMode: false,
  pendingCount: 0,
  failedCount: 0,
  syncing: false,
  lastSyncAt: null,
  history: [],
  log: [],

  refresh: async () => {
    const entries = await listOutbox();
    set({
      pendingCount: entries.filter((e) => e.status === "pending").length,
      failedCount: entries.filter((e) => e.status === "failed").length,
      history: entries.slice(-100).reverse(),
    });
    set({ log: await readSyncLog(30) });
  },

  recordOfflineSale: async (input) => {
    // Sales recorded offline replay through the OFFLINE op surface (Phase 3):
    // allocation-aware, conflict-recorded — never dropped for oversell.
    return get().recordOfflineOp({
      kind: "sale",
      payload: input.payload,
      summary: input.summary,
    });
  },

  recordOfflineOp: async (input) => {
    await requestPersistentStorage();
    const clientSaleId = input.opId ?? crypto.randomUUID();
    const entry: OutboxEntry = {
      clientSaleId,
      status: "pending",
      kind: input.kind,
      offlineOrigin: true,
      payload: input.payload,
      invoiceNumber: null,
      recordedAt: new Date().toISOString(),
      syncedAt: null,
      attempts: 0,
      lastError: null,
      summary: {
        total: input.summary?.total ?? 0,
        itemCount: input.summary?.itemCount ?? 0,
        customerName: input.summary?.customerName ?? null,
      },
    };
    await putOutboxEntry(entry);
    await appendSyncLog({
      at: new Date().toISOString(),
      kind: "recorded_offline",
      clientSaleId,
      detail:
        input.kind === "sale"
          ? `Offline sale recorded — ৳${entry.summary.total.toFixed(2)}, ${entry.summary.itemCount} item(s)`
          : `Offline ${input.kind} recorded`,
    });
    await get().refresh();
    return clientSaleId;
  },

  syncNow: async () => {
    if (get().syncing) return { synced: 0, failed: 0 };
    set({ syncing: true });
    let synced = 0;
    let failed = 0;
    try {
      const entries = (await listOutbox()).filter((e) => e.status === "pending");
      // Sequential replay preserves the order the sales were recorded in —
      // stock consumption on the server must match the register's history.
      for (const entry of entries) {
        try {
          let invoiceNumber: string | null = null;
          let conflictId: number | undefined;
          if (entry.offlineOrigin) {
            // Offline-originated op (Phase 3): allocation-aware application,
            // per-op results, conflicts recorded server-side for review.
            const opType =
              entry.kind === "sale" ? "sale.create" : (entry.kind as string);
            const res = await axios.post<{
              data: {
                results: {
                  opId: string;
                  status: string;
                  saleId?: number;
                  conflictId?: number;
                  error?: string;
                }[];
              };
            }>("/offline/sync", {
              ops: [{ opId: entry.clientSaleId, type: opType, payload: entry.payload }],
            });
            const result = res.data?.data?.results?.[0];
            if (!result) throw new Error("The sync endpoint returned no result.");
            if (result.status === "failed") {
              const error = new Error(result.error ?? "The op was rejected.");
              (error as { response?: unknown }).response = { data: { message: result.error } };
              throw error;
            }
            conflictId = result.conflictId;
            void invoiceNumber;
          } else {
            const res = await axios.post<{
              data: { sale: { invoiceNumber: string } };
            }>("/sales", entry.payload as never);
            invoiceNumber = res.data?.data?.sale?.invoiceNumber ?? null;
          }
          entry.status = "synced";
          entry.syncedAt = new Date().toISOString();
          entry.invoiceNumber = invoiceNumber;
          if (conflictId !== undefined) entry.conflictId = conflictId;
          entry.attempts += 1;
          entry.lastError = null;
          await putOutboxEntry(entry);
          await appendSyncLog({
            at: new Date().toISOString(),
            kind: "sync_ok",
            clientSaleId: entry.clientSaleId,
            detail: `Synced — invoice ${entry.invoiceNumber ?? "(replayed)"}`,
          });
          synced += 1;
          backoffMs = 5_000; // success resets the backoff
          if (conflictId !== undefined) {
            await appendSyncLog({
              at: new Date().toISOString(),
              kind: "conflict",
              clientSaleId: entry.clientSaleId,
              detail: "Applied, but flagged for manager review (stock/conflict).",
            });
          }
        } catch (err) {
          entry.attempts += 1;
          if (isNetworkError(err)) {
            // Network down again mid-sync — keep pending for the next round.
            entry.lastError = "Network unavailable during sync.";
            await putOutboxEntry(entry);
            break;
          }
          // The backend REJECTED the sale (stale price, deleted product,
          // stock conflict, offline-eligible validation) — a real conflict,
          // never retried. Requires manual review by the cashier/manager.
          entry.status = "failed";
          entry.lastError =
            (err as { response?: { data?: { message?: string } } })?.response?.data
              ?.message ?? "The sale was rejected by the server.";
          await putOutboxEntry(entry);
          await appendSyncLog({
            at: new Date().toISOString(),
            kind: "conflict",
            clientSaleId: entry.clientSaleId,
            detail: `REJECTED — ${entry.lastError} (৳${entry.summary.total.toFixed(2)} taken offline; review required)`,
          });
          failed += 1;
        }
      }
      if (synced > 0 || failed > 0) {
        set({ lastSyncAt: new Date().toISOString() });
      }
    } finally {
      set({ syncing: false });
      await get().refresh();
    }
    return { synced, failed };
  },

  retryFailed: async () => {
    // A manager-facing retry: failed entries are conflicts, so this only
    // re-queues them as pending AFTER the cashier has had the chance to
    // adjust (e.g. re-pricing) — the payload is replayed as-is with the
    // SAME idempotency key, so nothing can duplicate.
    const entries = (await listOutbox()).filter((e) => e.status === "failed");
    for (const entry of entries) {
      entry.status = "pending";
      entry.lastError = "Manually re-queued after review.";
      await putOutboxEntry(entry);
    }
    await get().refresh();
    void get().syncNow();
  },

  startWatchers: () => {
    // Reconnect + periodic retry with backoff. The engine never overlaps.
    const refreshGrants = async () => {
      // Phase 3: keep this terminal's offline allowances fresh WHILE online
      // so they are in place the moment the connection drops.
      try {
        const { prepareOffline } = await import("./allocations.js");
        const { default: useProductStore } = await import(
          "@/features/products/useProductStore.js"
        );
        const products = useProductStore.getState().products ?? [];
        const variantIds = products
          .flatMap((p: { variants?: { id: number }[] }) => (p.variants ?? []).map((v) => v.id))
          .filter(Boolean);
        if (variantIds.length === 0) return;
        await prepareOffline(variantIds);
        await appendSyncLog({
          at: new Date().toISOString(),
          kind: "recorded_offline",
          clientSaleId: "allocations",
          detail: `Offline allowances refreshed (${variantIds.length} variants).`,
        });
        await get().refresh();
      } catch {
        // Best effort — stale grants only ever UNDER-sell (the server
        // re-checks and flags overages at sync time).
      }
    };
    window.addEventListener("online", () => {
      set({ online: true });
      backoffTimer !== null && clearTimeout(backoffTimer);
      void get().syncNow();
      void refreshGrants();
    });
    window.addEventListener("offline", () => set({ online: false, offlineMode: true }));
    if (get().online) void refreshGrants();
    const tick = () => {
      if (get().online && get().pendingCount > 0 && !get().syncing) {
        void get().syncNow();
      }
      if (get().online) {
        backoffTimer = setTimeout(tick, currentBackoff());
      } else {
        backoffTimer = setTimeout(tick, 15_000);
      }
    };
    backoffTimer = setTimeout(tick, 10_000);

    // Initial catch-up: replay anything recorded while offline.
    if (get().pendingCount > 0) void get().syncNow();
  },
}));

/** Convenience: read one entry for the review dialog. */
export async function getOfflineSale(clientSaleId: string) {
  return getOutboxEntry(clientSaleId);
}
