"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { fetchShopperMe, type ShopperMe } from "@/lib/shopper-client";

/**
 * Shopper account session (client). Token lives in localStorage per
 * storefront; the token is shopper-scoped only and is exchanged server-side
 * for data — the internal API token never reaches the browser.
 */

interface ShopperContextValue {
  token: string | null;
  profile: ShopperMe | null;
  ready: boolean;
  signIn: (mode: "login" | "register", payload: Record<string, unknown>) =>
    Promise<{ ok: boolean; message: string }>;
  signOut: () => void;
  refresh: () => Promise<void>;
}

const ShopperContext = createContext<ShopperContextValue | null>(null);

function storageKey(storefrontId: number): string {
  return `ezpos-shopper-${storefrontId}`;
}

export function ShopperProvider({
  storefrontId,
  children,
}: {
  storefrontId: number;
  children: React.ReactNode;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<ShopperMe | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(window.localStorage.getItem(storageKey(storefrontId)));
    setReady(true);
  }, [storefrontId]);

  const refresh = useCallback(async () => {
    if (!token) {
      setProfile(null);
      return;
    }
    const result = await fetchShopperMe(storefrontId, token);
    if (result.ok && result.data) {
      setProfile(result.data);
    } else {
      // Expired/invalid token: start clean.
      window.localStorage.removeItem(storageKey(storefrontId));
      setToken(null);
      setProfile(null);
    }
  }, [storefrontId, token]);

  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh]);

  const signIn = useCallback(
    async (mode: "login" | "register", payload: Record<string, unknown>) => {
      const { shopperSession } = await import("@/lib/shopper-client");
      const result = await shopperSession(mode, {
        storefrontId,
        ...payload,
      });
      if (result.ok && result.token) {
        window.localStorage.setItem(storageKey(storefrontId), result.token);
        setToken(result.token);
        return { ok: true, message: result.message };
      }
      return { ok: false, message: result.message };
    },
    [storefrontId],
  );

  const signOut = useCallback(() => {
    window.localStorage.removeItem(storageKey(storefrontId));
    setToken(null);
    setProfile(null);
  }, [storefrontId]);

  const value = useMemo(
    () => ({ token, profile, ready, signIn, signOut, refresh }),
    [token, profile, ready, signIn, signOut, refresh],
  );

  return <ShopperContext.Provider value={value}>{children}</ShopperContext.Provider>;
}

export function useShopper(): ShopperContextValue {
  const context = useContext(ShopperContext);
  if (!context) throw new Error("useShopper must be used inside ShopperProvider");
  return context;
}
