import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { BarcodeGeneratorPage } from "../pages/BarcodeGeneratorPage.js";
import { server } from "@/test/msw/server.js";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BarcodeGeneratorPage />
    </QueryClientProvider>,
  );
}

describe("BarcodeGeneratorPage", () => {
  it("renders the searchable catalog with barcode values", async () => {
    server.use(
      http.get("*/barcodes/search", () =>
        HttpResponse.json({
          success: true,
          data: {
            rows: [
              {
                variantId: 11,
                productId: 1,
                productName: "Barcode Cola",
                variantLabel: null,
                sku: "SKU-000001",
                barcode: "EZ000000000001",
                barcodeFormat: "code128",
                sellingPrice: 100,
                hasVariants: false,
                aliases: [],
              },
              {
                variantId: 12,
                productId: 2,
                productName: "Barcode Shirt",
                variantLabel: "Small",
                sku: "SKU-000002",
                barcode: null,
                barcodeFormat: null,
                sellingPrice: 250,
                hasVariants: true,
                aliases: [],
              },
            ],
            total: 2,
            page: 1,
            pageSize: 20,
          },
        }),
      ),
    );

    renderPage();
    expect(await screen.findByText("Barcode Cola")).toBeInTheDocument();
    expect(screen.getByText("EZ000000000001")).toBeInTheDocument();
    // A variant without a barcode shows the placeholder and a disabled row.
    expect(screen.getByText("none yet")).toBeInTheDocument();
  });

  it("shows the empty state when nothing matches", async () => {
    server.use(
      http.get("*/barcodes/search", () =>
        HttpResponse.json({
          success: true,
          data: { rows: [], total: 0, page: 1, pageSize: 20 },
        }),
      ),
    );
    renderPage();
    expect(
      await screen.findByText(/No products match/i),
    ).toBeInTheDocument();
  });

  it("selects items with barcodes and shows the selected count", async () => {
    server.use(
      http.get("*/barcodes/search", () =>
        HttpResponse.json({
          success: true,
          data: {
            rows: [
              {
                variantId: 11,
                productId: 1,
                productName: "Barcode Cola",
                variantLabel: null,
                sku: "SKU-000001",
                barcode: "EZ000000000001",
                barcodeFormat: "code128",
                sellingPrice: 100,
                hasVariants: false,
                aliases: [],
              },
            ],
            total: 1,
            page: 1,
            pageSize: 20,
          },
        }),
      ),
    );
    renderPage();
    // [0] is the select-all header checkbox, [1] the row's.
    // Base UI checkboxes do not surface aria-label on the role=checkbox
    // node — select the row's checkbox via its table row context instead.
    const colaCell = await screen.findByText("Barcode Cola");
    const row = colaCell.closest("tr");
    expect(row).not.toBeNull();
    const rowCheckbox = row!.querySelector('[data-slot="checkbox"]');
    expect(rowCheckbox).not.toBeNull();
    fireEvent.click(rowCheckbox!);
    const matches = await screen.findAllByText((_, element) =>
      /1\s+selected/.test(element?.textContent ?? ""),
    );
    expect(matches.length).toBeGreaterThan(0);
  });
});
