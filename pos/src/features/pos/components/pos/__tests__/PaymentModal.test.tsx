import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { PaymentModal } from "../PaymentModal";
import { cartSchema, type CartSchemaType } from "../../../schemas/cart.schema";

// The checkout payment modal. The BACKEND re-validates every payment, but
// these tests pin what the cashier can even submit: exact totals for splits,
// references for digital methods, and a customer for the due part.

function Harness({
  subTotal = 100,
  vat = 0,
  customerId = null,
}: {
  subTotal?: number;
  vat?: number;
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
      subTotal={subTotal}
      vat={vat}
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
    render(<Harness subTotal={100} vat={0} />);

    expect(screen.getByText("Total Due : 100.00")).toBeInTheDocument();
    expect(confirm()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Exact" }));
    expect(confirm()).toBeEnabled();
    expect(screen.getByText("Change to Give")).toBeInTheDocument();
  });

  it("shows what is still owed when tendered falls short", async () => {
    const user = userEvent.setup();
    render(<Harness subTotal={100} />);

    await user.type(screen.getByLabelText("Cash Receive"), "50");
    expect(screen.getByText("Still owed")).toBeInTheDocument();
    expect(screen.getByText("50.00")).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
  });

  it("requires a reference before a card payment can be confirmed", async () => {
    const user = userEvent.setup();
    render(<Harness subTotal={100} />);

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
    render(<Harness subTotal={100} customerId={5} />);

    await user.click(screen.getByRole("button", { name: "Split" }));
    expect(confirm()).toBeDisabled();

    await user.type(screen.getByLabelText("Cash Part"), "40");
    // 60 remains — Fill Due puts the remainder on the customer's account.
    await user.click(screen.getByRole("button", { name: "Fill Due" }));
    expect(screen.getByText(/Remaining: ৳0\.00/)).toBeInTheDocument();
    expect(confirm()).toBeEnabled();

    const payments = (
      (window as unknown as Record<string, any>).__cartForm as {
        getValues: (n: string) => any;
      }
    ).getValues("payments");
    expect(payments[0]).toMatchObject({ method: "cash", amount: 40 });
    expect(payments[2]).toMatchObject({ method: "due", amount: 60 });
  });

  it("disables the due part entirely for a walk-in (no customer)", async () => {
    const user = userEvent.setup();
    render(<Harness subTotal={100} customerId={null} />);

    await user.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.getByLabelText("Due part")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Fill Due" })).toBeDisabled();
  });

  it("blocks due and store-credit methods without a customer", async () => {
    render(<Harness subTotal={100} customerId={null} />);
    expect(screen.getByRole("button", { name: "Due" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Store credit" })).toBeDisabled();
  });
});
