import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentModal } from "../PaymentModal";
import { cartSchema, type CartSchemaType } from "../../../schemas/cart.schema";

// The modal fetches the customer's store-credit / loyalty balances while it
// is open — mocked here so tests control the numbers. The factory default
// keeps the older tests (which never call mockBalances) resolving quietly.
vi.mock("../../../../../api/axios.js", () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: { data: { balance: 0 } } }),
  },
}));

import axios from "../../../../../api/axios.js";

const mockedGet = vi.mocked(axios.get);

function mockBalances({
  storeCredit = 500,
  loyaltyBalance = 2000,
  loyaltyConfig = {
    redeemValue: 10,
    earnRate: 1,
    minRedemptionPoints: 0,
    maxRedemptionPointsPerSale: null,
  },
  creditLimit = null,
  creditAvailable = null,
}: {
  storeCredit?: number | null;
  loyaltyBalance?: number | null;
  loyaltyConfig?:
    | {
        redeemValue: number;
        earnRate: number;
        minRedemptionPoints: number;
        maxRedemptionPointsPerSale: number | null;
      }
    | null;
  creditLimit?: number | null;
  creditAvailable?: number | null;
} = {}) {
  mockedGet.mockImplementation(async (url: string) => {
    if (url.includes("/store-credit"))
      return { data: { data: { balance: storeCredit } } };
    if (url.includes("/loyalty/config"))
      return { data: { data: loyaltyConfig } };
    if (url.includes("/loyalty"))
      return { data: { data: { balance: loyaltyBalance } } };
    if (url.includes("/credit-summary"))
      return {
        data: { data: { creditLimit, outstanding: 0, available: creditAvailable } },
      };
    throw new Error(`Unexpected GET ${url}`);
  });
}

// The checkout payment modal. The BACKEND re-validates every payment, but
// these tests pin what the cashier can even submit: exact totals for splits,
// references for digital methods, and a customer for the due part.

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
    } as any,
  });
  (window as unknown as Record<string, unknown>).__cartForm = form;
  return (
    <PaymentModal
      finalTotal={finalTotal}
      form={form}
      isPaymentDialogOpen
      setIsPaymentDialogOpen={() => {}}
    />
  );
}

const confirm = () => screen.getByRole("button", { name: "Confirm Payment" });

describe("PaymentModal", () => {
  it("shows the total and enables Confirm only when cash covers it", async () => {
    const user = userEvent.setup();
    render(<Harness finalTotal={100} />);

    expect(screen.getByText(/Total due:/)).toBeInTheDocument();
    expect(confirm()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Exact" }));
    expect(confirm()).toBeEnabled();
    expect(screen.getByText("Change to give")).toBeInTheDocument();
  });

  it("charges the quoted final total as-is (coupon/inclusive-tax safe)", async () => {
    // A1-002/A1-003: the modal must charge the authoritative quote total —
    // a coupon-discounted or inclusive-tax total cannot be re-derived from
    // afterDiscount + vat (that double-counts tax and misses the coupon).
    const user = userEvent.setup();
    // Items total 100, coupon takes 15 → quote finalTotal 85.
    render(<Harness finalTotal={85} />);

    expect(screen.getByText(/Total due:/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Exact" }));
    expect(confirm()).toBeEnabled();
  });

  it("shows what is still owed when tendered falls short", async () => {
    const user = userEvent.setup();
    render(<Harness finalTotal={100} />);

    await user.type(screen.getByLabelText("Cash Receive"), "50");
    expect(screen.getByText("Still owed")).toBeInTheDocument();
    expect(screen.getByText("৳50.00")).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
  });

  it("requires a reference before a card payment can be confirmed", async () => {
    const user = userEvent.setup();
    render(<Harness finalTotal={100} />);

    await user.click(screen.getByRole("button", { name: "Card" }));
    expect(confirm()).toBeDisabled();

    await user.type(
      screen.getByLabelText(/Transaction ID/),
      "abc", // 3 chars — below the 6-char rule
    );
    expect(confirm()).toBeDisabled();

    await user.type(
      screen.getByLabelText(/Transaction ID/),
      "DEF456", // now 9 chars
    );
    expect(confirm()).toBeEnabled();
  });

  it("splits cash + due for a customer and fills the remainder", async () => {
    const user = userEvent.setup();
    render(<Harness finalTotal={100} customerId={5} />);

    await user.click(screen.getByRole("button", { name: "Split" }));
    expect(confirm()).toBeDisabled();

    // P3 Phase 1 (F5): the split builder is an arbitrary row list — the old
    // fixed cash/bangla_qr/due trio is gone. Split seeds cash + Bangla QR:
    // fill the cash row, switch row 2 to Due, and fill the remainder onto
    // the customer's account.
    await user.type(screen.getByLabelText("Cash amount"), "40");
    await user.selectOptions(screen.getByLabelText("Tender method 2"), "due");
    const fillButtons = screen.getAllByRole("button", { name: "Fill" });
    await user.click(fillButtons[fillButtons.length - 1]!);
    expect(screen.getByText("Remaining")).toBeInTheDocument();
    expect(confirm()).toBeEnabled();

    const payments = (
      (window as unknown as Record<string, any>).__cartForm as {
        getValues: (n: string) => any;
      }
    ).getValues("payments");
    expect(payments[0]).toMatchObject({ method: "cash", amount: 40 });
    expect(payments[1]).toMatchObject({ method: "due", amount: 60 });
  });

  it("splits cash + store credit against the live balance (F5 generalization)", async () => {
    const user = userEvent.setup();
    mockBalances({ storeCredit: 60 });
    render(<Harness finalTotal={100} customerId={5} />);

    await user.click(screen.getByRole("button", { name: "Split" }));
    // The seeded Bangla QR row becomes a store-credit row — a tender the old
    // positional split builder could not express.
    await user.selectOptions(
      screen.getByLabelText("Tender method 2"),
      "store_credit",
    );
    await user.type(screen.getByLabelText("Cash amount"), "40");
    await user.type(screen.getByLabelText("Store credit amount"), "60");
    // The store-credit balance fetch must land before Confirm unlocks.
    await waitFor(() => expect(confirm()).toBeEnabled());
  });

  it("a walk-in (no customer) cannot add a due row in split payment", async () => {
    const user = userEvent.setup();
    render(<Harness finalTotal={100} customerId={null} />);

    await user.click(screen.getByRole("button", { name: "Split" }));
    // Add a row and try to switch it to Due — the option is disabled without
    // a customer (the backend also rejects customerless dues).
    await user.click(screen.getByRole("button", { name: "+ Add payment method" }));
    const rowSelect = screen.getByLabelText("Tender method 2");
    const dueOption = within(rowSelect).getByRole("option", { name: "Due" });
    expect(dueOption).toBeDisabled();
  });

  it("blocks due and store-credit methods without a customer", async () => {
    render(<Harness finalTotal={100} customerId={null} />);
    expect(screen.getByRole("button", { name: "Due" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Store credit" })).toBeDisabled();
  });
});

describe("PaymentModal — balance tenders (store credit / loyalty)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables store credit when the balance covers the total", async () => {
    const user = userEvent.setup();
    mockBalances({ storeCredit: 500 });
    render(<Harness finalTotal={100} customerId={5} />);

    await user.click(screen.getByRole("button", { name: "Store credit" }));
    await screen.findByText("৳500.00");
    expect(confirm()).toBeEnabled();
  });

  it("blocks store credit beyond the balance and shows the shortfall", async () => {
    const user = userEvent.setup();
    mockBalances({ storeCredit: 40 });
    render(<Harness finalTotal={100} customerId={5} />);

    await user.click(screen.getByRole("button", { name: "Store credit" }));
    await screen.findByText("৳40.00");
    expect(confirm()).toBeDisabled();
    expect(screen.getByText(/Insufficient store credit — ৳60\.00 short/)).toBeInTheDocument();
  });

  it("blocks store credit while the balance is unavailable", async () => {
    const user = userEvent.setup();
    // A rejected balance fetch must never guess a number — the button stays
    // disabled until the real balance is readable.
    mockedGet.mockImplementation(async (url: string) => {
      if (url.includes("/store-credit"))
        throw new Error("network down");
      return { data: { data: {} } };
    });
    render(<Harness finalTotal={100} customerId={5} />);

    await user.click(screen.getByRole("button", { name: "Store credit" }));
    await screen.findByText(/balance unavailable/);
    expect(confirm()).toBeDisabled();
  });

  it("enables loyalty points and shows the points conversion", async () => {
    const user = userEvent.setup();
    mockBalances({ loyaltyBalance: 2000, loyaltyConfig: { redeemValue: 10, earnRate: 1, minRedemptionPoints: 0, maxRedemptionPointsPerSale: null } });
    render(<Harness finalTotal={100} customerId={5} />);

    await user.click(screen.getByRole("button", { name: "Loyalty points" }));
    await screen.findByText("10 pts");
    expect(screen.getByText("2,000")).toBeInTheDocument();
    expect(confirm()).toBeEnabled();
  });

  it("blocks loyalty points beyond the balance", async () => {
    const user = userEvent.setup();
    mockBalances({ loyaltyBalance: 5, loyaltyConfig: { redeemValue: 10, earnRate: 1, minRedemptionPoints: 0, maxRedemptionPointsPerSale: null } });
    render(<Harness finalTotal={100} customerId={5} />);

    await user.click(screen.getByRole("button", { name: "Loyalty points" }));
    await screen.findByText(/Insufficient points — balance 5\.00, needs 10\.00/);
    expect(confirm()).toBeDisabled();
  });

  it("blocks loyalty points under the per-sale redemption cap", async () => {
    const user = userEvent.setup();
    mockBalances({ loyaltyBalance: 2000, loyaltyConfig: { redeemValue: 10, earnRate: 1, minRedemptionPoints: 0, maxRedemptionPointsPerSale: 5 } });
    render(<Harness finalTotal={100} customerId={5} />);

    await user.click(screen.getByRole("button", { name: "Loyalty points" }));
    await screen.findByText(/Capped at 5 points per sale/);
    expect(confirm()).toBeDisabled();
  });

  it("blocks loyalty points under the minimum redemption", async () => {
    const user = userEvent.setup();
    mockBalances({ loyaltyBalance: 2000, loyaltyConfig: { redeemValue: 10, earnRate: 1, minRedemptionPoints: 50, maxRedemptionPointsPerSale: null } });
    render(<Harness finalTotal={100} customerId={5} />);

    await user.click(screen.getByRole("button", { name: "Loyalty points" }));
    await screen.findByText(/needs at least 50 points/);
    expect(confirm()).toBeDisabled();
  });

  it("blocks loyalty points when the program is not active", async () => {
    const user = userEvent.setup();
    mockBalances({ loyaltyConfig: null });
    render(<Harness finalTotal={100} customerId={5} />);

    await user.click(screen.getByRole("button", { name: "Loyalty points" }));
    await screen.findByText(/Loyalty redemption is not available/);
    expect(confirm()).toBeDisabled();
  });
});
