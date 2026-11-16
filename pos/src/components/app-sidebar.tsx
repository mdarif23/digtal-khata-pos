import { useState } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { navigation } from "@/config/navigation";
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  CreditCard,
  ExternalLink,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  MapPin,
  Moon,
  RefreshCw,
  Settings,
  Sun,
  User,
  Zap,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { Link, useLocation } from "react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Avatar, AvatarBadge, AvatarFallback } from "./ui/avatar";
import { getSessionUser, logout } from "@/api/axios";
import { usePermissions } from "@/hooks/usePermissions";
import { LocationSwitcher } from "./common/LocationSwitcher";
import { useTheme } from "@/components/theme-provider";
import { useSessionStore } from "@/auth/sessionStore";
import { useTranslation } from "react-i18next";
import { setAppLanguage } from "@/i18n/language";
import { useCrossTabLanguage } from "@/i18n/LanguageToggle";
import { useCurrentBusinessSubscription } from "@/features/subscriptions/hooks/useSubscription";
import { formatDate } from "@/lib/format";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  return parts
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

function subscriptionStatusLabel(status: string): string {
  if (status === "trialing") return "Trial";
  return status
    .replaceAll("_", " ")
    .replace(/^\w/, (firstLetter) => firstLetter.toUpperCase());
}

/**
 * Match a nav URL against the current location, including query strings —
 * report sub-items live on `/reports?tab=…`, which plain pathname equality
 * never matches. A query-less URL only matches when the search is empty so
 * "All Reports Hub" (/reports) and the tab items don't highlight together.
 */
function isNavActive(url: string, pathname: string, search: string): boolean {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) {
    return pathname === url && search === "";
  }
  return pathname === url.slice(0, queryIndex) && search === url.slice(queryIndex);
}

export function AppSidebar() {
  const location = useLocation();
  const user = getSessionUser();
  const displayName = user?.fullName?.trim() || user?.email || "Signed in";
  const roleName = user?.roleName ?? user?.roleSlug ?? "Staff";
  const { hasPermission, hasAnyPermission, roleSlug } = usePermissions();
  const { theme, setTheme } = useTheme();
  const activeLocationName = useSessionStore(
    (state) => state.activeLocationName,
  );
  const { i18n } = useTranslation();
  const language = i18n.language === "bn" ? "bn" : "en";
  const canViewBusinessPlan = roleSlug === "owner" || hasPermission("*");
  const subscriptionQuery =
    useCurrentBusinessSubscription(canViewBusinessPlan);
  useCrossTabLanguage();
  const websiteUrl =
    import.meta.env.VITE_WEBSITE_URL || "http://localhost:3001";

  // Hide nav entries the active role set cannot open. Backend permissions
  // remain the real gate — this only shapes the interface.
  const visibleNavigation = navigation.filter((item) => {
    if (item.permission && !hasPermission(item.permission)) return false;
    if (item.anyPermission && !hasAnyPermission(item.anyPermission)) {
      return false;
    }
    if (item.items) {
      const visibleItems = item.items.filter((subItem) => {
        if (
          "permission" in subItem &&
          subItem.permission &&
          !hasPermission(subItem.permission)
        ) {
          return false;
        }
        if (
          "anyPermission" in subItem &&
          subItem.anyPermission &&
          !hasAnyPermission(subItem.anyPermission)
        ) {
          return false;
        }
        return true;
      });
      return visibleItems.length > 0;
    }
    return true;
  });
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  return (
    <Sidebar variant="inset">
      <SidebarHeader className="bg-sidebar-accent border-b border-sidebar-border rounded mb-2">
        <div className="flex items-center gap-2 px-4 py-3 justify-center">
          {/* The Logo Box — brand mark stays ezPos green (primary is action-blue) */}
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground shadow-sm">
            <Zap className="size-4" />
          </div>
          {/* The Text */}
          <div className="flex flex-col text-left leading-none">
            <span className="text-base font-bold tracking-tight">ez Pos</span>
            <span className="text-[10px] font-medium text-muted-foreground">
              Point of Sale
            </span>
          </div>
        </div>
        <LocationSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu>
          {visibleNavigation.map((item) => {
            if (!item) return null;
            const Icon = item.icon;
            if (!item.items) {
              return (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    isActive={isNavActive(item.url, location.pathname, location.search)}
                    tooltip={item.title}
                    render={<Link to={item.url} />}
                    size="lg"
                  >
                    <Icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            }
            const hasActiveChild = item.items.some(
              (subItem) => isNavActive(subItem.url, location.pathname, location.search),
            );

            return (
              <Collapsible
                open={openGroups[item.title] ?? hasActiveChild}
                onOpenChange={(open) =>
                  setOpenGroups((current) => ({
                    ...current,
                    [item.title]: open,
                  }))
                }
                key={item.title}
                className="group/collapsible"
              >
                <SidebarMenuItem>
                  <CollapsibleTrigger
                    render={
                      <SidebarMenuButton
                        tooltip={item.title}
                        size="lg"
                        isActive={hasActiveChild}
                      >
                        <Icon />

                        <span>{item.title}</span>

                        <ChevronRight className="ml-auto transition-transform group-data-open/collapsible:rotate-90" />
                      </SidebarMenuButton>
                    }
                  />

                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {item.items
                        .filter((subItem) => {
                          if (
                            "permission" in subItem &&
                            subItem.permission &&
                            !hasPermission(subItem.permission)
                          ) {
                            return false;
                          }
                          if (
                            "anyPermission" in subItem &&
                            subItem.anyPermission &&
                            !hasAnyPermission(subItem.anyPermission)
                          ) {
                            return false;
                          }
                          return true;
                        })
                        .map((subItem) => (
                        <SidebarMenuSubItem key={subItem.title}>
                          <SidebarMenuSubButton
                            isActive={isNavActive(subItem.url, location.pathname, location.search)}
                            render={<Link to={subItem.url} />}
                            size="md"
                          >
                            <span>{subItem.title}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            );
          })}
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
                <Avatar>
                  <AvatarFallback>{initialsOf(displayName)}</AvatarFallback>
                  <AvatarBadge className="bg-green-600 dark:bg-green-800" />
                </Avatar>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate">{displayName}</span>
                  <span className="text-gray-500 truncate">
                    {user?.roleName ?? user?.roleSlug ?? ""}
                  </span>
                </div>
                <ChevronsUpDown className="ml-auto" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{displayName}</DropdownMenuLabel>
                  <div className="px-2 pb-2 text-xs text-muted-foreground">
                    <div>{roleName}</div>
                    <div className="mt-1 flex items-center gap-1">
                      <MapPin className="size-3.5" />
                      <span>{activeLocationName ?? "No active location"}</span>
                    </div>
                  </div>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                {canViewBusinessPlan && (
                  <>
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Business plan</DropdownMenuLabel>
                      {subscriptionQuery.isPending ? (
                        <div className="px-2 pb-2 text-xs text-muted-foreground">
                          Loading subscription…
                        </div>
                      ) : subscriptionQuery.isError ? (
                        <div className="space-y-1 px-2 pb-2 text-xs text-destructive">
                          <p role="alert">Could not load subscription details.</p>
                          <DropdownMenuItem
                            onClick={() => void subscriptionQuery.refetch()}
                          >
                            <RefreshCw className="size-3" />
                            Retry
                          </DropdownMenuItem>
                        </div>
                      ) : subscriptionQuery.data ? (
                        <div className="px-2 pb-2 text-xs">
                          <div className="font-medium">
                            {subscriptionQuery.data.planName}
                            <span className="ml-1.5 font-normal capitalize text-muted-foreground">
                              {" · "}
                              {subscriptionStatusLabel(
                                subscriptionQuery.data.status,
                              )}
                            </span>
                          </div>
                          <p className="mt-1 text-muted-foreground">
                            {subscriptionQuery.data.cancelAtPeriodEnd
                              ? "Ends"
                              : subscriptionQuery.data.status === "trialing"
                                ? "Trial ends"
                                : subscriptionQuery.data.status === "active"
                                  ? "Renews"
                                  : "Period ends"}{" "}
                            {formatDate(subscriptionQuery.data.currentPeriodEnd)}
                          </p>
                        </div>
                      ) : (
                        <div className="px-2 pb-2 text-xs text-muted-foreground">
                          No subscription found.
                        </div>
                      )}
                      <DropdownMenuItem
                        render={
                          <a
                            href={`${websiteUrl}/account/subscription`}
                            target="_blank"
                            rel="noreferrer"
                          />
                        }
                      >
                        <CreditCard />
                        Manage subscription
                        <ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Appearance</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    aria-label="Appearance"
                    value={theme}
                    onValueChange={(value) => {
                      if (value === "light" || value === "dark") {
                        setTheme(value);
                      }
                    }}
                  >
                    <DropdownMenuRadioItem value="light">
                      <Sun />
                      Light
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark">
                      <Moon />
                      Dark
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Language</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    aria-label="Language"
                    value={language}
                    onValueChange={(value) => {
                      if (value === "en" || value === "bn") {
                        void setAppLanguage(value);
                      }
                    }}
                  >
                    <DropdownMenuRadioItem value="en">
                      English
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="bn">
                      বাংলা
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void logout()}>
                  <LockKeyhole />
                  Lock / Switch user
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void logout()}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
