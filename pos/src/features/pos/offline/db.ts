/**
 * Minimal IndexedDB wrapper for the offline POS (Module 10). No dependency:
 * the raw API is small and keeping it dependency-free honors the master
 * prompt's "avoid unnecessary dependencies".
 *
 * Stores:
 * - catalog_products / catalog_customers — cached authorized data, keyed by
 *   the POS user+business scope so a shared device never leaks another
 *   business's catalog.
 * - outbox — durable offline sale queue. Survives browser refresh and
 *   restart; the browser may evict it only under storage pressure (best
 *   practice: request persistent storage — see requestPersistentStorage).
 * - sync_log — synchronization history (bounded, newest last).
 *
 * localStorage is deliberately NOT used as the transaction database.
 */

const DB_NAME = "ezpos-offline";
const DB_VERSION = 1;

export const STORE_PRODUCTS = "catalog_products";
export const STORE_CUSTOMERS = "catalog_customers";
export const STORE_OUTBOX = "outbox";
export const STORE_SYNC_LOG = "sync_log";

export type ScopeKey = string;

let sessionScope: { user: number | string; business: number | string } = {
  user: "anon",
  business: "none",
};

/**
 * Called once per session bootstrap so cached data and the outbox are
 * scoped per user+business — a shared device never leaks another
 * business's catalog or outbox.
 */
export function bindSessionScope(user: number | string, business: number | string): void {
  sessionScope = { user, business };
}

/** Scope prefix for catalog stores. */
export function scopeKey(prefix: string): ScopeKey {
  return `${prefix}:${sessionScope.user}:${sessionScope.business}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PRODUCTS)) {
        db.createObjectStore(STORE_PRODUCTS, { keyPath: "scope" });
      }
      if (!db.objectStoreNames.contains(STORE_CUSTOMERS)) {
        db.createObjectStore(STORE_CUSTOMERS, { keyPath: "scope" });
      }
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const outbox = db.createObjectStore(STORE_OUTBOX, {
          keyPath: "clientSaleId",
        });
        outbox.createIndex("status", "status");
        outbox.createIndex("recordedAt", "recordedAt");
      }
      if (!db.objectStoreNames.contains(STORE_SYNC_LOG)) {
        const log = db.createObjectStore(STORE_SYNC_LOG, {
          autoIncrement: true,
        });
        log.createIndex("at", "at");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

// --- generic helpers -------------------------------------------------------

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return withStore<T | undefined>(store, "readonly", (s) => s.get(key));
}

export async function idbPut(store: string, value: unknown): Promise<void> {
  await withStore(store, "readwrite", (s) => s.put(value as never));
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  await withStore(store, "readwrite", (s) => s.delete(key));
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  return withStore<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

// --- catalog cache ----------------------------------------------------------

export async function cacheCatalog(
  store: string,
  scope: ScopeKey,
  data: unknown[],
): Promise<void> {
  await idbPut(store, { scope, data, cachedAt: new Date().toISOString() });
}

export async function readCatalog<T>(
  store: string,
  scope: ScopeKey,
): Promise<T[] | null> {
  const row = await idbGet<{ scope: string; data: T[]; cachedAt: string }>(
    store,
    scope,
  );
  return row ? row.data : null;
}

// --- outbox ------------------------------------------------------------------

export type OutboxStatus = "pending" | "synced" | "failed";

export interface OutboxEntry {
  /** Client-generated transaction id — sent as the sale idempotency key. */
  clientSaleId: string;
  status: OutboxStatus;
  payload: unknown; // CreateSalePayload
  invoiceNumber: string | null;
  recordedAt: string;
  syncedAt: string | null;
  attempts: number;
  lastError: string | null;
  /** Cashier-facing summary for the sync history dialog. */
  summary: { total: number; itemCount: number; customerName: string | null };
}

export async function putOutboxEntry(entry: OutboxEntry): Promise<void> {
  await idbPut(STORE_OUTBOX, entry);
}

export async function getOutboxEntry(
  clientSaleId: string,
): Promise<OutboxEntry | undefined> {
  return idbGet<OutboxEntry>(STORE_OUTBOX, clientSaleId);
}

export async function listOutbox(): Promise<OutboxEntry[]> {
  const all = await idbGetAll<OutboxEntry>(STORE_OUTBOX);
  return all.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

export async function purgeSyncedBefore(iso: string): Promise<void> {
  const all = await listOutbox();
  const stale = all.filter(
    (e) => e.status === "synced" && (e.syncedAt ?? "").localeCompare(iso) < 0,
  );
  await Promise.all(stale.map((e) => idbDelete(STORE_OUTBOX, e.clientSaleId)));
}

// --- sync log (bounded history) ----------------------------------------------

export interface SyncLogEntry {
  at: string;
  kind: "sync_ok" | "sync_failed" | "conflict" | "recorded_offline";
  clientSaleId: string | null;
  detail: string;
}

export async function appendSyncLog(entry: SyncLogEntry): Promise<void> {
  await withStore(STORE_SYNC_LOG, "readwrite", (s) => s.add(entry));
}

export async function readSyncLog(limit = 50): Promise<SyncLogEntry[]> {
  const all = await idbGetAll<unknown[]>(STORE_SYNC_LOG);
  const entries = all.filter(
    (v): v is SyncLogEntry => v !== null && typeof v === "object" && "at" in v,
  );
  return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

// --- durability --------------------------------------------------------------

/** Ask the browser to keep our data under storage pressure. Best-effort. */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist) {
      await navigator.storage.persist();
    }
  } catch {
    // Not supported — the outbox still works, just with normal eviction.
  }
}
