import type { MetadataRoute } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";

// Public marketing/legal pages only — account, dashboard, and admin routes
// are behind auth and excluded.
export default function sitemap(): MetadataRoute.Sitemap {
  const pages = [
    "",
    "/features",
    "/pricing",
    "/industries",
    "/about",
    "/contact",
    "/faq",
    "/developers",
    "/terms",
    "/privacy",
    "/refund-policy",
    "/subscription-billing-policy",
    "/cookie-policy",
    "/sign-in",
    "/sign-up",
  ];
  return pages.map((path) => ({
    url: `${siteUrl}${path}`,
    lastModified: new Date(),
    changeFrequency: path === "" || path === "/pricing" ? "weekly" : "monthly",
    priority: path === "" ? 1 : path === "/pricing" ? 0.9 : 0.6,
  }));
}
