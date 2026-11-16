import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useCartStore } from "@/features/pos/stores/useCartStore";
import { useState } from "react";
export function ClearCartDialog() {
  const [open, setOpen] = useState(false);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
  }
  const resetCart = useCartStore((state) => state.resetCart);
  const cart = useCartStore((state) => state.cart);
  const handleClearCart = () => {
    resetCart({ restoreStock: true });
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button type="button" disabled={cart.length === 0} className="w-full">
            Clear Cart
          </Button>
        }
      />
      <DialogContent showCloseButton={false}>
        <div className={`flex flex-col items-center justify-center `}>
          <span className="text-xl mb-5">Do you want to clear this cart?</span>
          <div className="flex  w-full justify-center gap-3">
            <Button type="button" onClick={handleClearCart}>Yes</Button>

            <DialogClose render={<Button type="button">No</Button>} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
