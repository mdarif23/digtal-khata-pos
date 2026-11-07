import axios from "../../../api/axios.js";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CartStore, CartType } from "../types/cart.types.js";
import { HoldCartItems } from "@/features/pos/types/cart.types.js";
import useProductStore from "@/features/products/useProductStore.js";

// export const useCartStore = create(
//   persist(
//     (set) => ({
//       cart: [],
//       addToCart: (cartProduct) =>
//         set((state) => {
//           const exists = state.cart.find(
//             (p) => p.barcode === cartProduct.barcode
//           );
//           if (exists) {
//             return {
//               cart: state.cart.map((p) =>
//                 p.barcode === cartProduct.barcode
//                   ? { ...p, qty: (p.qty || 1) + 1 }
//                   : p
//               ),
//             };
//           }
//           return { cart: [...state.cart, { ...cartProduct, qty: 1 }] };
//         }),
//       addCartQty: (cartBarcode) => {
//         set((state) => {
//           return {
//             cart: state.cart.map((p) =>
//               p.barcode === cartBarcode ? { ...p, qty: p.qty + 1 } : p
//             ),
//           };
//         });
//       },
//       removeCartQty: (cartBarcode) => {
//         set((state) => {
//           return {
//             cart: state.cart
//               .map((p) =>
//                 p.barcode === cartBarcode ? { ...p, qty: p.qty - 1 } : p
//               )
//               .filter((p) => p.qty > 0),
//           };
//         });
//       },
//       removeCartItem: (cartBarcode) => {
//         set((state) => {
//           return {
//             cart: state.cart.filter((item) => item.barcode !== cartBarcode),
//           };
//         });
//       },
//       addCustomCartQty: (editQtyValue, cartBarcode) => {
//         set((state) => {
//           return {
//             cart: state.cart.map((p) =>
//               p.barcode === cartBarcode ? { ...p, qty: editQtyValue } : p
//             ),
//           };
//         });
//       },
//       resetCart: () => {
//         set(() => {
//           return {
//             cart: [],
//           };
//         });
//       },
//       addHoldItemsToCart: (holdItems) => {
//         set(() => {
//           return {
//             cart: holdItems,
//           };
//         });
//       },
//     }),
//     {
//       name: "cart-storage",
//     }
//   )
// );

export const useCartStore = create<CartStore>((set, get) => ({
  cart: [],
  checkoutIdempotencyKey: null,
  // One key per checkout attempt: retries of the SAME checkout reuse it so
  // the backend deduplicates; the next sale gets a fresh key.
  beginCheckout: () => {
    const existing = get().checkoutIdempotencyKey;
    if (existing) return existing;
    const key = crypto.randomUUID();
    set({ checkoutIdempotencyKey: key });
    return key;
  },
  clearCheckoutIdempotency: () => set({ checkoutIdempotencyKey: null }),
  addToCart: (product) =>
    set((state) => {
      const variant = product.variants[0];
      if (!variant) {
        return state;
      }

      const exists = state.cart.find((p) =>
        p.variants.some((v) => v.id === variant.id),
      );

      if (exists) {
        return {
          cart: state.cart.map((item) =>
            item.variants.some((v) => v.id === variant.id)
              ? { ...item, quantity: item.quantity + 1 }
              : item,
          ),
        };
      }
      return {
        cart: [
          //
          ...state.cart,
          {
            ...product,
            variants: [variant],
            quantity: 1,
          },
        ],
      };
    }),
  removeCartItem: (id) =>
    set((state) => ({
      cart: state.cart.filter((p) => p.variants.some((v) => v.id !== id)),
    })),
  addCartQuantity: (id) =>
    set((state) => ({
      cart: state.cart.map((p) => {
        if (p.variants.some((v) => v.id === id)) {
          return {
            ...p,
            quantity: p.quantity + 1,
          };
        }
        return p;
      }),
    })),
  removeCartQuantity: (id) =>
    set((state) => {
      return {
        cart: state.cart
          .map((p) =>
            p.variants.some((v) => v.id === id)
              ? { ...p, quantity: p.quantity - 1 }
              : p,
          )
          .filter((p) => p.quantity > 0),
      };
    }),
  addCustomCartQuantity: (id, customCartQuantity) =>
    set((state) => ({
      cart: state.cart.map((p) =>
        p.variants.some((v) => v.id === id)
          ? { ...p, quantity: customCartQuantity }
          : p,
      ),
    })),
  resetCart: () =>
    set((state) => ({
      cart: [],
      // A fresh cart is a fresh checkout — never reuse the old sale's key.
      checkoutIdempotencyKey: null,
    })),
  addHoldItemsToCart: (holdItems) => {
    set(() => {
      return {
        cart: holdItems,
      };
    });
  },
  addDiscount: (variantId, discountValue, discountType) => {
    set((state) => {
      return {
        cart: state.cart.map((item) =>
          item.variants.some((v) => v.id === variantId)
            ? {
                ...item,
                discount: { value: discountValue, type: discountType },
              }
            : item,
        ),
      };
    });
  },
  addSerialItem: (product, variantId, serials) =>
    set((state) => {
      const variant = product.variants.find((v) => v.id === variantId);
      if (!variant) {
        return state; // Safety check
      }

      // 3. Check if this specific variant is already in the cart
      const exists = state.cart.find((item) =>
        item.variants.some((v) => v.id === variantId),
      );

      if (exists) {
        return {
          cart: state.cart.map((item) =>
            item.variants.some((v) => v.id === variantId)
              ? {
                  ...item,
                  serialNumbers: serials,
                  quantity: serials.length, // Quantity always matches serials count
                }
              : item,
          ),
        };
      }

      // 4. If it doesn't exist, add it as a new cart line
      return {
        cart: [
          ...state.cart,
          {
            ...product,
            variants: [variant], // Only keep the selected variant
            quantity: serials.length,
            serialNumbers: serials, // Attach serials here
          },
        ],
      };
    }),
}));

interface HoldCartStore {
  holdCartItems: HoldCartItems[];
  /** Server-backed: any authorized register at this location can retrieve. */
  holdCart: (items: CartType[]) => Promise<boolean>;
  removeHoldCart: (id: number) => Promise<void>;
  clearHoldCarts: () => Promise<void>;
  refreshHolds: () => Promise<void>;
}

/** Slim, serializable hold snapshot sent to the server. */
interface HeldItemPayload {
  variantId: number;
  quantity: number;
  discount?: { type: "percentage" | "fixed"; value: number } | null;
  serialNumbers?: string[];
  productName: string;
}

interface HeldSaleRow {
  id: number;
  name: string;
  items: HeldItemPayload[];
  createdAt: string;
  heldByName: string | null;
}

async function fetchHeldRows(): Promise<HeldSaleRow[]> {
  const res = await axios.get<{ data: HeldSaleRow[] }>("/held-sales");
  return res.data.data ?? [];
}

/**
 * Shared held sales (Module 1 / Module 11): holds live on the SERVER per
 * business+location, so any authorized cashier at any register can retrieve
 * them — the old localStorage holds were invisible across devices. Prices
 * and stock are re-validated at sale time; on resume the cart is rebuilt
 * from LIVE catalog data (stale/deleted products are reported, never
 * silently dropped).
 */
export const useHoldCartStore = create<HoldCartStore>()((set, get) => ({
  holdCartItems: [],

  refreshHolds: async () => {
    try {
      const rows = await fetchHeldRows();
      set({
        holdCartItems: rows.map((row) => ({
          id: row.id,
          name: row.name,
          time: `${new Date(row.createdAt).toLocaleTimeString()}${
            row.heldByName ? ` · ${row.heldByName}` : ""
          }`,
          // items are the slim payloads; reconstruction happens on resume.
          items: row.items.map((item) => ({
            ...item,
            variants: [],
            quantity: item.quantity,
            serialNumbers: item.serialNumbers ?? [],
          })) as unknown as CartType[],
        })),
      });
    } catch {
      // Network down — keep whatever is displayed; retry on next open.
    }
  },

  holdCart: async (items) => {
    if (items.length === 0) return false;
    const payload = {
      items: items.map((item) => ({
        variantId: item.variants[0]?.id ?? 0,
        quantity: item.quantity,
        discount: item.discount ?? null,
        serialNumbers: item.serialNumbers ?? undefined,
        productName: item.name,
      })),
    };
    try {
      await axios.post("/held-sales", payload);
      await get().refreshHolds();
      return true;
    } catch {
      return false;
    }
  },

  removeHoldCart: async (id) => {
    try {
      await axios.delete(`/held-sales/${id}`);
      set((state) => ({
        holdCartItems: state.holdCartItems.filter((c) => c.id !== id),
      }));
    } catch {
      // Refresh will reconcile on next open.
    }
  },

  clearHoldCarts: async () => {
    const ids = get().holdCartItems.map((c) => c.id);
    await Promise.all(ids.map((id) => axios.delete(`/held-sales/${id}`).catch(() => null)));
    await get().refreshHolds();
  },
}));

/**
 * Rebuilds resumable cart lines from a held sale's slim snapshot using LIVE
 * product data. Returns the lines plus any product names that could not be
 * resolved (deleted/unavailable) — the caller reports them instead of
 * silently dropping money.
 */
export function resumeHeldItems(
  slimItems: {
    variantId: number;
    quantity: number;
    discount?: { type: "percentage" | "fixed"; value: number } | null;
    serialNumbers?: string[];
    productName: string;
  }[],
): { lines: CartType[]; missing: string[] } {
  const products = useProductStore.getState().products;
  const lines: CartType[] = [];
  const missing: string[] = [];
  for (const item of slimItems) {
    const product = products.find((p) =>
      p.variants.some((v) => v.id === item.variantId),
    );
    if (!product) {
      missing.push(item.productName);
      continue;
    }
    const variant = product.variants.find((v) => v.id === item.variantId)!;
    lines.push({
      ...product,
      variants: [variant],
      quantity: item.quantity,
      discount: item.discount ?? null,
      serialNumbers: item.serialNumbers ?? [],
    });
  }
  return { lines, missing };
}

// ---------------------------------------------------------------------------
// Active-cart persistence (Module 1.5 / Module 10): the cart writes through
// to IndexedDB (debounced) on every change and is restored at session
// bootstrap — a refresh or crash no longer destroys a checkout in progress.
// The checkout idempotency key persists WITH the cart, so a post-crash
// retry still reuses the same key and cannot double-charge.
// ---------------------------------------------------------------------------
import {
  loadPersistedCart,
  persistCartDebounced,
} from "../offline/cartPersistence.js";

useCartStore.subscribe((state) => {
  persistCartDebounced(state.cart, state.checkoutIdempotencyKey);
});

/**
 * Restores the persisted cart once per session, called from the session
 * bootstrap AFTER the offline scope is bound. Only fills an empty cart —
 * an in-flight cart (e.g. restored by another path) is never overwritten.
 */
export async function restorePersistedCart(): Promise<void> {
  const current = useCartStore.getState();
  if (current.cart.length > 0) return;
  const persisted = await loadPersistedCart();
  if (!persisted || persisted.cart.length === 0) return;
  useCartStore.setState({
    cart: persisted.cart,
    checkoutIdempotencyKey: persisted.checkoutIdempotencyKey,
  });
}
