import "server-only";
import { serverConfig, requireInternalToken } from "./config";

/**
 * Server-side client for the backend's internal storefront endpoints
 * (x-internal-token). Never exposed to the browser.
 */

export interface TenantConfig {
  available: boolean;
  storefront: {
    id: number;
    businessId: number;
    name: string;
    subdomain: string;
    themeId: string;
    config: Record<string, unknown>;
    seo: { title?: string; description?: string } | null;
    contact: {
      phone?: string;
      email?: string;
      address?: string;
      social?: { facebook?: string; instagram?: string; whatsapp?: string };
    } | null;
    flags: {
      storePickupEnabled: boolean;
      analyticsEnabled: boolean;
      searchIndexingEnabled: boolean;
      shopperAccountsEnabled: boolean;
    };
  };
  source: "published" | "preview";
  pages: Array<{
    id: number;
    slug: string;
    title: string;
    blocks?: Array<Record<string, unknown>>;
    seoTitle?: string | null;
    seoDescription?: string | null;
  }>;
  zones: Array<{
    id: number;
    name: string;
    areas: string[];
    rate: string | number;
    freeThreshold: string | number | null;
    estimatedDaysMin: number | null;
    estimatedDaysMax: number | null;
  }>;
  paymentMethods?: Array<{ method: "cod" | "sslcommerz"; label: string | null }>;
}

export interface StorefrontProduct {
  id: number;
  name: string;
  description: string | null;
  categoryId: number | null;
  categoryName: string | null;
  brandId: number | null;
  brandName: string | null;
  hasVariants: boolean;
  images: string[];
  variants: Array<{
    id: number;
    sku: string;
    price: number;
    isDefault: boolean;
    availability: number;
  }>;
}

export interface CatalogResult {
  products: StorefrontProduct[];
  total: number;
  page: number;
  pageSize: number;
  categories: Array<{ id: number; name: string }>;
  brands: Array<{ id: number; name: string }>;
}

async function internalFetch<T>(
  path: string,
  init: RequestInit & { revalidate?: number | false } = {},
): Promise<T | null> {
  const { revalidate = 60, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("x-internal-token", requireInternalToken());
  if (rest.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let res: Response;
  try {
    res = await fetch(`${serverConfig.backendUrl}${path}`, {
      ...rest,
      headers,
      next: { revalidate },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as
    | { data?: T }
    | null;
  return body?.data ?? null;
}

/**
 * Loads the tenant's full render payload. Cached per storefront+preview for
 * 60s (draft edits land on preview immediately via no-store; publishes go
 * live within a minute).
 */
export async function fetchTenantConfig(
  storefrontId: number,
  preview?: string,
): Promise<TenantConfig | null> {
  const query = new URLSearchParams({ storefrontId: String(storefrontId) });
  if (preview) query.set("preview", preview);
  return internalFetch<TenantConfig>(
    `/api/internal/storefront/config?${query.toString()}`,
    { revalidate: preview ? false : 60 },
  );
}

export interface CatalogQuery {
  storefrontId: number;
  search?: string;
  categoryId?: number;
  brandId?: number;
  sort?: string;
  page?: number;
}

export async function fetchCatalog(
  query: CatalogQuery,
): Promise<CatalogResult | null> {
  const params = new URLSearchParams({ storefrontId: String(query.storefrontId) });
  if (query.search) params.set("search", query.search);
  if (query.categoryId) params.set("categoryId", String(query.categoryId));
  if (query.brandId) params.set("brandId", String(query.brandId));
  if (query.sort) params.set("sort", query.sort);
  if (query.page) params.set("page", String(query.page));
  return internalFetch<CatalogResult>(`/api/internal/storefront/catalog?${params.toString()}`, {
    revalidate: 60,
  });
}

export async function fetchProduct(
  storefrontId: number,
  productId: number,
): Promise<StorefrontProduct | null> {
  return internalFetch<StorefrontProduct>(
    `/api/internal/storefront/products/${productId}?storefrontId=${storefrontId}`,
    { revalidate: 60 },
  );
}

export interface CheckoutResponse {
  saleId: number;
  invoiceNumber: string;
  status: string;
  total: number;
  deliveryFee: number;
  currency: string;
  duplicated: boolean;
}

export async function submitCheckout(
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; message: string; data?: CheckoutResponse }> {
  let res: Response;
  try {
    res = await fetch(
      `${serverConfig.backendUrl}/api/internal/storefront/orders`,
      {
        method: "POST",
        headers: {
          "x-internal-token": serverConfig.internalToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      },
    );
  } catch {
    return { ok: false, message: "We could not reach the store. Try again." };
  }
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; message?: string; data?: CheckoutResponse }
    | null;
  return {
    ok: res.ok && body?.success === true,
    message: body?.message ?? (res.ok ? "Order placed." : "Checkout failed."),
    data: body?.data,
  };
}

export interface TrackedOrder {
  invoiceNumber: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string | null;
  total: number;
  createdAt: string;
}

export async function trackOrder(
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; message: string; data?: TrackedOrder }> {
  let res: Response;
  try {
    res = await fetch(
      `${serverConfig.backendUrl}/api/internal/storefront/orders/track`,
      {
        method: "POST",
        headers: {
          "x-internal-token": serverConfig.internalToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      },
    );
  } catch {
    return { ok: false, message: "We could not reach the store. Try again." };
  }
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; message?: string; data?: TrackedOrder }
    | null;
  return {
    ok: res.ok && body?.success === true,
    message: body?.message ?? "Lookup failed.",
    data: body?.data,
  };
}

export interface VerifyPaymentResult {
  paid: boolean;
  saleId: number;
  invoiceNumber: string;
  amount: number;
  status: string;
  message: string;
}

/** Post-redirect payment verification (server-side core on the backend). */
export async function verifyOrderPayment(
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; message: string; data?: VerifyPaymentResult }> {
  let res: Response;
  try {
    res = await fetch(
      `${serverConfig.backendUrl}/api/internal/storefront/orders/pay/verify`,
      {
        method: "POST",
        headers: {
          "x-internal-token": requireInternalToken(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      },
    );
  } catch {
    return { ok: false, message: "We could not reach the store. Try again." };
  }
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; message?: string; data?: VerifyPaymentResult }
    | null;
  return {
    ok: res.ok && body?.success === true,
    message: body?.message ?? "Verification failed.",
    data: body?.data,
  };
}

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
  mode: "login" | "register",
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; message: string; token?: string }> {
  let res: Response;
  try {
    res = await fetch(
      `${serverConfig.backendUrl}/api/internal/storefront/shoppers/${mode}`,
      {
        method: "POST",
        headers: {
          "x-internal-token": requireInternalToken(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      },
    );
  } catch {
    return { ok: false, message: "We could not reach the store. Try again." };
  }
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; message?: string; data?: { token?: string } }
    | null;
  return {
    ok: res.ok && body?.success === true,
    message: body?.message ?? "Sign-in failed.",
    token: body?.data?.token,
  };
}

export async function shopperMe(
  storefrontId: number,
  token: string,
): Promise<{ ok: boolean; message: string; data?: ShopperMe }> {
  let res: Response;
  try {
    res = await fetch(
      `${serverConfig.backendUrl}/api/internal/storefront/shoppers/me?storefrontId=${storefrontId}`,
      {
        headers: {
          "x-internal-token": requireInternalToken(),
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      },
    );
  } catch {
    return { ok: false, message: "We could not reach the store. Try again." };
  }
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; message?: string; data?: ShopperMe }
    | null;
  return {
    ok: res.ok && body?.success === true,
    message: body?.message ?? "Could not load the account.",
    data: body?.data,
  };
}
