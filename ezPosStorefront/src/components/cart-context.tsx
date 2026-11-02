"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * Shopper cart: client-side, persisted to localStorage per storefront.
 * Prices shown here are indicative — the server recomputes everything at
 * checkout and the client value is never trusted.
 */

export interface CartItem {
  variantId: number;
  productId: number;
  name: string;
  variantLabel: string;
  price: number;
  image: string | null;
  quantity: number;
}

interface CartContextValue {
  items: CartItem[];
  ready: boolean;
  addItem: (item: CartItem) => void;
  setQuantity: (variantId: number, quantity: number) => void;
  removeItem: (variantId: number) => void;
  clear: () => void;
  count: number;
  subtotal: number;
}

const CartContext = createContext<CartContextValue | null>(null);

function storageKey(storefrontId: number): string {
  return `ezpos-cart-${storefrontId}`;
}

export function CartProvider({
  storefrontId,
  children,
}: {
  storefrontId: number;
  children: React.ReactNode;
}) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey(storefrontId));
      if (raw) {
        const parsed = JSON.parse(raw) as CartItem[];
        if (Array.isArray(parsed)) {
          setItems(
            parsed.filter(
              (item) =>
                item &&
                typeof item.variantId === "number" &&
                typeof item.quantity === "number" &&
                item.quantity > 0,
            ),
          );
        }
      }
    } catch {
      // Corrupt cart: start fresh rather than blocking checkout.
    }
    setReady(true);
  }, [storefrontId]);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(storageKey(storefrontId), JSON.stringify(items));
    } catch {
      // Storage full/blocked — cart stays in memory for this session.
    }
  }, [items, ready, storefrontId]);

  const addItem = useCallback((item: CartItem) => {
    setItems((current) => {
      const existing = current.find((i) => i.variantId === item.variantId);
      if (existing) {
        return current.map((i) =>
          i.variantId === item.variantId
            ? { ...i, quantity: Math.min(99, i.quantity + item.quantity) }
            : i,
        );
      }
      return [...current, item];
    });
  }, []);

  const setQuantity = useCallback((variantId: number, quantity: number) => {
    setItems((current) =>
      quantity <= 0
        ? current.filter((i) => i.variantId !== variantId)
        : current.map((i) =>
            i.variantId === variantId
              ? { ...i, quantity: Math.min(99, quantity) }
              : i,
          ),
    );
  }, []);

  const removeItem = useCallback((variantId: number) => {
    setItems((current) => current.filter((i) => i.variantId !== variantId));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const value = useMemo<CartContextValue>(() => {
    const count = items.reduce((sum, item) => sum + item.quantity, 0);
    const subtotal = items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    return {
      items,
      ready,
      addItem,
      setQuantity,
      removeItem,
      clear,
      count,
      subtotal,
    };
  }, [items, ready, addItem, setQuantity, removeItem, clear]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart must be used inside CartProvider");
  return context;
}
