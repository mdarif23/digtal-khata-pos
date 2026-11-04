import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CartItemDiscount } from "../CartItems";

// The per-line discount editor: commits on Enter/blur, clamps percentages to
// 100 and fixed amounts to the line base, and removes the discount when
// emptied. Clamping happens BEFORE addDiscount so the store never holds an
// over-discount.

const base = {
  variantId: 11,
  lineBase: 100,
  lineTotal: 90,
  hasDiscount: true,
};

describe("CartItemDiscount", () => {
  it("commits a percentage discount on Enter", async () => {
    const addDiscount = vi.fn();
    const user = userEvent.setup();
    render(<CartItemDiscount {...base} discount={null} addDiscount={addDiscount} />);

    const input = screen.getByLabelText("Item discount");
    await user.type(input, "10{Enter}");

    expect(addDiscount).toHaveBeenCalledWith(11, 10, "percentage");
    expect(screen.getByText("= ৳90.00")).toBeInTheDocument();
  });

  it("commits on blur without Enter", async () => {
    const addDiscount = vi.fn();
    const user = userEvent.setup();
    render(<CartItemDiscount {...base} discount={null} addDiscount={addDiscount} />);

    await user.type(screen.getByLabelText("Item discount"), "25");
    await user.tab();

    expect(addDiscount).toHaveBeenCalledWith(11, 25, "percentage");
  });

  it("clamps a percentage above 100 before writing to the store", async () => {
    const addDiscount = vi.fn();
    const user = userEvent.setup();
    render(<CartItemDiscount {...base} discount={null} addDiscount={addDiscount} />);

    await user.type(screen.getByLabelText("Item discount"), "150{Enter}");

    expect(addDiscount).toHaveBeenCalledWith(11, 100, "percentage");
    expect(screen.getByLabelText("Item discount")).toHaveValue(100);
  });

  it("clamps a fixed discount to the line base", async () => {
    const addDiscount = vi.fn();
    const user = userEvent.setup();
    render(
      <CartItemDiscount
        {...base}
        lineBase={30}
        lineTotal={25}
        discount={null}
        addDiscount={addDiscount}
      />,
    );

    // Flip percentage → fixed via the switch, then over-discount.
    await user.click(screen.getByRole("switch", { name: "Fixed amount discount" }));
    await user.type(screen.getByLabelText("Item discount"), "50{Enter}");

    expect(addDiscount).toHaveBeenCalledWith(11, 30, "fixed");
    expect(screen.getByLabelText("Item discount")).toHaveValue(30);
  });

  it("removes the discount when the input is emptied", async () => {
    const addDiscount = vi.fn();
    const user = userEvent.setup();
    render(
      <CartItemDiscount
        {...base}
        discount={{ type: "percentage", value: 10 }}
        addDiscount={addDiscount}
      />,
    );

    const input = screen.getByLabelText("Item discount") as HTMLInputElement;
    await user.clear(input);
    await user.tab();

    // The parent re-renders with hasDiscount=false on this callback — the
    // "= ৳90.00" badge is prop-driven, so the input clearing + the zero
    // commit is the whole contract here.
    expect(addDiscount).toHaveBeenCalledWith(11, 0, "percentage");
    expect(input).toHaveValue(null);
  });

  it("keeps the input in sync when the store discount changes externally", () => {
    const { rerender } = render(
      <CartItemDiscount
        {...base}
        discount={{ type: "percentage", value: 10 }}
        addDiscount={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Item discount")).toHaveValue(10);

    rerender(
      <CartItemDiscount
        {...base}
        discount={{ type: "fixed", value: 5 }}
        addDiscount={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Item discount")).toHaveValue(5);
  });
});
