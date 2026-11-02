import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTenant } from "@/lib/tenant";


export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const tenant = await getTenant();
  const page = tenant?.config.pages.find((p) => p.slug === slug);
  if (!page) return { title: "Page not found" };
  return {
    title: page.seoTitle || page.title,
    description: page.seoDescription ?? undefined,
  };
}

/**
 * Customer-managed content pages (About, policies…). Blocks are validated
 * structured data from the backend — React escapes all text, and no block
 * type can carry raw HTML/JS.
 */
// Client-rendered per tenant — excluded from prerender.
export const instant = false;

export default async function ContentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tenant = await getTenant();
  if (!tenant) return null;
  const page = tenant.config.pages.find((p) => p.slug === slug);
  if (!page) notFound();
  const blocks = page.blocks ?? [];

  return (
    <article
      className="mx-auto px-4 py-10"
      style={{ maxWidth: "var(--sf-container)" }}
    >
      <h1 className="text-3xl font-bold">{page.title}</h1>
      <div className="mt-6 space-y-5">
        {blocks.map((block, index) => {
          const type = String(block.type ?? "");
          if (type === "heading") {
            const level = Math.min(4, Math.max(1, Number(block.level ?? 2)));
            const Tag = (`h${level + 1}` as "h2" | "h3" | "h4" | "h5");
            return (
              <Tag key={index} className="text-xl font-semibold">
                {String(block.text ?? "")}
              </Tag>
            );
          }
          if (type === "paragraph") {
            return (
              <p key={index} className="whitespace-pre-line text-sm leading-relaxed opacity-85">
                {String(block.text ?? "")}
              </p>
            );
          }
          if (type === "image") {
            const url = String(block.url ?? "");
            if (!url) return null;
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={index}
                src={url}
                alt={String(block.alt ?? page.title)}
                className="w-full rounded-xl"
                loading="lazy"
              />
            );
          }
          if (type === "faq" && Array.isArray(block.items)) {
            return (
              <div key={index} className="space-y-3">
                {(block.items as Array<Record<string, unknown>>).map((item, faqIndex) => (
                  <details key={faqIndex} className="sf-card p-4">
                    <summary className="cursor-pointer text-sm font-semibold">
                      {String(item.question ?? "")}
                    </summary>
                    <p className="mt-2 text-sm opacity-80">{String(item.answer ?? "")}</p>
                  </details>
                ))}
              </div>
            );
          }
          if (type === "contact") {
            const contact = tenant.config.storefront.contact;
            return (
              <div key={index} className="sf-card p-5 text-sm">
                {contact?.phone ? <p>Phone: {contact.phone}</p> : null}
                {contact?.email ? <p>Email: {contact.email}</p> : null}
                {contact?.address ? <p>Address: {contact.address}</p> : null}
              </div>
            );
          }
          return null;
        })}
        {blocks.length === 0 ? (
          <p className="text-sm opacity-60">This page has no content yet.</p>
        ) : null}
      </div>
    </article>
  );
}
