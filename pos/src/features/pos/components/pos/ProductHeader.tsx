import { useEffect, useRef } from "react";
import { useHotkeyAction } from "../../hotkeys/hotkeyBus";
import { Link } from "react-router";
import { ArrowUpRight, Barcode, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ProductHeader({
  searchProducts,
  setSearchProducts,
  onScan,
}: {
  searchProducts: string;
  setSearchProducts: (value: string) => void;
  onScan: (code: string) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);

  // Phase 3 hotkeys: F1 (product search) and F8 (barcode focus) land here.
  useHotkeyAction("product-search", () => searchRef.current?.focus());
  useHotkeyAction("barcode-focus", () => searchRef.current?.focus());

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      const isTyping =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      const isSearchShortcut =
        (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";

      if (isSearchShortcut || (event.key === "/" && !isTyping)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  return (
    <header className="shrink-0 space-y-4 border-b px-4 py-4 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-lg font-bold text-white shadow-sm">
            P
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
              Point of sale
            </h1>
            <p className="hidden text-xs text-muted-foreground sm:block">
              Find a product or scan its barcode
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          aria-label="Open dashboard"
          render={
            <Link to="/dashboard">
              <span className="hidden sm:inline">Dashboard</span>
              <ArrowUpRight data-icon="inline-end" />
            </Link>
          }
          className="shrink-0"
        />
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          value={searchProducts}
          onChange={(event) => setSearchProducts(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && searchProducts.trim()) {
              event.preventDefault();
              onScan(searchProducts.trim());
            }
          }}
          className="h-11 pl-10 pr-24"
          type="search"
          placeholder="Search products..."
          aria-label="Search products by name, SKU, or barcode"
        />
        <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Barcode className="size-4" />
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans">/</kbd>
          <span className="hidden sm:inline">to search</span>
        </div>
      </div>
    </header>
  );
}
