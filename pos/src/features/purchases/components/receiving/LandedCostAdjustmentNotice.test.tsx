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

  // Phase 3 — supplier credit visibility on the return confirmation.
  it("shows the supplier credit split with the outstanding reduction", () => {
    renderNotice(LandedCostReversalNotice, {
      purchaseId: 9,
      landedCost: { adjusted: true, amount: 50, documentId: 42 },
      supplierBalance: {
        outstandingBefore: 600,
        goodsCredit: 400,
        outstandingAfter: 200,
        supplierCreditCreated: 0,
      },
    });
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("400.00 goods credit");
    expect(text).toContain("200.00");
    expect(text).toContain("Purchase outstanding reduced");
  });

  it("explains a missing reversal with the backend's own reason (Phase 7)", () => {
    renderNotice(LandedCostReversalNotice, {
      purchaseId: 9,
      landedCost: {
        adjusted: false,
        amount: 0,
        documentId: 42,
        state: "draft",
        reason: "The landed-cost document is a draft — nothing is capitalized yet.",
      },
      supplierBalance: {
        outstandingBefore: 0,
        goodsCredit: 400,
        outstandingAfter: 0,
        supplierCreditCreated: 400,
      },
    });
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain(
      "no reversal — The landed-cost document is a draft — nothing is capitalized yet.",
    );
  });

  it("surfaces a supplier credit balance when the purchase is fully settled", () => {
    renderNotice(LandedCostReversalNotice, {
      purchaseId: 9,
      landedCost: { adjusted: false, amount: 0, documentId: null },
      supplierBalance: {
        outstandingBefore: 0,
        goodsCredit: 400,
        outstandingAfter: 0,
        supplierCreditCreated: 400,
      },
    });
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("400.00 goods credit");
    // Without a server reason, the notice falls back to the generic text.
    expect(text).toContain("no reversal — not applicable");
    expect(text).toContain("400.00 becomes supplier credit balance");
    expect(text).toContain("not a cash refund");
  });
});
