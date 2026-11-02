import Link from "next/link";
import type { TenantConfig } from "@/lib/backend";

/** Storefront footer: tenant links, pages, contact, socials. */
export function Footer({ tenant }: { tenant: TenantConfig }) {
  const nav = tenant.storefront.config.navigation as
    | { footer?: Array<{ label: string; href: string }> }
    | undefined;
  const links = (nav?.footer ?? []).filter((link) => link.label && link.href);
  const contact = tenant.storefront.contact;
  const socials = contact?.social ?? {};

  return (
    <footer className="mt-16 border-t border-black/10 bg-white">
      <div
        className="mx-auto grid gap-8 px-4 py-10 sm:grid-cols-3"
        style={{ maxWidth: "var(--sf-container)" }}
      >
        <div>
          <p className="font-bold text-[var(--sf-text)]">{tenant.storefront.name}</p>
          {contact?.address ? (
            <p className="mt-2 text-sm opacity-75">{contact.address}</p>
          ) : null}
          {contact?.phone ? (
            <p className="mt-1 text-sm opacity-75">Phone: {contact.phone}</p>
          ) : null}
          {contact?.email ? (
            <p className="mt-1 text-sm opacity-75">Email: {contact.email}</p>
          ) : null}
        </div>

        <div>
          <p className="text-sm font-semibold uppercase tracking-wide opacity-60">Pages</p>
          <ul className="mt-2 space-y-1 text-sm">
            {tenant.pages.map((page) => (
              <li key={page.id}>
                <Link href={`/pages/${page.slug}`}>{page.title}</Link>
              </li>
            ))}
            <li>
              <Link href="/orders/track">Track your order</Link>
            </li>
          </ul>
        </div>

        <div>
          <p className="text-sm font-semibold uppercase tracking-wide opacity-60">Links</p>
          <ul className="mt-2 space-y-1 text-sm">
            {links.map((link) => (
              <li key={`${link.label}-${link.href}`}>
                {link.href.startsWith("/") ? (
                  <Link href={link.href}>{link.label}</Link>
                ) : (
                  <a href={link.href} rel="noopener noreferrer nofollow" target="_blank">
                    {link.label}
                  </a>
                )}
              </li>
            ))}
            {Object.entries(socials)
              .filter(([, url]) => typeof url === "string" && url)
              .map(([name, url]) => (
                <li key={name}>
                  <a
                    href={String(url)}
                    rel="noopener noreferrer nofollow"
                    target="_blank"
                    className="capitalize"
                  >
                    {name}
                  </a>
                </li>
              ))}
          </ul>
        </div>
      </div>
      <div className="border-t border-black/5 py-4 text-center text-xs opacity-50">
        <a href="https://ezpos.com" rel="noopener noreferrer">
          Powered by ezPos
        </a>
      </div>
    </footer>
  );
}
