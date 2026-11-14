import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Standard list-search field with the leading magnifier and a clear button.
 * Replaces 17 hand-rolled copies of the same icon+`pl-9` recipe.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
  inputClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  inputClassName?: string;
}) {
  return (
    <div className={cn("relative w-full sm:max-w-xs", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? "Search..."}
        aria-label={ariaLabel ?? placeholder ?? "Search"}
        className={cn("pr-8 pl-9", inputClassName)}
      />
      {value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          onClick={() => onChange("")}
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}
