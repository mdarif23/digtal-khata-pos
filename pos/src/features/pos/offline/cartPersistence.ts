import { idbGet, idbPut, scopeKey, STORE_CART } from "./db.js";
import { currentTerminalId } from "../../../auth/terminalBinding.js";
import type { CartType } from "../../pos/types/cart.types.js";

/**
 * Active-cart persistence (Module 1.5 / Module 10): the register's active
 * cart is written through to IndexedDB on every change and restored at
 * session bootstrap — an accidental refresh or crash no longer destroys a
 * checkout in progress.
 *
 * The checkout idempotency key persists WITH the cart: a cashier who
 * restores after a crash mid-checkout retries with the SAME key, so the
 * backend still cannot create a duplicate sale.
 *
 * Scope: per user+business+TERMINAL (multi-terminal Phase 1) — two bound
 * terminals sharing a browser profile never clobber each other's snapshot.
 * An unbound session uses the legacy terminal-less scope.
 */

const DEBOUNCE_MS = 300;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

interface PersistedCart {
  scope: string;
  cart: CartType[];
  checkoutIdempotencyKey: string | null;
  savedAt: string;
}

function cartScope(): string {
  const terminalId = currentTerminalId();
  return `${scopeKey("cart")}:t${terminalId ?? "none"}`;
}

export function persistCartNow(
  cart: CartType[],
  checkoutIdempotencyKey: string | null,
): void {
  const blob: PersistedCart = {
    scope: cartScope(),
    cart,
    checkoutIdempotencyKey,
    savedAt: new Date().toISOString(),
  };
  void idbPut(STORE_CART, blob);
}

/** Debounced write-through — safe to call from the store subscription. */
export function persistCartDebounced(
  cart: CartType[],
  checkoutIdempotencyKey: string | null,
): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistCartNow(cart, checkoutIdempotencyKey);
  }, DEBOUNCE_MS);
}

export async function loadPersistedCart(): Promise<{
  cart: CartType[];
  checkoutIdempotencyKey: string | null;
} | null> {
  const blob = await idbGet<PersistedCart>(STORE_CART, cartScope());
  if (!blob || !Array.isArray(blob.cart)) return null;
  return { cart: blob.cart, checkoutIdempotencyKey: blob.checkoutIdempotencyKey };
}

export async function clearPersistedCart(): Promise<void> {
  await idbPut(STORE_CART, {
    scope: cartScope(),
    cart: [],
    checkoutIdempotencyKey: null,
    savedAt: new Date().toISOString(),
  });
}
