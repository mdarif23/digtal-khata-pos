import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { fetchTenantConfig } from "@/lib/backend";


/** Per-tenant robots.txt honoring the store's indexing preference. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const headerList = await headers();
  const storefrontId = Number(headerList.get("x-storefront-id") ?? "");
  const tenant =
    Number.isInteger(storefrontId) && storefrontId > 0
      ? await fetchTenantConfig(storefrontId)
      : null;

  const indexing = tenant?.available && tenant.storefront.flags.searchIndexingEnabled;
  return {
    rules: indexing
      ? [
          {
            userAgent: "*",
            allow: "/",
            disallow: ["/api/", "/cart", "/checkout", "/orders/"],
          },
        ]
      : [{ userAgent: "*", disallow: "/" }],
  };
}
