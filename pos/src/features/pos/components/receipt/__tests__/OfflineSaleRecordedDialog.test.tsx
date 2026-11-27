import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SaleReceiptData } from "../../types/receipt.types.js";
import {
  OfflineSaleRecordedDialog,
  type OfflineSaleRecord,
} from "../OfflineSaleRecordedDialog.js";

// Offline twin of SaleSuccessDialog: outbox-recorded sales (offline mode or
// a mid-checkout connection drop) must give the cashier the same
// sale-is-done confirmation — honest about the fact that the invoice
// number only exists after the sale syncs.

const record: OfflineSaleRecord = {
  reference: "3c60f3f6-a73d-4b96-9db7-40fab947e9e2",
  total: 214.29,
  paid: 214.29,
  due: 0,
  itemCount: 2,
  customerName: null,
};

const offlineReceipt: SaleReceiptData = {
  saleId: 0,
  invoiceNumber: "OFF-3C60F3F6",
  saleDate: new Date(),
  createdAt: new Date(),
  customer: null,
  items: [],
  subtotal: 214.29,
  discount: 0,
  vat: 0,
  finalTotal: 214.29,
  dueAmount: 0,
  paidAmount: 214.29,
  change: 0,
  paymentStatus: "paid",
  payments: [],
};

describe("OfflineSaleRecordedDialog", () => {
  it("shows the confirmation with the local reference, total and paid", () => {
    render(
      <OfflineSaleRecordedDialog
        record={record}
        receipt={null}
        open
        onOpenChange={() => {}}
        onNewSale={() => {}}
      />,
    );
    expect(
      screen.getByText("Sale Recorded Offline!"),
    ).toBeInTheDocument();
    expect(screen.getByText("3C60F3F6")).toBeInTheDocument();
    // Full cash sale: the total and the paid amount are both ৳214.29.
    expect(screen.getAllByText("৳214.29")).toHaveLength(2);
    expect(screen.getByText("Final Total:")).toBeInTheDocument();
    expect(screen.getByText("Amount Paid:")).toBeInTheDocument();
    expect(
      screen.getByText(/The invoice number is assigned when this sale syncs/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Outstanding Balance:")).toBeNull();
  });

  it("shows the receivable for due sales and hides Amount Paid", () => {
    render(
      <OfflineSaleRecordedDialog
        record={{ ...record, paid: 0, due: 144 }}
        receipt={null}
        open
        onOpenChange={() => {}}
        onNewSale={() => {}}
      />,
    );
    expect(screen.getByText("Outstanding Balance:")).toBeInTheDocument();
    expect(screen.getByText("৳144.00")).toBeInTheDocument();
    expect(screen.queryByText("Amount Paid:")).toBeNull();
  });

  it("New Sale closes the dialog and resets for the next customer", async () => {
    const onOpenChange = vi.fn();
    const onNewSale = vi.fn();
    const user = userEvent.setup();
    render(
      <OfflineSaleRecordedDialog
        record={record}
        receipt={null}
        open
        onOpenChange={onOpenChange}
        onNewSale={onNewSale}
      />,
    );
    await user.click(screen.getByRole("button", { name: /New Sale/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onNewSale).toHaveBeenCalled();
  });

  it("offers Print and Preview only when a local receipt exists", () => {
    const withoutReceipt = render(
      <OfflineSaleRecordedDialog
        record={record}
        receipt={null}
        open
        onOpenChange={() => {}}
        onNewSale={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /Print Receipt/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Preview/ })).toBeNull();
    withoutReceipt.unmount();

    render(
      <OfflineSaleRecordedDialog
        record={record}
        receipt={offlineReceipt}
        open
        onOpenChange={() => {}}
        onNewSale={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Print Receipt/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Preview/ })).toBeInTheDocument();
  });
});
