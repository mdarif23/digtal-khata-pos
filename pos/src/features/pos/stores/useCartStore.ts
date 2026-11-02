import axios from "../../../api/axios.js";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CartStore, CartType } from "../types/cart.types.js";
import { HoldCartItems } from "@/features/pos/types/cart.types.js";

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

export const useCartStore = create<CartStore>((set) => ({
  cart: [],
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
  addHoldCart: (cart: CartType[]) => void;
  removeHoldCart: (id: number) => void;
  clearHoldCarts: () => void;
}

export const useHoldCartStore = create<HoldCartStore>()(
  persist(
    (set) => ({
      holdCartItems: [],

      // 1. Add a new held cart
      addHoldCart: (cartItems) =>
        set((state) => {
          const nextNumber = state.holdCartItems.length + 1;
          const newHeldCart = {
            id: Date.now(),
            name: `Hold ${nextNumber}`,
            time: new Date().toLocaleTimeString(),
            items: cartItems,
          };
          return { holdCartItems: [...state.holdCartItems, newHeldCart] };
        }),

      // 2. Remove a cart by ID (Perfectly safe filtering)
      removeHoldCart: (id) =>
        set((state) => ({
          holdCartItems: state.holdCartItems.filter(
            (c) => String(c.id) !== String(id),
          ),
        })),

      // 3. Clear all held carts
      clearHoldCarts: () => set({ holdCartItems: [] }),
    }),
    {
      name: "hold-cart-storage", // This is the localStorage key!
    },
  ),
);
