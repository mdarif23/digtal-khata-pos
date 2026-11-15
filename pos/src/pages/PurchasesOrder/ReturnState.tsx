import { ArrowLeft, PackageMinus } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button.js";

/**
 * Guard screen for the purchase-return page (Phase 6 Feature 2, extracted
 * verbatim from PurchasesReturn.tsx).
 */
export function ReturnState({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex min-h-96 flex-col items-center justify-center px-6 text-center">
      <PackageMinus className="size-10 text-muted-foreground/50" />
      <h1 className="mt-4 text-xl font-semibold">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">{message}</p>
      <Button
        nativeButton={false}
        className="mt-5"
        variant="outline"
        render={<Link to="/purchases-list" />}
      >
        <ArrowLeft /> Back to purchase orders
      </Button>
    </div>
  );
}
