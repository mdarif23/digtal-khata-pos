import { cn } from "@/lib/utils";

/**
 * Standard page shell: consistent outer padding and a centered max-width
 * column with vertical rhythm between sections. Replaces the six competing
 * page-container conventions (`max-w-5xl/6xl/7xl/[1600px]/[1800px]`/none).
 */
export function PageContainer({
  children,
  className,
  /** "narrow" for settings/detail pages, "wide" for dense data tables. */
  width = "default",
}: {
  children: React.ReactNode;
  className?: string;
  width?: "narrow" | "default" | "wide" | "full";
}) {
  const maxWidth =
    width === "narrow"
      ? "max-w-5xl"
      : width === "wide"
        ? "max-w-[1800px]"
        : width === "full"
          ? ""
          : "max-w-[1600px]";
  return (
    <div
      className={cn(
        "mx-auto w-full space-y-6 p-4 md:p-6",
        maxWidth,
        className,
      )}
    >
      {children}
    </div>
  );
}
