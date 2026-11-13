import api from "../../api/axios.js";

export type CommChannel = "sms" | "whatsapp" | "email";

export interface CommProvider {
  id: number;
  channel: CommChannel;
  providerKey: "console" | "generic_http" | "whatsapp_cloud" | "resend";
  displayName: string | null;
  isDefault: boolean;
  isActive: boolean;
  configPreview: Record<string, unknown> | null;
}

export interface CommTemplate {
  id: number;
  templateKey: string;
  channel: CommChannel;
  name: string;
  body: string;
  isActive: boolean;
}

export interface CommSettings {
  autoReceiptEnabled: boolean;
  dueRemindersEnabled: boolean;
  dailyCapPerCustomer: number;
  hasWebhookSecret: boolean;
}

export interface CommMessageRow {
  id: number;
  channel: string;
  providerKey: string;
  recipient: string;
  customerId: number | null;
  templateKey: string;
  messageClass: string;
  body: string;
  status: "queued" | "sent" | "failed";
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

export async function listProvidersApi(): Promise<CommProvider[]> {
  const res = await api.get<{ success: boolean; data: CommProvider[] }>(
    "/comms/providers",
  );
  return res.data.data;
}

export async function putProviderApi(input: {
  channel: CommChannel;
  providerKey: string;
  displayName?: string | null;
  config?: Record<string, unknown> | null;
  isDefault?: boolean;
  isActive?: boolean;
}): Promise<void> {
  await api.put("/comms/providers", input);
}

export async function listTemplatesApi(): Promise<CommTemplate[]> {
  const res = await api.get<{ success: boolean; data: CommTemplate[] }>(
    "/comms/templates",
  );
  return res.data.data;
}

export async function putTemplateApi(input: {
  templateKey: string;
  channel: CommChannel;
  name: string;
  body: string;
  isActive: boolean;
}): Promise<void> {
  await api.put("/comms/templates", input);
}

export async function getCommSettingsApi(): Promise<CommSettings> {
  const res = await api.get<{ success: boolean; data: CommSettings }>(
    "/comms/settings",
  );
  return res.data.data;
}

export async function putCommSettingsApi(
  patch: Partial<CommSettings>,
): Promise<CommSettings> {
  const res = await api.put<{ success: boolean; data: CommSettings }>(
    "/comms/settings",
    patch,
  );
  return res.data.data;
}

export async function listMessagesApi(filters: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: CommMessageRow[]; total: number }> {
  const res = await api.get<{
    success: boolean;
    data: { rows: CommMessageRow[]; total: number };
  }>("/comms/messages", {
    params: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.limit ? { limit: String(filters.limit) } : {}),
      ...(filters.offset ? { offset: String(filters.offset) } : {}),
    },
  });
  return res.data.data;
}

export async function getWebhookSecretApi(): Promise<string> {
  const res = await api.post<{ success: boolean; data: { secret: string } }>(
    "/comms/webhook-secret",
  );
  return res.data.data.secret;
}

/** Outcome of a manual send — mirrors the backend SendOutcome. */
export interface SendReceiptOutcome {
  status: "sent" | "failed" | "skipped";
  reason?: string;
  messageId?: number;
}

/**
 * Sends the sale_receipt template for a completed sale through the manual
 * comms endpoint (comms.manage). The recipient comes from the customer's
 * record; delivery is recorded on the comm_messages log with the provider
 * status. Requires comms.manage on the caller — the UI gates the action.
 */
export async function sendSaleReceiptApi(input: {
  saleId: number;
  channel: CommChannel;
  customerId: number;
  recipient: string;
  variables: { invoiceNumber: string; total: number; paid: number; due: number };
}): Promise<SendReceiptOutcome> {
  const res = await api.post<{ success: boolean; data: SendReceiptOutcome }>(
    "/comms/send",
    {
      channel: input.channel,
      customerId: input.customerId,
      recipient: input.recipient,
      templateKey: "sale_receipt",
      messageClass: "transactional",
      entityType: "sale",
      entityId: input.saleId,
      variables: input.variables,
      reason: "pos_receipt_send",
    },
  );
  return res.data.data;
}
