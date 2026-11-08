import axios from "../../../api/axios.js";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  lineMatchesUnit,
  lineUnitId,
  type CartStore,
  type CartType,
  type SellUnitRef,
  type SwitchUnitResult,
} from "../types/cart.types.js";
import { HoldCartItems } from "@/features/pos/types/cart.types.js";
import useProductStore from "@/features/products/useProductStore.js";
import { fetchSellUnits } from "../hooks/useSellUnits.js";
import { useSessionStore } from "@/auth/sessionStore.js";

/** Unit fields stamped onto every line so persisted carts are self-describing. */
function unitFieldsFor(unit: SellUnitRef | undefined, fallbackPrice: number) {
  if (unit && unit.uomConversionId != null) {
    return {
      uomConversionId: unit.uomConversionId,
      unitName: unit.unitName,
      unitAbbreviation: unit.unitAbbreviation,
      conversionFactor: unit.conversionFactor,
      unitPrice: unit.salePrice,
    };
  }
  return {
    uomConversionId: null,
    unitName: null,
    unitAbbreviation: null,
    conversionFactor: 1,
    unitPrice: unit ? unit.salePrice : fallbackPrice,
  };
}

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
  belowMinimumReason: "",
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
  addToCart: (product, unit) =>
    set((state) => {
      const variant = product.variants[0];
      if (!variant) {
        return state;
      }

      const unitId = unit?.uomConversionId ?? null;
      // Lines are keyed by (variant, unit): a Box line and a Pcs line of the
      // same variant coexist; re-adding the same unit increments ITS line.
      const exists = state.cart.find(
        (p) =>
          p.variants.some((v) => v.id === variant.id) &&
          lineUnitId(p) === unitId,
      );

      if (exists) {
        return {
          cart: state.cart.map((item) =>
            item === exists
              ? {
                  ...item,
                  quantity: item.quantity + 1,
                  enteredQuantity: item.quantity + 1,
                }
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
            enteredQuantity: 1,
            ...unitFieldsFor(unit, Number(variant.sellingPrice)),
          },
        ],
      };
    }),
  removeCartItem: (id, uomConversionId) =>
    set((state) => ({
      cart: state.cart.filter(
        (p) =>
          !(
            p.variants.some((v) => v.id === id) &&
            lineMatchesUnit(p, uomConversionId)
          ),
      ),
    })),
  addCartQuantity: (id, uomConversionId) =>
    set((state) => ({
      cart: state.cart.map((p) => {
        if (
          p.variants.some((v) => v.id === id) &&
          lineMatchesUnit(p, uomConversionId)
        ) {
          return {
            ...p,
            quantity: p.quantity + 1,
            enteredQuantity: p.quantity + 1,
          };
        }
        return p;
      }),
    })),
  removeCartQuantity: (id, uomConversionId) =>
    set((state) => {
      return {
        cart: state.cart
          .map((p) =>
            p.variants.some((v) => v.id === id) &&
            lineMatchesUnit(p, uomConversionId)
              ? {
                  ...p,
                  quantity: p.quantity - 1,
                  enteredQuantity: p.quantity - 1,
                }
              : p,
          )
          .filter((p) => p.quantity > 0),
      };
    }),
  addCustomCartQuantity: (id, customCartQuantity, uomConversionId) =>
    set((state) => ({
      cart: state.cart.map((p) =>
        p.variants.some((v) => v.id === id) &&
        lineMatchesUnit(p, uomConversionId)
          ? { ...p, quantity: customCartQuantity, enteredQuantity: customCartQuantity }
          : p,
      ),
    })),
  switchLineUnit: (variantId, fromUomConversionId, unit) => {
    const state = get();
    const sourceIndex = state.cart.findIndex(
      (p) =>
        p.variants.some((v) => v.id === variantId) &&
        lineUnitId(p) === (fromUomConversionId ?? null),
    );
    if (sourceIndex === -1) {
      return { ok: false, reason: "line-not-found" } as const;
    }
    const source = state.cart[sourceIndex];
    if (!source) return { ok: false, reason: "line-not-found" } as const;
    const baseQuantity = Number(source.quantity) * (source.conversionFactor ?? 1);
    const factor = unit.conversionFactor > 0 ? unit.conversionFactor : 1;
    // Keep the BASE amount constant where whole packages allow; the floor
    // remainder (e.g. the odd piece) is returned to stock by the caller.
    const convertedQuantity = Math.floor(baseQuantity / factor);
    if (!Number.isFinite(convertedQuantity) || convertedQuantity < 1) {
      return { ok: false, reason: "below-one-package" } as const;
    }

    // Merge into an existing target-unit line instead of leaving two.
    const targetIndex = state.cart.findIndex(
      (p, index) =>
        index !== sourceIndex &&
        p.variants.some((v) => v.id === variantId) &&
        lineUnitId(p) === (unit.uomConversionId ?? null),
    );

    let cart: CartType[];
    let merged: boolean;
    if (targetIndex !== -1) {
      merged = true;
      const target = state.cart[targetIndex];
      if (!target) return { ok: false, reason: "line-not-found" } as const;
      const nextQuantity = target.quantity + convertedQuantity;
      cart = state.cart
        .map((p, index) =>
          index === targetIndex
            ? { ...p, quantity: nextQuantity, enteredQuantity: nextQuantity }
            : p,
        )
        .filter((_, index) => index !== sourceIndex);
    } else {
      merged = false;
      cart = state.cart.map((p, index) =>
        index === sourceIndex
          ? {
              ...p,
              quantity: convertedQuantity,
              enteredQuantity: convertedQuantity,
              uomConversionId: unit.uomConversionId,
              unitName: unit.unitName,
              unitAbbreviation: unit.unitAbbreviation,
              conversionFactor: unit.conversionFactor,
              unitPrice: unit.salePrice,
            }
          : p,
      );
    }
    set({ cart });
    return { ok: true, convertedQuantity, merged } as const;
  },
  resetCart: () =>
    set((state) => ({
      cart: [],
      // A fresh cart is a fresh checkout — never reuse the old sale's key.
      checkoutIdempotencyKey: null,
      belowMinimumReason: "",
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
  setLinePriceOverride: (variantId, uomConversionId, override) =>
    set((state) => ({
      cart: state.cart.map((item) =>
        item.variants.some((v) => v.id === variantId) &&
        lineMatchesUnit(item, uomConversionId)
          ? { ...item, priceOverride: override }
          : item,
      ),
    })),
  setBelowMinimumReason: (reason) => set({ belowMinimumReason: reason }),
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
  /** Quantity in the SELECTED unit (see enteredQuantity). */
  quantity: number;
  discount?: { type: "percentage" | "fixed"; value: number } | null;
  serialNumbers?: string[];
  productName: string;
  /** Packaging-unit selling: null = base unit. */
  uomConversionId?: number | null;
  /** Quantity in the selected unit (mirrors quantity). */
  enteredQuantity?: number;
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
        uomConversionId: item.uomConversionId ?? null,
        enteredQuantity: item.enteredQuantity ?? item.quantity,
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
 *
 * Packaging-unit lines (uomConversionId) are re-derived from the LIVE
 * sell-units of each variant (price/factor refresh; holds re-price on
 * resume). If a conversion no longer exists — or sell-units cannot be
 * fetched (offline) — the item falls back to the BASE unit line with its
 * entered quantity: resume never breaks, the server re-validates stock and
 * prices at sale time.
 */
export async function resumeHeldItems(
  slimItems: {
    variantId: number;
    quantity: number;
    discount?: { type: "percentage" | "fixed"; value: number } | null;
    serialNumbers?: string[];
    productName: string;
    uomConversionId?: number | null;
    enteredQuantity?: number;
  }[],
): Promise<{ lines: CartType[]; missing: string[] }> {
  const products = useProductStore.getState().products;
  const lines: CartType[] = [];
  const missing: string[] = [];

  // One sell-units lookup per distinct variant, in parallel; failures fall
  // back to base lines below rather than failing the resume.
  const unitsByVariant = new Map<
    number,
    Awaited<ReturnType<typeof fetchSellUnits>>["units"]
  >();
  const locationId = useSessionStore.getState().activeLocationId;
  await Promise.all(
    [...new Set(slimItems.map((item) => item.variantId))].map(
      async (variantId) => {
        try {
          const data = await fetchSellUnits(variantId, locationId);
          unitsByVariant.set(variantId, data.units);
        } catch {
          // Offline / conversion table unavailable — base-unit fallback.
        }
      },
    ),
  );

  for (const item of slimItems) {
    const product = products.find((p) =>
      p.variants.some((v) => v.id === item.variantId),
    );
    if (!product) {
      missing.push(item.productName);
      continue;
    }
    const variant = product.variants.find((v) => v.id === item.variantId)!;
    // Held quantity is in ENTERED units (2 = two boxes on a Box hold).
    const enteredQuantity = item.enteredQuantity ?? item.quantity;
    const heldUnit =
      item.uomConversionId != null
        ? unitsByVariant
            .get(item.variantId)
            ?.find((unit) => unit.uomConversionId === item.uomConversionId)
        : undefined;

    if (heldUnit) {
      lines.push({
        ...product,
        variants: [variant],
        quantity: enteredQuantity,
        enteredQuantity,
        discount: item.discount ?? null,
        serialNumbers: item.serialNumbers ?? [],
        uomConversionId: heldUnit.uomConversionId,
        unitName: heldUnit.unitName,
        unitAbbreviation: heldUnit.unitAbbreviation,
        conversionFactor: heldUnit.conversionFactor,
        unitPrice: heldUnit.salePrice,
      });
    } else {
      lines.push({
        ...product,
        variants: [variant],
        quantity: enteredQuantity,
        enteredQuantity,
        discount: item.discount ?? null,
        serialNumbers: item.serialNumbers ?? [],
        uomConversionId: null,
        unitName: null,
        unitAbbreviation: null,
        conversionFactor: 1,
        unitPrice: Number(variant.sellingPrice),
      });
    }
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
