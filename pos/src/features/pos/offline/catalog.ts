import { useOfflineStore } from "./offlineStore.js";
import {
  bindSessionScope,
  cacheCatalog,
  idbGet,
  idbPut,
  readCatalog,
  scopeKey,
  STORE_CUSTOMERS,
  STORE_PRODUCTS,
  requestPersistentStorage,
} from "./db.js";

/**
 * Catalog caching for offline checkout (Module 10): every successful load
 * of products/customers is cached in IndexedDB, scoped per user+business.
 * When the API is unreachable the cached copy loads instead — clearly
 * flagged as offline data via offlineMode.
 */

/** Call once after the session resolves (bootstrap in api/axios). */
export function bindOfflineSession(
  userId: number | string,
  businessId: number | string,
): void {
  bindSessionScope(userId, businessId);
  void requestPersistentStorage();
}

function isNetworkError(err: unknown): boolean {
  return (
    Boolean(err) &&
    typeof err === "object" &&
    "response" in err &&
    (err as { response?: unknown }).response === undefined
  );
}

/**
 * Loads products with an IndexedDB fallback. Returns the list plus whether
 * it came from the cache. The caller pushes the result into its store with
 * its existing shape — nothing else changes.
 */
export async function loadProductsWithCache<T>(
  fetcher: () => Promise<T[]>,
): Promise<{ data: T[]; fromCache: boolean }> {
  try {
    const data = await fetcher();
    void cacheCatalog(STORE_PRODUCTS, scopeKey("products"), data as unknown[]);
    useOfflineStore.getState().offlineMode === true &&
      useOfflineStore.setState({ offlineMode: false });
    return { data, fromCache: false };
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    const cached = await readCatalog<T>(STORE_PRODUCTS, scopeKey("products"));
    if (cached === null) throw err;
    useOfflineStore.setState({ offlineMode: true, online: false });
    return { data: cached, fromCache: true };
  }
}

/** Same fallback contract for customers. */
export async function loadCustomersWithCache<T>(
  fetcher: () => Promise<T[]>,
): Promise<{ data: T[]; fromCache: boolean }> {
  try {
    const data = await fetcher();
    void cacheCatalog(STORE_CUSTOMERS, scopeKey("customers"), data as unknown[]);
    return { data, fromCache: false };
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    const cached = await readCatalog<T>(STORE_CUSTOMERS, scopeKey("customers"));
    if (cached === null) throw err;
    return { data: cached, fromCache: true };
  }
}

// ---------------------------------------------------------------------------
// P3 Phase 2 (D10): batch snapshots for batch-tracked variants. Cached at
// allowance-refresh time; offline add-to-cart for a batch product requires
// cached batch rows (a batch line without batch truth is blocked, mirroring
// the serial-tracked hard block) and the FEFO-first cached batch attaches to
// the line automatically — the server re-validates everything at sync.
// ---------------------------------------------------------------------------

export interface CachedBatch {
  id: number;
  batchNumber: string;
  quantityRemaining: number;
  expiryDate: string | null;
  expiryStatus: "valid" | "expiring_soon" | "expired" | "no_expiry";
}

interface BatchesBlob {
  scope: string;
  byVariant: Record<string, CachedBatch[]>;
  savedAt: string;
}

export async function cacheVariantBatches(
  entries: { variantId: number; batches: CachedBatch[] }[],
): Promise<void> {
  const byVariant: Record<string, CachedBatch[]> = {};
  for (const entry of entries) {
    byVariant[String(entry.variantId)] = entry.batches;
  }
  await idbPut(STORE_PRODUCTS, {
    scope: scopeKey("batches"),
    byVariant,
    savedAt: new Date().toISOString(),
  } satisfies BatchesBlob);
}

export async function readVariantBatches(
  variantId: number,
): Promise<CachedBatch[] | null> {
  const blob = await idbGet<BatchesBlob>(STORE_PRODUCTS, scopeKey("batches"));
  if (!blob) return null;
  return blob.byVariant[String(variantId)] ?? null;
}
