import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  LandedCostAdjustmentNotice,
  LandedCostReversalNotice,
} from "./LandedCostAdjustmentNotice";

const renderNotice = (
  Notice: typeof LandedCostAdjustmentNotice,
  props: Parameters<typeof LandedCostAdjustmentNotice>[0],
) =>
  render(
    <MemoryRouter>
      <Notice {...props} />
    </MemoryRouter>,
  );

describe("LandedCostAdjustmentNotice", () => {
  it("renders nothing when no adjustment occurred", () => {
    const { container } = renderNotice(LandedCostAdjustmentNotice, {
      purchaseId: 7,
      landedCost: { adjusted: false, amount: 0, documentId: null },
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the backend adjustment amount and a link to the document", () => {
    renderNotice(LandedCostAdjustmentNotice, {
      purchaseId: 7,
      landedCost: { adjusted: true, amount: 123.5, documentId: 42 },
    });
    expect(screen.getByRole("status").textContent).toContain("123.50");
    expect(screen.getByRole("status").textContent).toContain("adjusted");
    // The project's Button renders anchors with an explicit role="button".
    const link = screen.getByRole("button", {
      name: /view landed-cost document/i,
    });
    expect(link.getAttribute("href")).toBe("/purchases/landed-cost/7");
  });

  it("renders the reversal wording for a return reversal", () => {
    renderNotice(LandedCostReversalNotice, {
      purchaseId: 9,
      landedCost: { adjusted: true, amount: 50, documentId: 42 },
    });
    expect(screen.getByRole("status").textContent).toContain("reversed");
    expect(screen.getByRole("status").textContent).toContain("50.00");
  });
});
