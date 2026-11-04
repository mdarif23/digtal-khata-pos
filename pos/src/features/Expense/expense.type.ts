export type ExpensePaymentMethod = "Cash" | "Mobile" | "Card";
export type ExpensePaymentStatus = "unpaid" | "partial" | "paid";
export type ExpenseChannel = "woocommerce" | "custom_storefront";

export interface ExpenseCategory {
  id: number;
  categoryName: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  archivedAt?: string | null;
}

export interface ExpensePayment {
  id: number;
  amount: number;
  paymentMethod: ExpensePaymentMethod;
  paymentDate: string;
  referenceNo: string | null;
  note: string | null;
  recordedBy: number | null;
  registerSessionId: number | null;
  createdAt: string | null;
}

/** Row shape returned by GET /expenses (list) and GET /expenses/export. */
export interface ExpenseRecord {
  id: number;
  title: string;
  payee: string | null;
  amount: number;
  paidAmount: number;
  paymentStatus: ExpensePaymentStatus;
  paymentMethod: ExpensePaymentMethod | null;
  categoryId: number | null;
  categoryName: string | null;
  locationId: number | null;
  locationName: string | null;
  channel: ExpenseChannel | null;
  referenceNo: string | null;
  note: string | null;
  expenseDate: string;
  createdAt: string | null;
}

export interface ExpenseAttachment {
  id: number;
  fileName: string;
  contentType: string;
  bytes: number;
  uploadedBy: number | null;
  createdAt: string | null;
}

/** Detail shape returned by GET /expenses/:id (adds the payment ledger). */
export interface ExpenseDetail extends ExpenseRecord {
  dueAmount: number;
  payments: ExpensePayment[];
  attachments: ExpenseAttachment[];
  createdBy: number | null;
  updatedBy: number | null;
  deletedAt: string | null;
  voidReason: string | null;
}

export interface ExpenseSummary {
  totalAmount: number;
  totalPaid: number;
  totalDue: number;
  unpaidCount: number;
  partialCount: number;
  paidCount: number;
}

export interface ExpenseListMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  summary: ExpenseSummary;
}

export interface ExpenseListResponse {
  data: ExpenseRecord[];
  meta: ExpenseListMeta;
}

/** Server-side list filters; values arrive at the API as snake_case params. */
export interface ExpenseListFilters {
  page: number;
  pageSize: number;
  search?: string | undefined;
  categoryId?: number | "none" | undefined;
  paymentStatus?: ExpensePaymentStatus | undefined;
  paymentMethod?: ExpensePaymentMethod | undefined;
  channel?: ExpenseChannel | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  locationId?: number | undefined;
  sort: "expense_date" | "amount" | "title" | "payment_status" | "created_at";
  sortDir: "asc" | "desc";
}

export interface ExpenseDraft {
  title: string;
  expenseDate: string;
  amount: number;
  categoryId: number | null;
  paymentMethod: ExpensePaymentMethod;
  payee: string | null;
  referenceNo: string | null;
  note: string | null;
  /** Settlement intent at creation (edit mode ignores this). */
  settlement: "full" | "partial" | "unpaid";
  /** Required when settlement = "partial": the amount settled now. */
  initialPaymentAmount?: number | undefined;
}

// ---------------------------------------------------------------------------
// Analytics (Phase 5)
// ---------------------------------------------------------------------------

export type ExpenseTrendGranularity = "day" | "week" | "month";

export interface ExpenseAnalytics {
  range: { from: string; to: string; granularity: ExpenseTrendGranularity };
  totals: {
    totalCount: number;
    totalAmount: number;
    totalPaid: number;
    totalDue: number;
    averageAmount: number;
    unpaidCount: number;
    partialCount: number;
    paidCount: number;
  };
  comparison: {
    currentMonth: string;
    currentAmount: number;
    previousAmount: number;
    growthPercent: number | null;
  };
  series: Array<{ bucket: string; count: number; amount: number; paid: number }>;
  categories: Array<{
    categoryId: number | null;
    categoryName: string | null;
    amount: number;
    paid: number;
    count: number;
  }>;
  paymentMethods: Array<{
    method: ExpensePaymentMethod | null;
    amount: number;
    paid: number;
    count: number;
  }>;
  locations: Array<{
    locationId: number | null;
    locationName: string | null;
    amount: number;
    paid: number;
    count: number;
  }>;
}
