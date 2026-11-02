"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useCart } from "./cart-context";
import type { TenantConfig } from "@/lib/backend";

/**
 * Storefront header: store name (logo upload arrives with advanced
 * customization), tenant navigation links, search and cart.
 */
export function Header({ tenant }: { tenant: TenantConfig }) {
  const { count } = useCart();
  const pathname = usePathname();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const nav = tenant.storefront.config.navigation as
    | { header?: Array<{ label: string; href: string }> }
    | undefined;
  const links = (nav?.header ?? []).filter((link) => link.label && link.href);

  return (
    <header className="border-b border-black/10 bg-white">
      <div
        className="mx-auto flex flex-wrap items-center gap-4 px-4 py-3"
        style={{ maxWidth: "var(--sf-container)" }}
      >
        <Link href="/" className="text-lg font-bold text-[var(--sf-text)]">
          {tenant.storefront.name}
        </Link>

        <form
          className="order-last flex w-full gap-2 sm:order-none sm:w-auto sm:flex-1 sm:max-w-sm"
          onSubmit={(event) => {
            event.preventDefault();
            router.push(
              search.trim() ? `/products?search=${encodeURIComponent(search.trim())}` : "/products",
            );
          }}
        >
          <input
            className="sf-input"
            placeholder="Search products…"
            aria-label="Search products"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button type="submit" className="sf-btn-outline shrink-0">
            Search
          </button>
        </form>

        <nav aria-label="Store" className="ml-auto flex items-center gap-4 text-sm">
          <ul className="hidden items-center gap-4 md:flex">
            <li>
              <Link
                href="/products"
                className={pathname === "/products" ? "font-semibold text-[var(--sf-primary)]" : ""}
              >
                Shop
              </Link>
            </li>
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
          </ul>
          <Link href="/cart" className="relative font-medium" aria-label={`Cart (${count} items)`}>
            Cart
            {count > 0 ? (
              <span className="ml-1 inline-flex min-w-5 justify-center rounded-full bg-[var(--sf-primary)] px-1.5 text-[11px] font-bold text-white">
                {count}
              </span>
            ) : null}
          </Link>
        </nav>
      </div>
    </header>
  );
}
