import type { MetadataRoute } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Auth-gated and API-adjacent surfaces stay out of search indexes.
      disallow: [
        "/account",
        "/dashboard",
        "/onboarding",
        "/admin",
        "/api/",
        "/sign-in",
        "/sign-up",
        "/verify-email",
        "/forgot-password",
        "/reset-password",
        "/payment/",
      ],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
