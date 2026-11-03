import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OnlineStoreProfitabilityReport } from "./OnlineStoreProfitabilityReport";
import type { AxiosResponse } from "axios";

vi.mock("../api/onlineProfitability.api", () => ({
  onlineProfitabilityApi: {
    getSummary: vi.fn(() =>
      Promise.resolve({
        data: {
          success: true,
          data: {
            totalOrders: 1,
            completedOrders: 1,
            cancelledOrders: 0,
            refundCount: 0,
            grossProductSales: 255000,
            discounts: 0,
            productRefunds: 0,
            netProductSales: 250000,
            cogs: 150000,
            restockedCost: 0,
            grossProfit: 100000,
            shippingIncome: 5000,
            courierExpense: 8000,
            packagingExpense: 4000,
            gatewayFees: 3000,
            marketplaceCommission: 2000,
            netContributionProfit: 88000,
            grossMarginPercent: 40,
            contributionMarginPercent: 35.2,
          },
        },
      } as unknown as AxiosResponse),
    ),
    getTrends: vi.fn(() =>
      Promise.resolve({
        data: { success: true, data: [] },
      } as unknown as AxiosResponse),
    ),
    getChannels: vi.fn(() =>
      Promise.resolve({
        data: { success: true, data: [] },
      } as unknown as AxiosResponse),
    ),
    getExpenses: vi.fn(() =>
      Promise.resolve({
        data: { success: true, data: { rows: [], total: 0 } },
      } as unknown as AxiosResponse),
    ),
    getProducts: vi.fn(() =>
      Promise.resolve({
        data: {
          success: true,
          data: { rows: [], total: 0, page: 1, pageSize: 10 },
        },
      } as unknown as AxiosResponse),
    ),
  },
}));

describe("OnlineStoreProfitabilityReport", () => {
  it("renders the profitability KPIs from the server summary", async () => {
    render(<OnlineStoreProfitabilityReport />);
    await waitFor(() => {
      expect(screen.getByText("Net contribution profit")).toBeInTheDocument();
    });
    // §9 example values: gross profit 100,000 and net contribution 88,000
    // (the contribution figure appears in the KPI card AND the operating
    // profit breakdown, so assert on all matches).
    expect(screen.getByText(/100,000/)).toBeInTheDocument();
    expect(screen.getAllByText(/88,000/).length).toBeGreaterThan(0);
    expect(screen.getByText(/40% margin/)).toBeInTheDocument();
    expect(screen.getByText(/35\.2% of net sales/)).toBeInTheDocument();
  });

  it("carries the calculation-policy disclaimer and contribution caveat", async () => {
    render(<OnlineStoreProfitabilityReport />);
    await waitFor(() => {
      expect(
        screen.getByText(/not your full net\s*business profit/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/historical cost of the inventory actually consumed/i),
    ).toBeInTheDocument();
  });
});
