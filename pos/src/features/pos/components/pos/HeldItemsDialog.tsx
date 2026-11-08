import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  resumeHeldItems,
  useCartStore,
  useHoldCartStore,
} from "@/features/pos/stores/useCartStore";
import { useEffect } from "react";
import { toast } from "@/components/ui/toast";

export function HeldItemsDialog({
  open,
  handleOpenChange,
}: {
  open: boolean;
  handleOpenChange: (open: boolean) => void;
}) {
  const { addHoldItemsToCart } = useCartStore();
  const { holdCartItems, removeHoldCart, clearHoldCarts, refreshHolds } =
    useHoldCartStore();

  // Holds live on the server (Module 1): refresh every time the dialog
  // opens so holds from OTHER registers appear.
  useEffect(() => {
    if (open) void refreshHolds();
  }, [open, refreshHolds]);
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Removed DialogTrigger completely! */}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Held Carts</DialogTitle>
          <DialogDescription>
            Click a held cart to restore it to the active cart.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-4 no-scrollbar max-h-[50vh] overflow-y-auto px-4">
          {Array.isArray(holdCartItems) && holdCartItems.length > 0 ? (
            holdCartItems.map((cart, index) => (
              <Card
                onClick={() => {
                  // Rebuild cart lines from LIVE catalog data (prices/stock
                  // re-validated at sale time); report unresolvable items.
                  // Packaging-unit holds re-derive their unit/price from the
                  // live sell-units; a missing conversion falls back to the
                  // base unit so resume never breaks.
                  void (async () => {
                    const { lines, missing } = await resumeHeldItems(
                      cart.items as never,
                    );
                    if (missing.length > 0) {
                      toast.add({
                        type: "error",
                        description: `Not in the current catalog: ${missing.join(", ")}`,
                        priority: "high",
                      });
                    }
                    if (lines.length > 0) {
                      addHoldItemsToCart(lines);
                      void removeHoldCart(cart.id);
                      handleOpenChange(false);
                    }
                  })();
                }}
                className="w-full flex flex-col items-center cursor-pointer mb-2 p-2 rounded"
                key={cart.id}
              >
                <CardContent>
                  <span className="font-bold">{cart.name}</span>
                  <span className="text-sm text-gray-700">{cart.time}</span>
                  <span className="text-sm">{cart.items.length} items</span>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent>
                <span>No held carts yet</span>
              </CardContent>
            </Card>
          )}
        </div>

        <DialogFooter>
          <Button
            onClick={() => {
              void clearHoldCarts().then(() => handleOpenChange(false));
            }}
          >
            Clear Hold Carts
          </Button>
          <DialogClose render={<Button variant="outline">Close</Button>} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
