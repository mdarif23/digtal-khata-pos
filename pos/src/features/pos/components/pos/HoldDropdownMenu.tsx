import { HoldCartItems } from "@/features/pos/types/cart.types";
import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useCartStore,
  useHoldCartStore,
} from "@/features/pos/stores/useCartStore";
import { HeldItemsDialog } from "./HeldItemsDialog";
import { useHotkeyAction } from "../../hotkeys/hotkeyBus";

export function HoldDropdownMenu() {
  const [open, setOpen] = useState(false);
  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
  }
  const resetCart = useCartStore((state) => state.resetCart);
  const cart = useCartStore((state) => state.cart);
  const { holdCart } = useHoldCartStore();

  // Phase 3 hotkeys: F2 hold (same guard as the menu item), F3 retrieve.
  useHotkeyAction("hold-sale", () => {
    if (cart.length === 0) return;
    void holdCart(cart).then((held) => {
      if (held) resetCart();
    });
  });
  useHotkeyAction("retrieve-held", () => setOpen(true));

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" className="w-full">
              Hold
            </Button>
          }
        ></DropdownMenuTrigger>
        <DropdownMenuContent side="top">
          <DropdownMenuItem
            disabled={cart.length === 0}
            variant="destructive"
            onClick={() => {
              // Server-backed holds (Module 1): only clear the register
              // once the hold is safely stored — the cart is never lost.
              void holdCart(cart).then((held) => {
                if (held) {
                  resetCart();
                }
              });
            }}
          >
            Hold
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setOpen(true)}>
            Held Items
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <HeldItemsDialog open={open} handleOpenChange={handleOpenChange} />
    </>
  );
}
