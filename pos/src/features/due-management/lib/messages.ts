import { formatCurrency, formatDate } from "@/lib/format";

export type MessageTemplateKey =
  | "friendly_reminder"
  | "overdue_reminder"
  | "payment_received"
  | "remaining_balance"
  | "supplier_payment";

export type MessageContext = {
  isCustomer: boolean;
  name: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  totalAmount: number;
  outstandingAmount: number;
  paymentAmount?: number;
  shopName?: string;
};

export type MessageTemplate = {
  key: MessageTemplateKey;
  label: string;
  audience: "customer" | "supplier";
  build: (ctx: MessageContext) => string;
};

const shop = (ctx: MessageContext) => ctx.shopName?.trim() || "our shop";

export const MESSAGE_TEMPLATES: MessageTemplate[] = [
  {
    key: "friendly_reminder",
    label: "Friendly payment reminder",
    audience: "customer",
    build: (ctx) =>
      `Hello ${ctx.name}, this is a friendly reminder from ${shop(ctx)}. Invoice ${ctx.invoiceNumber} dated ${formatDate(ctx.invoiceDate)} has a remaining balance of ${formatCurrency(ctx.outstandingAmount)}. Please pay at your convenience. Thank you!`,
  },
  {
    key: "overdue_reminder",
    label: "Overdue payment reminder",
    audience: "customer",
    build: (ctx) =>
      `Dear ${ctx.name}, invoice ${ctx.invoiceNumber} (dated ${formatDate(ctx.invoiceDate)}) from ${shop(ctx)} is past due. Outstanding amount: ${formatCurrency(ctx.outstandingAmount)}. Kindly clear the balance at your earliest convenience. If you have already paid, please ignore this message.`,
  },
  {
    key: "payment_received",
    label: "Payment received confirmation",
    audience: "customer",
    build: (ctx) =>
      `Dear ${ctx.name}, we have received your payment of ${formatCurrency(ctx.paymentAmount ?? 0)} for invoice ${ctx.invoiceNumber}. Remaining balance: ${formatCurrency(ctx.outstandingAmount)}. Thank you for your business! — ${shop(ctx)}`,
  },
  {
    key: "remaining_balance",
    label: "Remaining balance notification",
    audience: "customer",
    build: (ctx) =>
      `Dear ${ctx.name}, your account at ${shop(ctx)} currently has a balance of ${formatCurrency(ctx.outstandingAmount)} across invoice ${ctx.invoiceNumber}. Visit us or transfer anytime to settle it. Thank you.`,
  },
  {
    key: "supplier_payment",
    label: "Supplier payment confirmation",
    audience: "supplier",
    build: (ctx) =>
      `Dear ${ctx.name}, we have recorded a payment of ${formatCurrency(ctx.paymentAmount ?? 0)} for purchase ${ctx.invoiceNumber}. Remaining payable: ${formatCurrency(ctx.outstandingAmount)}. Thank you. — ${shop(ctx)}`,
  },
];

export function templatesFor(audience: "customer" | "supplier") {
  return MESSAGE_TEMPLATES.filter((template) => template.audience === audience);
}
