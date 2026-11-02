import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { fetchTenantConfig } from "@/lib/backend";
import { serverConfig } from "@/lib/config";


/**
 * Per-tenant sitemap — only this tenant's URLs, never another store's.
 * Empty when indexing is disabled or the host is unknown.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const headerList = await headers();
  const host = (headerList.get("host") ?? "").toLowerCase().split(":")[0] ?? "";
  const storefrontId = Number(headerList.get("x-storefront-id") ?? "");
  if (!Number.isInteger(storefrontId) || storefrontId <= 0) return [];

  const tenant = await fetchTenantConfig(storefrontId);
  if (!tenant?.available || !tenant.storefront.flags.searchIndexingEnabled) {
    return [];
  }

  const proto = headerList.get("x-forwarded-proto") ?? "https";
  const origin = `${proto}://${host || `${tenant.storefront.subdomain}.${serverConfig.baseDomain}`}`;

  const entries: MetadataRoute.Sitemap = [
    { url: `${origin}/`, changeFrequency: "daily", priority: 1 },
    { url: `${origin}/products`, changeFrequency: "daily", priority: 0.9 },
    ...tenant.pages.map((page) => ({
      url: `${origin}/pages/${page.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.4,
    })),
  ];
  return entries;
}
