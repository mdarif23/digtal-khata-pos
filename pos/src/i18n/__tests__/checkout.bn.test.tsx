import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";

import { setAppLanguage } from "../language.js";
import { useCartStore } from "@/features/pos/stores/useCartStore.js";
import { PaymentModal } from "@/features/pos/components/pos/PaymentModal.js";
import { SaleSuccessDialog } from "@/features/pos/components/receipt/SaleSuccessDialog.js";
import type { SaleReceiptData } from "@/features/pos/types/receipt.types.js";
import { cartSchema, type CartSchemaType } from "@/features/pos/schemas/cart.schema.js";
import "../index.js";

// The modal fetches the customer's store-credit / loyalty balances while it
// is open — mocked quietly (the bn tests never rely on the numbers).
vi.mock("../../api/axios.js", () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: { data: { balance: 0 } } }),
    post: vi.fn(),
  },
}));

vi.mock("@/features/warranty/renderers/warrantyCertificateHtml.js", () => ({
  printWarrantyCertificate: vi.fn(),
}));

const KEY_SHAPED = /\b(?:pos|common|payment|saleSuccess|register):[A-Za-z0-9_.]+\b/;

function expectNoRawKeys(container: HTMLElement) {
  const text = container.textContent ?? "";
  const hits = text.match(new RegExp(KEY_SHAPED.source, "g")) ?? [];
  expect(hits).toEqual([]);
}

function Harness({
  finalTotal = 100,
  customerId = null,
}: {
  finalTotal?: number;
  customerId?: number | null;
}) {
  const form = useForm<CartSchemaType>({
    resolver: zodResolver(cartSchema),
    defaultValues: {
      saleDate: new Date(),
      customerId,
      payments: [{ method: "cash" }],
      discount: null,
      vatPercent: null,
    } as never,
  });
  return (
    <PaymentModal
      finalTotal={finalTotal}
      form={form}
      isPaymentDialogOpen
      setIsPaymentDialogOpen={() => {}}
    />
  );
}

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

describe("Checkout flow renders in Bangla (Phase 5)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18next.changeLanguage("bn");
  });

  it("PaymentModal renders title, methods and confirm button in Bangla", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness finalTotal={100} />);
    expect(screen.getByText("পেমেন্ট")).toBeInTheDocument();
    expect(screen.getByText("মোট বাকি:")).toBeInTheDocument();
    expect(screen.getByText("ক্যাশ")).toBeInTheDocument();
    expect(screen.getByText("বাংলা QR")).toBeInTheDocument();
    expect(screen.getByText("স্প্লিট")).toBeInTheDocument();
    expect(screen.getByText("পেমেন্ট নিশ্চিত করুন")).toBeInTheDocument();
    expectNoRawKeys(container);
    // Switch to cash panel assertions stay data-based: the tender input label.
    expect(screen.getByText("ক্যাশ গ্রহণ")).toBeInTheDocument();
    expect(screen.getByText("ঠিক টাকা")).toBeInTheDocument();
    await user.click(screen.getByText("স্প্লিট"));
    expect(screen.getByText("স্প্লিট পেমেন্ট")).toBeInTheDocument();
    expect(screen.getByText("অবশিষ্ট")).toBeInTheDocument();
    expectNoRawKeys(container);
  });

  it("validation issues render in Bangla (store credit over balance)", async () => {
    const user = userEvent.setup();
    // Customer 1 with mocked balance 0 → the insufficient-store-credit issue.
    const { container } = render(<Harness finalTotal={100} customerId={1} />);
    await user.click(screen.getByText("স্টোর ক্রেডিট"));
    expect(
      screen.getByText("স্টোর ক্রেডিট যথেষ্ট নয় — ৳100.00 কম।"),
    ).toBeInTheDocument();
    expectNoRawKeys(container);
  });

  it("SaleSuccessDialog renders in Bangla with invoice data untouched", () => {
    const { container } = render(
      <SaleSuccessDialog
        receipt={receipt}
        open
        onOpenChange={() => {}}
        onNewSale={() => {}}
      />,
    );
    expect(
      screen.getByText("বিক্রি সফলভাবে সম্পন্ন হয়েছে!"),
    ).toBeInTheDocument();
    expect(screen.getByText("ইনভয়েস নম্বর:")).toBeInTheDocument();
    expect(screen.getByText("রিসিট প্রিন্ট")).toBeInTheDocument();
    expect(screen.getByText("নতুন বিক্রি")).toBeInTheDocument();
    // Invoice number and money are data — never translated.
    expect(screen.getByText("INV-2026-000042")).toBeInTheDocument();
    expect(screen.getAllByText("৳500.00").length).toBeGreaterThan(0);
    expectNoRawKeys(container);
  });

  it("language switch mid-checkout: labels flip, charge target and payments unchanged", async () => {
    render(<Harness finalTotal={100} />);
    expect(screen.getByText("মোট বাকি:")).toBeInTheDocument();
    // Seed a cart line (shape cast — the store does not validate) so the
    // test can assert the cart is never cleared by a language switch.
    useCartStore.setState({ cart: [{ id: 1 }] as never });
    const cartBefore = useCartStore.getState().cart;

    await setAppLanguage("en");
    expect(i18next.language).toBe("en");
    expect(screen.getByText("Total due:")).toBeInTheDocument();
    expect(screen.getByText("Confirm Payment")).toBeInTheDocument();

    await setAppLanguage("bn");
    expect(screen.getByText("মোট বাকি:")).toBeInTheDocument();
    expect(screen.getByText("পেমেন্ট নিশ্চিত করুন")).toBeInTheDocument();

    // The charge target never moved: the quoted ৳100.00 is displayed in both
    // languages, and the cart store kept its seeded line untouched.
    expect(screen.getAllByText("৳100.00").length).toBeGreaterThan(0);
    expect(useCartStore.getState().cart).toBe(cartBefore);
  });
});
