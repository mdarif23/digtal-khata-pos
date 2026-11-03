import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PriceChangeBadge } from "./PriceChangeBadge";

describe("PriceChangeBadge", () => {
  it("renders an increase with an up marker", () => {
    render(<PriceChangeBadge value={20} />);
    const badge = screen.getByText("+20.00%");
    expect(badge).toBeInTheDocument();
  });

  it("renders a decrease in a green badge", () => {
    render(<PriceChangeBadge value={-4.5} />);
    const badge = screen.getByText("−4.50%");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("emerald");
  });

  it("renders a flat change as neutral", () => {
    render(<PriceChangeBadge value={0} />);
    expect(screen.getByText("0.00%")).toBeInTheDocument();
  });

  it("renders an em dash when the change is unknown", () => {
    render(<PriceChangeBadge value={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
