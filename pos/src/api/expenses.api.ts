import axios from "./axios.js";
import type {
  ExpenseAnalytics,
  ExpenseAttachment,
  ExpenseCategory,
  ExpenseDetail,
  ExpenseDraft,
  ExpenseListFilters,
  ExpenseListResponse,
  ExpensePayment,
  ExpensePaymentMethod,
  ExpenseRecord,
} from "@/features/Expense/expense.type";
import type { ExpenseTrendGranularity } from "@/features/Expense/expense.type";

/** Input for POST /expenses/:id/payments. */
export interface ExpensePaymentPayload {
  amount: number;
  paymentMethod: ExpensePaymentMethod;
  paymentDate?: string;
  referenceNo?: string | null;
  note?: string | null;
  registerSessionId?: number | null;
  clientUuid?: string;
}

function listParams(filters: ExpenseListFilters): Record<string, string> {
  const params: Record<string, string> = {
    page: String(filters.page),
    page_size: String(filters.pageSize),
    sort: filters.sort,
    sort_dir: filters.sortDir,
  };
  if (filters.search) params.search = filters.search;
  if (filters.categoryId !== undefined) {
    params.category_id = filters.categoryId === "none" ? "none" : String(filters.categoryId);
  }
  if (filters.paymentStatus) params.payment_status = filters.paymentStatus;
  if (filters.paymentMethod) params.payment_method = filters.paymentMethod;
  if (filters.channel) params.channel = filters.channel;
  if (filters.dateFrom) params.date_from = filters.dateFrom;
  if (filters.dateTo) params.date_to = filters.dateTo;
  if (filters.locationId) params.locationId = String(filters.locationId);
  return params;
}

export async function getExpensesApi(filters: ExpenseListFilters) {
  const { data } = await axios.get<{
    success: boolean;
    data: ExpenseRecord[];
    meta: ExpenseListResponse["meta"];
  }>("/expenses", { params: listParams(filters) });
  return { data: data.data, meta: data.meta };
}

export async function exportExpensesApi(filters: ExpenseListFilters) {
  const { data } = await axios.get<{
    success: boolean;
    data: ExpenseRecord[];
  }>("/expenses/export", { params: listParams(filters) });
  return data.data;
}

export async function getExpenseApi(id: number) {
  const { data } = await axios.get<{ success: boolean; data: ExpenseDetail }>(
    `/expenses/${id}`,
  );
  return data.data;
}

export async function getExpenseAnalyticsApi(filters: {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  granularity: ExpenseTrendGranularity;
  locationId?: number | undefined;
}) {
  const params: Record<string, string> = {
    granularity: filters.granularity,
  };
  if (filters.dateFrom) params.date_from = filters.dateFrom;
  if (filters.dateTo) params.date_to = filters.dateTo;
  if (filters.locationId) params.locationId = String(filters.locationId);
  const { data } = await axios.get<{ success: boolean; data: ExpenseAnalytics }>(
    "/expenses/analytics",
    { params },
  );
  return data.data;
}

export async function getExpenseCategoriesApi(includeArchived = false) {
  const { data } = await axios.get<ExpenseCategory[]>("/expense_categories", {
    params: includeArchived ? { include_archived: "true" } : undefined,
  });
  return data;
}

function settlementPayload(expenseData: ExpenseDraft) {
  if (expenseData.settlement === "unpaid") {
    return { record_as: "unpaid" as const, initial_payment: null };
  }
  if (
    expenseData.settlement === "partial" &&
    expenseData.initialPaymentAmount &&
    expenseData.initialPaymentAmount > 0
  ) {
    return {
      record_as: undefined,
      initial_payment: { amount: expenseData.initialPaymentAmount },
    };
  }
  return { record_as: undefined, initial_payment: null };
}

export async function createExpenseApi(expenseData: ExpenseDraft) {
  const { data } = await axios.post<ExpenseDetail>("/expenses", {
    title: expenseData.title,
    expense_date: expenseData.expenseDate,
    amount: expenseData.amount,
    category_id: expenseData.categoryId,
    payment_method: expenseData.paymentMethod,
    payee: expenseData.payee || null,
    reference_no: expenseData.referenceNo || null,
    note: expenseData.note || null,
    ...settlementPayload(expenseData),
  });
  return data;
}

export async function updateExpenseApi(id: number, expenseData: ExpenseDraft) {
  const { data } = await axios.patch<ExpenseDetail>(`/expenses/${id}`, {
    title: expenseData.title,
    expense_date: expenseData.expenseDate,
    amount: expenseData.amount,
    category_id: expenseData.categoryId,
    payment_method: expenseData.paymentMethod,
    payee: expenseData.payee || null,
    reference_no: expenseData.referenceNo || null,
    note: expenseData.note || null,
  });
  return data;
}

/** Soft void — the server retains the row so historical reports stay reproducible. */
export async function voidExpenseApi(id: number, reason?: string) {
  await axios.delete(`/expenses/${id}`, {
    data: reason ? { reason } : undefined,
  });
}

export async function createExpenseCategoryApi(payload: {
  categoryName: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
}) {
  const { data } = await axios.post<ExpenseCategory>("/expense_categories", {
    categoryName: payload.categoryName,
    description: payload.description ?? null,
    color: payload.color ?? null,
    icon: payload.icon ?? null,
  });
  return data;
}

export async function updateExpenseCategoryApi(
  id: number,
  payload: {
    categoryName: string;
    description?: string | null;
    color?: string | null;
    icon?: string | null;
  },
) {
  const { data } = await axios.patch<ExpenseCategory>(
    `/expense_categories/${id}`,
    {
      categoryName: payload.categoryName,
      description: payload.description ?? null,
      color: payload.color ?? null,
      icon: payload.icon ?? null,
    },
  );
  return data;
}

export async function archiveExpenseCategoryApi(id: number) {
  const { data } = await axios.post<{ success: boolean; data: ExpenseCategory }>(
    `/expense_categories/${id}/archive`,
  );
  return data.data;
}

export async function restoreExpenseCategoryApi(id: number) {
  const { data } = await axios.post<{ success: boolean; data: ExpenseCategory }>(
    `/expense_categories/${id}/restore`,
  );
  return data.data;
}

export async function getExpensePaymentsApi(expenseId: number) {
  const { data } = await axios.get<{ success: boolean; data: ExpensePayment[] }>(
    `/expenses/${expenseId}/payments`,
  );
  return data.data;
}

export async function recordExpensePaymentApi(
  expenseId: number,
  payload: ExpensePaymentPayload,
) {
  const { data } = await axios.post<{
    success: boolean;
    data: {
      payment: ExpensePayment;
      duplicate: boolean;
      paidAmount: number;
      paymentStatus: ExpenseDetail["paymentStatus"];
    };
  }>(`/expenses/${expenseId}/payments`, {
    amount: payload.amount,
    payment_method: payload.paymentMethod,
    payment_date: payload.paymentDate || undefined,
    reference_no: payload.referenceNo || null,
    note: payload.note || null,
    register_session_id: payload.registerSessionId ?? null,
    client_uuid: payload.clientUuid ?? null,
  });
  return data.data;
}

export async function voidExpensePaymentApi(
  expenseId: number,
  paymentId: number,
) {
  await axios.delete(`/expenses/${expenseId}/payments/${paymentId}`);
}

/**
 * Current open register session for the signed-in user — used to auto-tie
 * Cash settlements to the drawer (approved decision D3).
 */
export async function getCurrentRegisterSessionApi(): Promise<{
  id: number;
} | null> {
  try {
    const { data } = await axios.get<{
      success: boolean;
      data: { id?: number } | null;
    }>("/registers/sessions/current");
    const id = data.data?.id;
    return id ? { id } : null;
  } catch {
    // No open session (or endpoint unavailable) — payments still record.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Attachments (Phase 4) — presigned PUT straight to object storage.
// ---------------------------------------------------------------------------

export const ATTACHMENT_ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";
/** Keep in sync with the backend's MEDIA_MAX_UPLOAD_MB default. */
export const ATTACHMENT_MAX_MB = 10;

export async function getAttachmentUrlApi(attachmentId: number) {
  const { data } = await axios.get<{
    success: boolean;
    data: { id: number; fileName: string; downloadUrl: string; expiresIn: number };
  }>(`/attachments/${attachmentId}/url`);
  return data.data;
}

export async function deleteAttachmentApi(attachmentId: number) {
  await axios.delete(`/attachments/${attachmentId}`);
}

/**
 * Three-step upload: presign → browser PUT → register. Returns the created
 * attachment metadata row.
 */
export async function uploadExpenseAttachmentApi(
  expenseId: number,
  file: File,
): Promise<ExpenseAttachment> {
  const presign = await axios.post<{
    success: boolean;
    data: { objectKey: string; uploadUrl: string; expiresIn: number };
  }>(`/expenses/${expenseId}/attachments/presign`, {
    fileName: file.name,
    contentType: file.type || "application/pdf",
    sizeBytes: file.size,
  });
  const { objectKey, uploadUrl } = presign.data.data;

  const put = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type || "application/pdf" },
  });
  if (!put.ok) {
    throw new Error(`Upload failed (${String(put.status)})`);
  }

  const register = await axios.post<{
    success: boolean;
    data: ExpenseAttachment;
  }>(`/expenses/${expenseId}/attachments`, {
    objectKey,
    fileName: file.name,
    contentType: file.type || "application/pdf",
    bytes: file.size,
  });
  return register.data.data;
}
