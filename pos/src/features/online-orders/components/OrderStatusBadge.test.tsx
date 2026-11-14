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

  it("uses a success tone for delivered and a danger tone for returned", () => {
    const { container, rerender } = render(
      <OrderStatusBadge status="delivered" />,
    );
    expect(
      container.querySelector('[data-testid="order-fulfillment-badge"] span'),
    ).toHaveClass("bg-success/10");
    rerender(<OrderStatusBadge status="returned" />);
    expect(
      container.querySelector('[data-testid="order-fulfillment-badge"] span'),
    ).toHaveClass("bg-destructive/10");
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
