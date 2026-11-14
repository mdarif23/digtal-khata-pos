import { useMemo } from "react";
import { useLocation } from "react-router";
import { navigation } from "@/config/navigation";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

/**
 * Resolve the current page's title from the sidebar navigation config so the
 * header always names where you are — including report tabs that live on
 * query strings (`/reports?tab=profit`). Falls back to a humanized path
 * segment for drill-downs that have no nav entry.
 */
function resolveTitle(pathname: string, search: string): string {
  const withQuery = (url: string) => {
    const queryIndex = url.indexOf("?");
    if (queryIndex === -1) return null;
    return {
      path: url.slice(0, queryIndex),
      search: url.slice(queryIndex),
    };
  };

  for (const item of navigation) {
    if (item.items) {
      for (const subItem of item.items) {
        if (subItem.url === pathname && search === "") return subItem.title;
        const query = withQuery(subItem.url);
        if (query && query.path === pathname && query.search === search) {
          return subItem.title;
        }
      }
      continue;
    }
    if ("url" in item && item.url === pathname && search === "") {
      return item.title;
    }
  }

  const segment = pathname.split("/").filter(Boolean).pop();
  if (!segment) return "ezPos";
  return segment
    .replace(/[-:]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function AppHeader() {
  const location = useLocation();
  const title = useMemo(
    () => resolveTitle(location.pathname, location.search),
    [location.pathname, location.search],
  );

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur">
      <SidebarTrigger aria-label="Toggle sidebar" />
      <Separator orientation="vertical" className="mr-1 h-5" />
      <span className="truncate text-sm font-medium text-muted-foreground">
        {title}
      </span>
    </header>
  );
}
