import type { Metadata } from "next";

/**
 * Metadata for an indexable public page: title/description plus a canonical
 * URL and matching Open Graph values. Paths resolve against the metadataBase
 * declared in the root layout.
 */
export function publicMetadata(
  path: string,
  title: string,
  description: string,
): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title, description, url: path },
  };
}
