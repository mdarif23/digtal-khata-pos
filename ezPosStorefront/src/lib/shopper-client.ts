/**
 * Client-side shopper API — talks ONLY to this app's routes (which attach
 * the internal token server-side). Never imports server-only modules.
 */

export interface ShopperProfile {
  id: number;
  email: string;
  fullName: string | null;
  phone: string | null;
}

export interface ShopperOrder {
  invoiceNumber: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string | null;
  total: number;
  createdAt: string;
}

export interface ShopperMe {
  shopper: ShopperProfile;
  orders: ShopperOrder[];
}

export async function shopperSession(
  action: "login" | "register",
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; message: string; token?: string }> {
  try {
    const res = await fetch("/api/shopper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; message?: string; token?: string }
      | null;
    return {
      ok: res.ok && body?.ok === true,
      message: body?.message ?? "Sign-in failed.",
      token: body?.token,
    };
  } catch {
    return { ok: false, message: "We could not reach the store. Try again." };
  }
}

export async function fetchShopperMe(
  storefrontId: number,
  token: string,
): Promise<{ ok: boolean; message: string; data?: ShopperMe }> {
  try {
    const res = await fetch(`/api/shopper?storefrontId=${storefrontId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; message?: string; data?: ShopperMe }
      | null;
    return {
      ok: res.ok && body?.ok === true,
      message: body?.message ?? "Could not load the account.",
      data: body?.data,
    };
  } catch {
    return { ok: false, message: "We could not reach the store. Try again." };
  }
}
