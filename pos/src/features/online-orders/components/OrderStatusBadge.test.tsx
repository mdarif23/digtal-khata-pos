import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrderStatusBadge } from "./OrderStatusBadge";

describe("OrderStatusBadge", () => {
  it("renders the label for a known workflow state", () => {
    render(<OrderStatusBadge status="ready_to_ship" />);
    expect(screen.getByTestId("order-fulfillment-badge")).toHaveTextContent(
      "Ready to Ship",
    );
  });

  it("uses an emerald style for delivered and a rose style for returned", () => {
    const { container, rerender } = render(
      <OrderStatusBadge status="delivered" />,
    );
    expect(container.firstChild).toHaveClass("bg-emerald-50");
    rerender(<OrderStatusBadge status="returned" />);
    expect(container.firstChild).toHaveClass("bg-rose-50");
  });

  it("falls back to a readable label for unknown states", () => {
    render(<OrderStatusBadge status="mystery_state" />);
    expect(screen.getByTestId("order-fulfillment-badge")).toHaveTextContent(
      "mystery state",
    );
  });

  it("renders a dash placeholder for empty values", () => {
    render(<OrderStatusBadge status={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
