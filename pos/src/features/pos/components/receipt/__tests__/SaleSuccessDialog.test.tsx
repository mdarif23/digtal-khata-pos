import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/auth/sessionStore";
import type { SaleReceiptData } from "../../types/receipt.types.js";
import { SaleSuccessDialog } from "../SaleSuccessDialog.js";

// P0 fix #6: the sale success dialog offers a manual e-receipt send through
// the comms module. The action is gated by comms.manage (the permission the
// endpoint requires) and a customer phone; failures are retryable and a
// sent outcome disables further sends.

vi.mock("../../../../../api/axios.js", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

import axios from "../../../../../api/axios.js";

const mockedPost = vi.mocked(axios.post);

vi.mock("../../../warranty/renderers/warrantyCertificateHtml.js", () => ({
  printWarrantyCertificate: vi.fn(),
}));

const receipt: SaleReceiptData = {
  saleId: 42,
  invoiceNumber: "INV-2026-000042",
  saleDate: new Date(),
  createdAt: new Date(),
  customer: { id: 7, name: "Test Customer", phone: "01712345678", address: null },
  items: [
    {
      id: 1,
      variantId: 11,
      productName: "Rice 5kg",
      variantName: null,
      sku: null,
      barcode: null,
      quantity: 1,
      unitPrice: 500,
      discount: 0,
      lineTotal: 500,
      taxAmount: 0,
      taxDetail: [],
      serialNumbers: [],
    },
  ],
  subtotal: 500,
  discount: 0,
  vat: 0,
  finalTotal: 500,
  dueAmount: 0,
  paidAmount: 500,
  change: 0,
  paymentStatus: "paid",
  payments: [],
};

function loginAs(permissions: string[]) {
  useSessionStore.getState().setSession({
    user: { id: 1, fullName: "Manager", email: "m@example.test" },
    businessId: 1,
    roleSlug: "manager",
    roleName: "Manager",
    roles: [],
    permissions,
  });
}

function renderDialog() {
  return render(
    <SaleSuccessDialog
      receipt={receipt}
      open
      onOpenChange={() => {}}
      onNewSale={() => {}}
    />,
  );
}

describe("SaleSuccessDialog — Send Receipt (P0 fix #6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides the send action without comms.manage or without a customer phone", () => {
    loginAs(["pos.view", "pos.create_sale"]);
    renderDialog();
    expect(screen.queryByRole("button", { name: "Send Receipt" })).toBeNull();

    loginAs(["comms.manage"]);
    render(
      <SaleSuccessDialog
        receipt={{ ...receipt, customer: { id: 7, name: "Walk-in", phone: null, address: null } }}
        open
        onOpenChange={() => {}}
        onNewSale={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Send Receipt" })).toBeNull();
  });

  it("sends the receipt over the chosen channel and locks after success", async () => {
    loginAs(["comms.manage"]);
    mockedPost.mockResolvedValueOnce({
      data: { success: true, data: { status: "sent", messageId: 9 } },
    });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Send Receipt" }));
    expect(await screen.findByText(/To:/)).toBeInTheDocument();

    // WhatsApp instead of the SMS default.
    await user.click(screen.getByRole("button", { name: "WhatsApp" }));
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(screen.getByText("Sent.")).toBeInTheDocument(),
    );
    expect(mockedPost).toHaveBeenCalledWith(
      "/comms/send",
      expect.objectContaining({
        channel: "whatsapp",
        customerId: 7,
        recipient: "01712345678",
        templateKey: "sale_receipt",
        messageClass: "transactional",
        entityType: "sale",
        entityId: 42,
      }),
    );
    // A sent receipt must not be re-sendable (backend dedupe is the safety
    // net; the button reflects it).
    expect(screen.getByRole("button", { name: "Sent" })).toBeDisabled();
  });

  it("keeps retry available after a failed delivery", async () => {
    loginAs(["comms.manage"]);
    mockedPost.mockResolvedValueOnce({
      data: {
        success: true,
        data: { status: "failed", reason: "delivery_failed", messageId: 10 },
      },
    });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Send Receipt" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.getByText(/Delivery failed/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
});
