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

  // Sold-by-weight lines (P0 fix #3): fractional quantities up to 3 decimals
  // are legal — 0.5 kg must survive checkout instead of failing validation.
  it("commits fractional weight quantities on weight lines", async () => {
    const addCustomCartQuantity = vi.fn();
    const user = userEvent.setup();
    render(
      <CartQuantityInput
        itemId={11}
        quantity={0.5}
        allowDecimals
        addCustomCartQuantity={addCustomCartQuantity}
      />,
    );

    const input = screen.getByLabelText("Quantity");
    await user.clear(input);
    await user.type(input, "1.25{Enter}");
    expect(addCustomCartQuantity).toHaveBeenCalledWith(11, 1.25);
  });

  it("rounds weight input beyond 3 decimals (scale precision)", async () => {
    const addCustomCartQuantity = vi.fn();
    const user = userEvent.setup();
    render(
      <CartQuantityInput
        itemId={11}
        quantity={1}
        allowDecimals
        addCustomCartQuantity={addCustomCartQuantity}
      />,
    );

    await user.clear(screen.getByLabelText("Quantity"));
    await user.type(screen.getByLabelText("Quantity"), "1.2345{Enter}");
    expect(addCustomCartQuantity).toHaveBeenCalledWith(11, 1.235);
  });

  it("keeps the line unchanged for sub-gram weight input", async () => {
    const addCustomCartQuantity = vi.fn();
    const user = userEvent.setup();
    render(
      <CartQuantityInput
        itemId={11}
        quantity={0.5}
        allowDecimals
        addCustomCartQuantity={addCustomCartQuantity}
      />,
    );

    await user.clear(screen.getByLabelText("Quantity"));
    await user.type(screen.getByLabelText("Quantity"), "0.0004{Enter}");
    expect(addCustomCartQuantity).not.toHaveBeenCalled();
  });
});
