import { HoldCartItems } from "@/features/pos/types/cart.types";
import React, { useEffect, useState } from "react";
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
import { Kbd } from "@/components/common/Kbd";
import { useHotkeyAction } from "../../hotkeys/hotkeyBus";

export function HoldDropdownMenu() {
  const [open, setOpen] = useState(false);
  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
  }
  const resetCart = useCartStore((state) => state.resetCart);
  const cart = useCartStore((state) => state.cart);
  const { holdCart } = useHoldCartStore();
  // Commercial "open tickets" pattern: the cashier sees how many held sales
  // are waiting without opening the menu.
  const holdCount = useHoldCartStore((state) => state.holdCartItems.length);
  useEffect(() => {
    void useHoldCartStore.getState().refreshHolds();
  }, []);

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
            <Button type="button" className="w-full justify-between">
              <span className="flex items-center gap-1.5">
                Hold
                {holdCount > 0 && (
                  <span
                    className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground"
                    aria-label={`${holdCount} held sales`}
                  >
                    {holdCount}
                  </span>
                )}
              </span>
              <Kbd keys={["F2"]} className="opacity-70" />
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
            <Kbd keys={["F2"]} className="ml-auto opacity-70" />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setOpen(true)}>
            Held Items
            <Kbd keys={["F3"]} className="ml-auto opacity-70" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <HeldItemsDialog open={open} handleOpenChange={handleOpenChange} />
    </>
  );
}
