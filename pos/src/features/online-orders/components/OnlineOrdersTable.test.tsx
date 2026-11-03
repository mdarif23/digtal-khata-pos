import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OnlineOrdersTable } from "./OnlineOrdersTable";
import type { OnlineOrderRow } from "../types/onlineOrders.types";

const row: OnlineOrderRow = {
  id: 42,
  invoiceNumber: "INV-2026-000007",
  channel: "woocommerce",
  status: "completed",
  paymentStatus: "unpaid",
  fulfillmentStatus: "shipped",
  finalTotal: 1250,
  externalOrderNumber: "WC-7001",
  customerName: "Test Buyer",
  locationName: "Main Store",
  createdAt: "2026-11-04T10:00:00.000Z",
  itemsCount: 3,
};

describe("OnlineOrdersTable", () => {
  it("renders order rows with independent payment and fulfillment badges", () => {
    render(
      <OnlineOrdersTable
        orders={[row]}
        isLoading={false}
        isError={false}
        onRetry={() => {}}
        onOpenOrder={() => {}}
      />,
    );
    expect(screen.getByText("INV-2026-000007")).toBeInTheDocument();
    expect(screen.getByText("Test Buyer")).toBeInTheDocument();
    expect(screen.getByText("WooCommerce")).toBeInTheDocument();
    // Payment badge (unpaid) and fulfillment badge (shipped) are separate.
    expect(screen.getByText("Unpaid")).toBeInTheDocument();
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows an empty state when there are no orders", () => {
    render(
      <OnlineOrdersTable
        orders={[]}
        isLoading={false}
        isError={false}
        onRetry={() => {}}
        onOpenOrder={() => {}}
      />,
    );
    expect(
      screen.getByText(/No online orders match/i),
    ).toBeInTheDocument();
  });

  it("shows an error state with a working retry", async () => {
    const onRetry = vi.fn();
    render(
      <OnlineOrdersTable
        orders={undefined}
        isLoading={false}
        isError
        onRetry={onRetry}
        onOpenOrder={() => {}}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Try again"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("opens an order when a row is clicked", async () => {
    const onOpenOrder = vi.fn();
    render(
      <OnlineOrdersTable
        orders={[row]}
        isLoading={false}
        isError={false}
        onRetry={() => {}}
        onOpenOrder={onOpenOrder}
      />,
    );
    await userEvent.click(screen.getByText("INV-2026-000007"));
    expect(onOpenOrder).toHaveBeenCalledWith(42);
  });
});
