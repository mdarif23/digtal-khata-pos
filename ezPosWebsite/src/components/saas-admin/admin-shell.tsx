"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  CreditCard,
  LayoutDashboard,
  LifeBuoy,
  Receipt,
  ScrollText,
  Tag,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/auth-provider";

const NAV = [
  { href: "/saas-admin", label: "Overview", icon: LayoutDashboard },
  { href: "/saas-admin/businesses", label: "Businesses", icon: Building2 },
  { href: "/saas-admin/subscriptions", label: "Subscriptions", icon: CreditCard },
  { href: "/saas-admin/payments", label: "Payments", icon: Receipt },
  { href: "/saas-admin/plans", label: "Plans", icon: Tag },
  { href: "/saas-admin/support", label: "Support", icon: LifeBuoy },
  { href: "/saas-admin/audit-logs", label: "Audit logs", icon: ScrollText },
] as const;

export function SaasAdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, user } = useAuth();

  useEffect(() => {
    if (status === "anonymous") router.replace("/sign-in");
  }, [status, router]);

  if (status !== "authenticated") {
    return (
      <p className="py-24 text-center text-sm text-slate-500" role="status">
        {status === "loading" ? "Checking access…" : "Redirecting…"}
      </p>
    );
  }

  if (user?.platformRole !== "platform_admin") {
    return (
      <p className="py-24 text-center text-sm text-slate-500">
        Platform administrator access is required.
      </p>
    );
  }

  return (
    <div className="py-10 sm:py-14">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
              ezPos SaaS
            </p>
            <h1 className="text-lg font-semibold tracking-tight text-slate-900">
              Admin panel
            </h1>
          </div>
          <Link href="/" className="text-sm font-medium text-slate-500 hover:text-indigo-700">
            ← Public site
          </Link>
        </div>
        <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
          <nav aria-label="Admin navigation">
            <ul className="flex gap-1 overflow-x-auto lg:flex-col">
              {NAV.map((item) => {
                const active =
                  item.href === "/saas-admin"
                    ? pathname === "/saas-admin"
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
