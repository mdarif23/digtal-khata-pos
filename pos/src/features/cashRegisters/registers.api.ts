import api from "../../api/axios.js";

/** Manual drawer movement types — direction carried by the type. */
export type ManualMovementType =
  | "cash_in"
  | "cash_out"
  | "safe_deposit"
  | "safe_withdrawal"
  | "adjustment_in"
  | "adjustment_out";

export const MOVEMENT_LABELS: Record<ManualMovementType, string> = {
  cash_in: "Cash in",
  cash_out: "Cash out",
  safe_deposit: "Safe deposit (drop)",
  safe_withdrawal: "Safe withdrawal",
  adjustment_in: "Adjustment +",
  adjustment_out: "Adjustment −",
};

/** One row of a counted cash sheet (Phase 1). */
export interface DenominationCount {
  value: number;
  count: number;
}

export interface RegisterSummary {
  id: number;
  name: string;
  status: string;
  openSession: {
    id: number;
    userName: string;
    openingCash: number;
    openedAt: string | null;
  } | null;
}

export interface RegisterSession {
  id: number;
  registerId: number;
  registerName: string;
  locationId: number;
  locationName: string;
  userName: string;
  /** Terminal attribution (multi-terminal Phase 1). */
  terminalId: number | null;
  terminalName: string | null;
  status: string;
  openingCash: number;
  expectedCash: number;
  countedCash: number | null;
  difference: number | null;
  notes: string | null;
  openedAt: string | null;
  closedAt: string | null;
  openingDenominations?: DenominationCount[] | null;
  countedDenominations?: DenominationCount[] | null;
}

export interface RegisterTransaction {
  id: number;
  type:
    | "sale"
    | "cash_in"
    | "cash_out"
    | "cash_refund"
    | "safe_deposit"
    | "safe_withdrawal"
    | "adjustment_in"
    | "adjustment_out";
  amount: number;
  referenceType: string | null;
  referenceId: number | null;
  note: string | null;
  userName: string;
  createdAt: string | null;
  /** Cash-drop metadata (safe_deposit only, Phase 1). */
  recipientUserId: number | null;
  recipientName: string | null;
  referenceNo: string | null;
  confirmedBy: number | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
}

export async function getRegistersApi(): Promise<RegisterSummary[]> {
  const res = await api.get<{ success: boolean; data: RegisterSummary[] }>(
    "/registers",
  );
  return res.data.data;
}

export async function getCurrentSessionApi(): Promise<RegisterSession | null> {
  const res = await api.get<{ success: boolean; data: RegisterSession | null }>(
    "/sessions/current",
  );
  return res.data.data;
}

export async function getDenominationsApi(): Promise<number[]> {
  const res = await api.get<{ success: boolean; data: number[] }>(
    "/registers/denominations",
  );
  return res.data.data;
}

export async function setDenominationsApi(denominations: number[]): Promise<number[]> {
  const res = await api.put<{ success: boolean; data: number[] }>(
    "/registers/denominations",
    { denominations },
  );
  return res.data.data;
}

export async function openRegisterApi(
  registerId: number,
  openingCash: number,
  openingDenominations?: DenominationCount[],
): Promise<RegisterSession> {
  const res = await api.post<{ success: true; data: RegisterSession }>(
    `/registers/${registerId}/open`,
    {
      openingCash,
      ...(openingDenominations?.length
        ? { openingDenominations }
        : {}),
    },
  );
  return res.data.data;
}

export async function addCashMovementApi(
  sessionId: number,
  type: ManualMovementType,
  amount: number,
  note?: string,
  opts?: { referenceNo?: string; approvalToken?: string },
): Promise<RegisterSession> {
  const res = await api.post<{ success: boolean; data: RegisterSession }>(
    `/sessions/${sessionId}/cash-movement`,
    {
      type,
      amount,
      ...(note ? { note } : {}),
      ...(opts?.referenceNo ? { referenceNo: opts.referenceNo } : {}),
      ...(opts?.approvalToken ? { approvalToken: opts.approvalToken } : {}),
    },
  );
  return res.data.data;
}

export async function closeRegisterApi(
  sessionId: number,
  countedCash: number,
  notes?: string,
  countedDenominations?: DenominationCount[],
): Promise<RegisterSession> {
  const res = await api.post<{ success: boolean; data: RegisterSession }>(
    `/sessions/${sessionId}/close`,
    {
      countedCash,
      ...(notes ? { notes } : {}),
      ...(countedDenominations?.length ? { countedDenominations } : {}),
    },
  );
  return res.data.data;
}

/** Mid-shift blind count — records interim variance, never a movement. */
export async function reconcileRegisterApi(
  sessionId: number,
  countedCash: number,
  countedDenominations?: DenominationCount[],
  notes?: string,
): Promise<{ reconciliationId: number; expected: number; difference: number }> {
  const res = await api.post<{
    success: boolean;
    data: { reconciliationId: number; expected: number; difference: number };
  }>(`/sessions/${sessionId}/reconcile`, {
    countedCash,
    ...(countedDenominations?.length ? { countedDenominations } : {}),
    ...(notes ? { notes } : {}),
  });
  return res.data.data;
}

/** Controlled reopen — ALWAYS requires a manager approval token. */
export async function reopenRegisterApi(
  sessionId: number,
  approvalToken: string,
  reason?: string,
): Promise<RegisterSession> {
  const res = await api.post<{ success: boolean; data: RegisterSession }>(
    `/sessions/${sessionId}/reopen`,
    { approvalToken, ...(reason ? { reason } : {}) },
  );
  return res.data.data;
}

export async function confirmDropApi(
  sessionId: number,
  transactionId: number,
): Promise<{ id: number; confirmedAt: string }> {
  const res = await api.post<{
    success: boolean;
    data: { id: number; confirmedAt: string };
  }>(`/sessions/${sessionId}/transactions/${transactionId}/confirm-drop`);
  return res.data.data;
}

export type { RegisterTransaction as SessionDetail };
export async function getSessionApi(sessionId: number): Promise<
  RegisterSession & { transactions: RegisterTransaction[] }
> {
  const res = await api.get<{
    success: boolean;
    data: RegisterSession & { transactions: RegisterTransaction[] };
  }>(`/sessions/${sessionId}`);
  return res.data.data;
}

// ---------------------------------------------------------------------------
// Manager PIN approvals (Phase 1)
// ---------------------------------------------------------------------------

export interface ApprovalOpInfo {
  opType: string;
  permission: string;
  required: boolean;
  callerCanApprove: boolean;
  hasPin: boolean;
}

export interface ApprovalOpsResponse {
  ops: ApprovalOpInfo[];
  policy: {
    approvalTtlMinutes: number;
    maxPinFailures: number;
    lockoutMinutes: number;
  };
}

export async function getApprovalOpsApi(): Promise<ApprovalOpsResponse> {
  const res = await api.get<{ success: boolean; data: ApprovalOpsResponse }>(
    "/manager-approval/ops",
  );
  return res.data.data;
}

export async function setManagerPinApi(pin: string): Promise<void> {
  await api.post("/manager-approval/pin", { pin });
}

export async function deleteManagerPinApi(): Promise<void> {
  await api.delete("/manager-approval/pin");
}

/** Verifies the caller's own PIN and returns a one-time op-bound token. */
export async function verifyPinApi(input: {
  pin: string;
  opType: string;
  entityType?: string;
  entityId?: number;
  payload?: Record<string, unknown>;
  reason?: string;
}): Promise<{ approvalToken: string; expiresAt: string }> {
  const res = await api.post<{
    success: boolean;
    data: { approvalToken: string; expiresAt: string };
  }>("/manager-approval/verify", input);
  return res.data.data;
}
