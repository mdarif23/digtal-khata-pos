"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CreditCard,
  Globe,
  LayoutDashboard,
  LifeBuoy,
  Package,
  Receipt,
  Settings,
  Store,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/auth-provider";

const NAV = [
  { href: "/account", label: "Overview", icon: Store },
  { href: "/account/orders", label: "Orders", icon: Package },
  { href: "/account/online-store", label: "Online store", icon: Globe },
  { href: "/dashboard", label: "Business dashboard", icon: LayoutDashboard, external: true },
  { href: "/account/subscription", label: "Subscription", icon: CreditCard },
  { href: "/account/billing", label: "Billing", icon: Receipt },
  { href: "/account/settings", label: "Settings", icon: Settings },
  { href: "/account/support", label: "Support", icon: LifeBuoy },
] as const;

export function AccountShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status } = useAuth();

  useEffect(() => {
    if (status === "anonymous") router.replace("/sign-in");
  }, [status, router]);

  if (status !== "authenticated") {
    return (
      <p className="py-24 text-center text-sm text-slate-500" role="status">
        {status === "loading" ? "Loading your account…" : "Redirecting…"}
      </p>
    );
  }

  return (
    <div className="py-10 sm:py-14">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
          <nav aria-label="Account navigation">
            <ul className="flex gap-1 overflow-x-auto lg:flex-col">
              {NAV.map((item) => {
                const active =
                  "external" in item
                    ? false
                    : item.href === "/account"
                      ? pathname === "/account"
                      : pathname.startsWith(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        active
                          ? "bg-indigo-50 text-indigo-700"
                          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                      )}
                    >
                      <item.icon className="size-4" aria-hidden="true" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div>{children}</div>
        </div>
      </div>
    </div>
  );
}
