import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CartQuantityInput } from "../CartItems";

// Quantity commits on Enter/blur; invalid input (empty, 0, negative, decimal)
// falls back to the current quantity instead of corrupting the cart.

describe("CartQuantityInput", () => {
  it("commits a whole-number quantity on Enter", async () => {
    const addCustomCartQuantity = vi.fn();
    const user = userEvent.setup();
    render(
      <CartQuantityInput
        itemId={11}
        quantity={2}
        addCustomCartQuantity={addCustomCartQuantity}
      />,
    );

    await user.type(screen.getByLabelText("Quantity"), "5{Enter}");
    expect(addCustomCartQuantity).toHaveBeenCalledWith(11, 5);
  });

  it("floors decimal input", async () => {
    const addCustomCartQuantity = vi.fn();
    const user = userEvent.setup();
    render(
      <CartQuantityInput
        itemId={11}
        quantity={2}
        addCustomCartQuantity={addCustomCartQuantity}
      />,
    );

    await user.type(screen.getByLabelText("Quantity"), "3.7{Enter}");
    expect(addCustomCartQuantity).toHaveBeenCalledWith(11, 3);
  });

  it("reverts to the stored quantity for empty or zero input", async () => {
    const addCustomCartQuantity = vi.fn();
    const user = userEvent.setup();
    render(
      <CartQuantityInput
        itemId={11}
        quantity={2}
        addCustomCartQuantity={addCustomCartQuantity}
      />,
    );

    const input = screen.getByLabelText("Quantity");
    await user.clear(input);
    await user.tab();
    expect(addCustomCartQuantity).not.toHaveBeenCalled();
    expect(input).toHaveValue(2);

    await user.type(input, "0{Enter}");
    expect(addCustomCartQuantity).not.toHaveBeenCalled();
    expect(input).toHaveValue(2);
  });
});
