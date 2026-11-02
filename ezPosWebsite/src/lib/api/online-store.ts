"use client";

/**
 * Customer-portal client for the hosted storefront platform
 * ("Online Store" section, website platform stage 2).
 * Mirrors ezPosBackend/src/modules/storefronts — all routes are
 * business-scoped via the X-Business-Id header.
 */
import { API_BASE, getAccessToken, SERVER_UNREACHABLE_MESSAGE } from "@/lib/api/auth";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  message: string;
  data?: T;
}

async function request<T>(
  path: string,
  init: RequestInit & { businessId?: number } = {},
): Promise<ApiResult<T>> {
  const { businessId, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Content-Type", "application/json");
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (businessId !== undefined) {
    headers.set("X-Business-Id", String(businessId));
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...rest, headers });
  } catch {
    return { ok: false, status: 0, message: SERVER_UNREACHABLE_MESSAGE };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  let data: unknown = body;
  let message: string;
  if (body && typeof body === "object" && "success" in body) {
    if ("data" in body) data = body.data;
    message =
      (body.message as string | undefined) ??
      (res.ok ? "Done." : "Something went wrong.");
  } else {
    message = res.ok ? "Done." : "Something went wrong.";
  }
  return {
    ok: res.ok,
    status: res.status,
    message,
    data: (data ?? undefined) as T | undefined,
  };
}

/** Public origin shoppers use for tenant subdomains. */
export const STOREFRONT_BASE_DOMAIN =
  process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN?.trim() || "ezpos.store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StorefrontStatus =
  | "draft"
  | "preview"
  | "published"
  | "suspended"
  | "archived";

export interface StorefrontSummary {
  id: number;
  name: string;
  subdomain: string;
  status: StorefrontStatus;
  themeId: string;
  publishedVersionId: number | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  publishedProductCount: number;
}

export interface StorefrontDomainRow {
  id: number;
  kind: "subdomain" | "custom";
  domain: string;
  status: "pending" | "verified" | "failed" | "removed";
  sslStatus: "pending" | "issued" | "failed";
  isPrimary: boolean;
  verificationToken?: string | null;
  lastError?: string | null;
  lastCheckedAt?: string | null;
  createdAt: string;
}

export interface StorefrontDetail {
  id: number;
  businessId: number;
  name: string;
  subdomain: string;
  status: StorefrontStatus;
  themeId: string;
  draftConfig: Record<string, unknown>;
  publishedVersionId: number | null;
  seo: { title?: string; description?: string; ogImageMediaId?: number } | null;
  contact: Record<string, unknown> | null;
  storePickupEnabled: boolean;
  analyticsEnabled: boolean;
  searchIndexingEnabled: boolean;
  shopperAccountsEnabled: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  domains: StorefrontDomainRow[];
  publishedVersionNumber: number | null;
  publishedProductCount?: number;
}

export interface StorefrontVersion {
  id: number;
  versionNumber: number;
  themeId: string;
  publishedAt: string;
  publishedByUserId: number | null;
}

export interface ThemeCatalogItem {
  id: string;
  name: string;
  category: string;
  description: string;
  premium: boolean;
}

export interface StorefrontPageRow {
  id: number;
  storefrontId: number;
  slug: string;
  title: string;
  blocks: Array<Record<string, unknown>>;
  seoTitle: string | null;
  seoDescription: string | null;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VisibilityRow {
  visibilityId: number;
  productId: number;
  productName: string;
  productStatus: string | null;
  published: boolean;
  featured: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  websiteImageUrls: string[] | null;
  sortOrder: number;
}

export interface ProductRow {
  id: number;
  name: string;
  status: string | null;
  variants?: Array<{
    id: number;
    sku: string | null;
    sellingPrice: number;
    isDefault: boolean;
    status: string | null;
    quantity?: number | null;
  }>;
}

export interface DeliveryZone {
  id: number;
  storefrontId: number;
  name: string;
  areas: string[];
  rate: string | number;
  freeThreshold: string | number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
  isActive: boolean;
}

export interface PaymentMethodRow {
  id: number;
  storefrontId: number;
  method: "cod" | "sslcommerz";
  enabled: boolean;
  config: Record<string, unknown>;
  label: string | null;
}

export interface MediaItem {
  id: number;
  businessId: number;
  objectKey: string;
  fileName: string;
  contentType: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  createdAt: string;
  publicUrl?: string;
}

export interface PresignResult {
  objectKey: string;
  uploadUrl: string;
  publicUrl: string;
  expiresIn: number;
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

export async function fetchThemes(): Promise<ApiResult<ThemeCatalogItem[]>> {
  return request("/api/storefront-themes", { method: "GET" });
}

// ---------------------------------------------------------------------------
// Storefronts
// ---------------------------------------------------------------------------

export async function fetchStorefronts(
  businessId: number,
): Promise<ApiResult<StorefrontSummary[]>> {
  return request(`/api/businesses/${businessId}/storefronts`, {
    method: "GET",
    businessId,
  });
}

export async function fetchStorefront(
  businessId: number,
  storefrontId: number,
): Promise<ApiResult<StorefrontDetail>> {
  return request(`/api/businesses/${businessId}/storefronts/${storefrontId}`, {
    method: "GET",
    businessId,
  });
}

export async function createStorefront(
  businessId: number,
  input: { name: string; themeId: string; subdomain?: string },
): Promise<ApiResult<StorefrontDetail>> {
  return request(`/api/businesses/${businessId}/storefronts`, {
    method: "POST",
    businessId,
    body: JSON.stringify(input),
  });
}

export async function updateStorefront(
  businessId: number,
  storefrontId: number,
  patch: {
    name?: string;
    seo?: { title?: string; description?: string } | null;
    contact?: Record<string, unknown> | null;
    storePickupEnabled?: boolean;
    analyticsEnabled?: boolean;
    searchIndexingEnabled?: boolean;
    shopperAccountsEnabled?: boolean;
  },
): Promise<ApiResult<StorefrontDetail>> {
  return request(`/api/businesses/${businessId}/storefronts/${storefrontId}`, {
    method: "PATCH",
    businessId,
    body: JSON.stringify(patch),
  });
}

export async function updateDraftConfig(
  businessId: number,
  storefrontId: number,
  draftConfig: unknown,
): Promise<ApiResult<StorefrontDetail>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/draft-config`,
    { method: "PATCH", businessId, body: JSON.stringify({ draftConfig }) },
  );
}

export async function archiveStorefront(
  businessId: number,
  storefrontId: number,
): Promise<ApiResult<unknown>> {
  return request(`/api/businesses/${businessId}/storefronts/${storefrontId}`, {
    method: "DELETE",
    businessId,
  });
}

export async function publishStorefront(
  businessId: number,
  storefrontId: number,
): Promise<ApiResult<{ versionNumber: number }>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/publish`,
    { method: "POST", businessId },
  );
}

export async function unpublishStorefront(
  businessId: number,
  storefrontId: number,
): Promise<ApiResult<unknown>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/unpublish`,
    { method: "POST", businessId },
  );
}

export async function fetchStorefrontVersions(
  businessId: number,
  storefrontId: number,
): Promise<ApiResult<StorefrontVersion[]>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/versions`,
    { method: "GET", businessId },
  );
}

export async function restoreStorefrontVersion(
  businessId: number,
  storefrontId: number,
  versionId: number,
): Promise<ApiResult<{ versionNumber: number }>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/versions/${versionId}/restore`,
    { method: "POST", businessId },
  );
}

export async function changeSubdomain(
  businessId: number,
  storefrontId: number,
  subdomain: string,
): Promise<ApiResult<{ subdomain: string }>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/subdomain`,
    { method: "POST", businessId, body: JSON.stringify({ subdomain }) },
  );
}

export async function checkSubdomainAvailability(
  businessId: number,
  subdomain: string,
): Promise<ApiResult<{ subdomain: string; available: boolean; error: string | null }>> {
  return request(
    `/api/businesses/${businessId}/storefronts/subdomain-available?subdomain=${encodeURIComponent(subdomain)}`,
    { method: "GET", businessId },
  );
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export async function fetchDomains(
  businessId: number,
  storefrontId: number,
): Promise<ApiResult<StorefrontDomainRow[]>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/domains`,
    { method: "GET", businessId },
  );
}

export async function addDomain(
  businessId: number,
  storefrontId: number,
  domain: string,
): Promise<ApiResult<StorefrontDomainRow>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/domains`,
    { method: "POST", businessId, body: JSON.stringify({ domain }) },
  );
}

export async function verifyDomain(
  businessId: number,
  storefrontId: number,
  domainId: number,
): Promise<ApiResult<StorefrontDomainRow>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/domains/${domainId}/verify`,
    { method: "POST", businessId },
  );
}

export async function makeDomainPrimary(
  businessId: number,
  storefrontId: number,
  domainId: number,
): Promise<ApiResult<unknown>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/domains/${domainId}/make-primary`,
    { method: "POST", businessId },
  );
}

export async function removeDomain(
  businessId: number,
  storefrontId: number,
  domainId: number,
): Promise<ApiResult<unknown>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/domains/${domainId}`,
    { method: "DELETE", businessId },
  );
}

// ---------------------------------------------------------------------------
// Content pages
// ---------------------------------------------------------------------------

export async function fetchPages(
  businessId: number,
  storefrontId: number,
): Promise<ApiResult<StorefrontPageRow[]>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/pages`,
    { method: "GET", businessId },
  );
}

export async function createPage(
  businessId: number,
  storefrontId: number,
  input: {
    slug: string;
    title: string;
    blocks: Array<Record<string, unknown>>;
    seoTitle?: string;
    seoDescription?: string;
    isPublished?: boolean;
  },
): Promise<ApiResult<StorefrontPageRow>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/pages`,
    { method: "POST", businessId, body: JSON.stringify(input) },
  );
}

export async function updatePage(
  businessId: number,
  storefrontId: number,
  pageId: number,
  patch: {
    title?: string;
    blocks?: Array<Record<string, unknown>>;
    seoTitle?: string | null;
    seoDescription?: string | null;
    isPublished?: boolean;
  },
): Promise<ApiResult<StorefrontPageRow>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/pages/${pageId}`,
    { method: "PATCH", businessId, body: JSON.stringify(patch) },
  );
}

export async function deletePage(
  businessId: number,
  storefrontId: number,
  pageId: number,
): Promise<ApiResult<unknown>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/pages/${pageId}`,
    { method: "DELETE", businessId },
  );
}

// ---------------------------------------------------------------------------
// Product visibility
// ---------------------------------------------------------------------------

export async function fetchVisibility(
  businessId: number,
  storefrontId: number,
): Promise<ApiResult<VisibilityRow[]>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/products`,
    { method: "GET", businessId },
  );
}

export async function upsertVisibility(
  businessId: number,
  storefrontId: number,
  productId: number,
  patch: {
    published?: boolean;
    featured?: boolean;
    seoTitle?: string | null;
    seoDescription?: string | null;
    sortOrder?: number;
  },
): Promise<ApiResult<VisibilityRow>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/products/${productId}`,
    { method: "PUT", businessId, body: JSON.stringify(patch) },
  );
}

export async function deleteVisibility(
  businessId: number,
  storefrontId: number,
  productId: number,
): Promise<ApiResult<unknown>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/products/${productId}`,
    { method: "DELETE", businessId },
  );
}

/** Catalog picker source (same endpoint the POS uses; cost fields stripped server-side). */
export async function fetchProducts(
  businessId: number,
): Promise<ApiResult<ProductRow[]>> {
  return request("/api/products", { method: "GET", businessId });
}

// ---------------------------------------------------------------------------
// Delivery zones
// ---------------------------------------------------------------------------

export async function fetchZones(
  businessId: number,
  storefrontId: number,
): Promise<ApiResult<DeliveryZone[]>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/delivery-zones`,
    { method: "GET", businessId },
  );
}

export async function createZone(
  businessId: number,
  storefrontId: number,
  input: {
    name: string;
    areas: string[];
    rate: number;
    freeThreshold?: number;
    estimatedDaysMin?: number;
    estimatedDaysMax?: number;
  },
): Promise<ApiResult<DeliveryZone>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/delivery-zones`,
    { method: "POST", businessId, body: JSON.stringify(input) },
  );
}

export async function updateZone(
  businessId: number,
  storefrontId: number,
  zoneId: number,
  patch: Partial<Parameters<typeof createZone>[2]> & { isActive?: boolean },
): Promise<ApiResult<DeliveryZone>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/delivery-zones/${zoneId}`,
    { method: "PATCH", businessId, body: JSON.stringify(patch) },
  );
}

export async function deleteZone(
  businessId: number,
  storefrontId: number,
  zoneId: number,
): Promise<ApiResult<unknown>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/delivery-zones/${zoneId}`,
    { method: "DELETE", businessId },
  );
}

// ---------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------

export async function fetchPaymentMethods(
  businessId: number,
  storefrontId: number,
): Promise<ApiResult<PaymentMethodRow[]>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/payment-methods`,
    { method: "GET", businessId },
  );
}

export async function updatePaymentMethods(
  businessId: number,
  storefrontId: number,
  methods: Array<{ method: "cod" | "sslcommerz"; enabled: boolean; label?: string }>,
): Promise<ApiResult<PaymentMethodRow[]>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/payment-methods`,
    { method: "PUT", businessId, body: JSON.stringify({ methods }) },
  );
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export async function fetchMedia(
  businessId: number,
): Promise<ApiResult<MediaItem[]>> {
  return request(`/api/businesses/${businessId}/storefronts/media`, {
    method: "GET",
    businessId,
  });
}

export async function presignMedia(
  businessId: number,
  input: { fileName: string; contentType: string; sizeBytes: number },
): Promise<ApiResult<PresignResult>> {
  return request(`/api/businesses/${businessId}/storefronts/media/presign`, {
    method: "POST",
    businessId,
    body: JSON.stringify(input),
  });
}

export async function registerMedia(
  businessId: number,
  input: {
    objectKey: string;
    fileName: string;
    contentType: string;
    bytes: number;
    width?: number;
    height?: number;
  },
): Promise<ApiResult<MediaItem>> {
  return request(`/api/businesses/${businessId}/storefronts/media/register`, {
    method: "POST",
    businessId,
    body: JSON.stringify(input),
  });
}

export async function deleteMedia(
  businessId: number,
  mediaId: number,
): Promise<ApiResult<unknown>> {
  return request(`/api/businesses/${businessId}/storefronts/media/${mediaId}`, {
    method: "DELETE",
    businessId,
  });
}

/**
 * Uploads a file to object storage via presigned PUT and registers it.
 * Returns the CDN/public URL to store in configs.
 */
export async function uploadMediaFile(
  businessId: number,
  file: File,
): Promise<ApiResult<MediaItem>> {
  const presign = await presignMedia(businessId, {
    fileName: file.name,
    contentType: file.type || "application/octet-stream",
    sizeBytes: file.size,
  });
  if (!presign.ok || !presign.data) {
    return { ok: presign.ok, status: presign.status, message: presign.message };
  }

  try {
    const upload = await fetch(presign.data.uploadUrl, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
    if (!upload.ok) {
      return {
        ok: false,
        status: upload.status,
        message: "Upload to storage failed. Please try again.",
      };
    }
  } catch {
    return {
      ok: false,
      status: 0,
      message: "Upload to storage failed. Please try again.",
    };
  }

  return registerMedia(businessId, {
    objectKey: presign.data.objectKey,
    fileName: file.name,
    contentType: file.type || "application/octet-stream",
    bytes: file.size,
  });
}

// ---------------------------------------------------------------------------
// Analytics (stage 6) — tracked metrics only
// ---------------------------------------------------------------------------

export interface StorefrontAnalytics {
  days: number;
  tracked: {
    visits: number;
    productViews: number;
    addToCarts: number;
    checkoutStarts: number;
  };
  orders: number;
  revenue: number;
  conversionRate: number | null;
  bestSellers: Array<{ productId: number; name: string; quantity: number }>;
  notes: string[];
}

export async function fetchStorefrontAnalytics(
  businessId: number,
  storefrontId: number,
  days = 30,
): Promise<ApiResult<StorefrontAnalytics>> {
  return request(
    `/api/businesses/${businessId}/storefronts/${storefrontId}/analytics?days=${days}`,
    { method: "GET", businessId },
  );
}
