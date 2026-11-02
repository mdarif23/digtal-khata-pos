"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  Building2,
  CreditCard,
  LayoutDashboard,
  LifeBuoy,
  Package,
  Plug,
  Receipt,
  Settings,
  Store,
  Webhook,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/auth-provider";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import {
  fetchNotifications,
  markAllNotificationsRead,
  type PortalNotification,
} from "@/lib/api/notifications";

const NAV = [
  { href: "/account", label: "Overview", icon: Store },
  { href: "/account/orders", label: "Orders", icon: Package },
  { href: "/dashboard", label: "Business dashboard", icon: LayoutDashboard, external: true },
  { href: "/account/subscription", label: "Subscription", icon: CreditCard },
  { href: "/account/billing", label: "Billing", icon: Receipt },
  { href: "/account/integrations", label: "Integrations", icon: Plug },
  { href: "/account/webhooks", label: "Webhooks", icon: Webhook },
  { href: "/account/settings", label: "Settings", icon: Settings },
  { href: "/account/support", label: "Support", icon: LifeBuoy },
] as const;

export function AccountShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status } = useAuth();
  const { businesses, businessId, switchBusiness } = useActiveBusiness();
  const [notifications, setNotifications] = useState<PortalNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);

  const loadNotifications = useCallback(async () => {
    if (!businessId) return;
    const result = await fetchNotifications(businessId);
    if (result.ok && result.data) {
      setNotifications(result.data.notifications);
      setUnreadCount(result.data.unreadCount);
    }
  }, [businessId]);

  useEffect(() => {
    void (async () => {
      await loadNotifications();
    })();
    // Keep the unread badge current without a page reload; skipped while the
    // tab is hidden to avoid background traffic.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadNotifications();
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [loadNotifications]);

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
        {businessId ? (
          <div className="relative mb-6 flex justify-end">
            <button
              type="button"
              aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ""}`}
              className="relative flex size-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              onClick={() => setPanelOpen((v) => !v)}
            >
              <Bell className="size-4.5" aria-hidden="true" />
              {unreadCount > 0 ? (
                <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-semibold text-white">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              ) : null}
            </button>
            {panelOpen ? (
              <div className="absolute right-4 top-12 z-30 w-80 rounded-2xl border border-slate-200 bg-white shadow-lg sm:right-8 lg:right-24">
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
                  <p className="text-sm font-semibold text-slate-900">
                    Notifications
                  </p>
                  {unreadCount > 0 ? (
                    <button
                      type="button"
                      className="text-xs font-medium text-indigo-700 hover:underline"
                      onClick={() => {
                        void (async () => {
                          await markAllNotificationsRead(businessId);
                          await loadNotifications();
                        })();
                      }}
                    >
                      Mark all read
                    </button>
                  ) : null}
                </div>
                {notifications.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-slate-500">
                    Nothing yet — order and account events appear here.
                  </p>
                ) : (
                  <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
                    {notifications.map((notification) => (
                      <li
                        key={notification.id}
                        className={
                          notification.readAt
                            ? "px-4 py-3 text-sm"
                            : "bg-indigo-50/40 px-4 py-3 text-sm"
                        }
                      >
                        <p className="font-medium text-slate-900">
                          {notification.title}
                        </p>
                        {notification.body ? (
                          <p className="mt-0.5 text-xs text-slate-600">
                            {notification.body}
                          </p>
                        ) : null}
                        <p className="mt-1 text-[10px] uppercase tracking-wide text-slate-400">
                          {new Date(notification.createdAt).toLocaleString()}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {businesses.length > 1 ? (
          <div className="mb-6 flex items-center gap-2 text-sm">
            <Building2
              className="size-4 shrink-0 text-slate-400"
              aria-hidden="true"
            />
            <label htmlFor="business-switcher" className="text-slate-500">
              Business:
            </label>
            <select
              id="business-switcher"
              value={businessId ?? ""}
              onChange={(event) => switchBusiness(Number(event.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 shadow-sm"
            >
              {businesses.map((b) => (
                <option key={b.businessId} value={b.businessId}>
                  {b.businessName}
                </option>
              ))}
            </select>
          </div>
        ) : null}
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
