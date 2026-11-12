import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import {
  commMessages,
  commProviders,
  commSettings,
  commTemplates,
} from "../db/schema/comms.js";
import { customers } from "../db/schema/customers.js";
import { sales } from "../db/schema/sales.js";
import { env } from "../config/env.js";
import { recordAudit } from "./audit.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/handleError.js";

/**
 * Customer communication service (Phase 2C — master prompt Feature 6).
 *
 * Provider abstraction: console (dev default), generic_http (any Bangladesh
 * SMS gateway with a simple REST API — URL/headers/body are configured per
 * business with {{recipient}}/{{body}} placeholders), whatsapp_cloud (the
 * OFFICIAL Meta WhatsApp Business Cloud API), resend (email). Configs are
 * AES-256-GCM encrypted at rest; the API exposes only masked previews.
 *
 * Consent (F6-F): marketing sends REQUIRE the customer's marketing_opt_in;
 * transactional sends are skipped when transactional_opt_out is set; a
 * per-customer daily cap prevents abuse. Messages persist BEFORE delivery.
 */

// ---------------------------------------------------------------------------
// Config encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

function configKey(): Buffer {
  const secret =
    process.env.EZPOS_COMM_SECRET ??
    process.env.AUTH_JWT_SECRET ??
    "ezpos-dev-only-secret";
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptConfig(config: Record<string, unknown>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", configKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(config), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptConfig(encrypted: string): Record<string, unknown> {
  const [ivB64, tagB64, dataB64] = encrypted.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed provider config ciphertext.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    configKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
}

const SECRET_KEYS = /(key|token|secret|password|authorization)/i;

/** The masked preview the API returns — never the secrets themselves. */
export function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = SECRET_KEYS.test(key)
      ? typeof value === "string" && value.length > 4
        ? `${value.slice(0, 2)}••••`
        : "••••"
      : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface DeliveryResult {
  providerMessageId: string | null;
}

async function deliverViaConsole(
  recipient: string,
  body: string,
  channel: string,
): Promise<DeliveryResult> {
  // Dev/observability provider: logs instead of sending. Marks messages
  // sent so the flow is testable end-to-end without credentials.
  console.info(`[comms:${channel}] -> ${recipient}: ${body.slice(0, 160)}`);
  return { providerMessageId: `console-${randomBytes(6).toString("hex")}` };
}

async function deliverViaWhatsappCloud(
  config: Record<string, unknown>,
  recipient: string,
  body: string,
): Promise<DeliveryResult> {
  const phoneNumberId = String(config.phoneNumberId ?? "");
  const accessToken = String(config.accessToken ?? "");
  if (!phoneNumberId || !accessToken) {
    throw new Error("whatsapp_cloud requires phoneNumberId and accessToken.");
  }
  const to = recipient.replace(/[^\d]/g, "");
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WhatsApp Cloud API error ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    messages?: { id: string }[];
  };
  return { providerMessageId: json.messages?.[0]?.id ?? null };
}

async function deliverViaGenericHttp(
  config: Record<string, unknown>,
  recipient: string,
  body: string,
): Promise<DeliveryResult> {
  const urlTemplate = String(config.url ?? "");
  if (!urlTemplate) {
    throw new Error("generic_http requires a configured url template.");
  }
  const url = urlTemplate
    .replace(/\{\{recipient\}\}/g, encodeURIComponent(recipient))
    .replace(/\{\{body\}\}/g, encodeURIComponent(body));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const headerConfig = (config.headers ?? {}) as Record<string, string>;
  for (const [key, value] of Object.entries(headerConfig)) {
    headers[key] = String(value);
  }
  const method = String(config.method ?? "POST").toUpperCase();
  let payload: string | undefined;
  if (method === "POST" || method === "PUT") {
    const bodyTemplate = String(config.body ?? "");
    payload = bodyTemplate
      ? bodyTemplate
          .replace(/\{\{recipient\}\}/g, recipient)
          .replace(/\{\{body\}\}/g, body.replace(/"/g, '\\"'))
      : JSON.stringify({ recipient, body });
  }
  const res = await fetch(url, {
    method,
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Provider error ${res.status}: ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  let id: string | null = null;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    id = (json.message_id ?? json.messageId ?? json.id ?? null) as string | null;
  } catch {
    id = null;
  }
  return { providerMessageId: id };
}

async function deliverViaResend(
  config: Record<string, unknown>,
  recipient: string,
  subject: string,
  body: string,
): Promise<DeliveryResult> {
  const apiKey = String(config.apiKey ?? "");
  const from = String(config.from ?? "");
  if (!apiKey || !from) {
    throw new Error("resend requires apiKey and from.");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [recipient],
      subject: subject || "Message from your store",
      text: body,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend error ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { id?: string };
  return { providerMessageId: json.id ?? null };
}

// ---------------------------------------------------------------------------
// Templates + settings
// ---------------------------------------------------------------------------

export const DEFAULT_TEMPLATES: Record<string, string> = {
  sale_receipt:
    "Thank you for your purchase! Invoice {{invoiceNumber}} — Total ৳{{total}}. Paid ৳{{paid}}. Due ৳{{due}}.",
  due_reminder:
    "Dear {{customerName}}, a friendly reminder: your invoice {{invoiceNumber}} has ৳{{due}} outstanding. Please pay at your convenience.",
  payment_received:
    "Payment received: ৳{{amount}} for invoice {{invoiceNumber}}. Thank you!",
  custom: "{{body}}",
};

export async function getCommSettings(businessId: number) {
  const [row] = await db
    .select()
    .from(commSettings)
    .where(eq(commSettings.businessId, businessId))
    .limit(1);
  return row ?? null;
}

export async function getCommSettingsWithDefaults(businessId: number) {
  const row = await getCommSettings(businessId);
  return {
    autoReceiptEnabled: row?.autoReceiptEnabled ?? false,
    dueRemindersEnabled: row?.dueRemindersEnabled ?? false,
    dailyCapPerCustomer: row?.dailyCapPerCustomer ?? 3,
    hasWebhookSecret: Boolean(row?.webhookSecret),
  };
}

export async function upsertCommSettings(
  businessId: number,
  patch: {
    autoReceiptEnabled?: boolean | undefined;
    dueRemindersEnabled?: boolean | undefined;
    dailyCapPerCustomer?: number | undefined;
  },
) {
  const current = await getCommSettings(businessId);
  await db
    .insert(commSettings)
    .values({
      businessId,
      autoReceiptEnabled: patch.autoReceiptEnabled ?? current?.autoReceiptEnabled ?? false,
      dueRemindersEnabled: patch.dueRemindersEnabled ?? current?.dueRemindersEnabled ?? false,
      dailyCapPerCustomer: patch.dailyCapPerCustomer ?? current?.dailyCapPerCustomer ?? 3,
    })
    .onConflictDoUpdate({
      target: commSettings.businessId,
      set: {
        ...(patch.autoReceiptEnabled !== undefined
          ? { autoReceiptEnabled: patch.autoReceiptEnabled }
          : {}),
        ...(patch.dueRemindersEnabled !== undefined
          ? { dueRemindersEnabled: patch.dueRemindersEnabled }
          : {}),
        ...(patch.dailyCapPerCustomer !== undefined
          ? { dailyCapPerCustomer: patch.dailyCapPerCustomer }
          : {}),
        updatedAt: new Date(),
      },
    });
  return getCommSettingsWithDefaults(businessId);
}

export async function listTemplates(businessId: number) {
  return db
    .select()
    .from(commTemplates)
    .where(eq(commTemplates.businessId, businessId))
    .orderBy(commTemplates.templateKey, commTemplates.channel);
}

export async function upsertTemplate(
  businessId: number,
  input: {
    templateKey: string;
    channel: string;
    name: string;
    body: string;
    isActive: boolean;
  },
) {
  if (!DEFAULT_TEMPLATES.hasOwnProperty(input.templateKey)) {
    throw new BadRequestError("Unknown template key.");
  }
  if (!["sms", "whatsapp", "email"].includes(input.channel)) {
    throw new BadRequestError("Invalid channel.");
  }
  const [row] = await db
    .insert(commTemplates)
    .values({
      businessId,
      templateKey: input.templateKey,
      channel: input.channel,
      name: input.name,
      body: input.body,
      isActive: input.isActive,
    })
    .onConflictDoUpdate({
      target: [
        commTemplates.businessId,
        commTemplates.templateKey,
        commTemplates.channel,
      ],
      set: {
        name: input.name,
        body: input.body,
        isActive: input.isActive,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("Template upsert returned no row.");
  return row;
}

export async function renderTemplate(
  businessId: number,
  templateKey: string,
  channel: string,
  variables: Record<string, string | number>,
): Promise<string> {
  const [template] = await db
    .select()
    .from(commTemplates)
    .where(
      and(
        eq(commTemplates.businessId, businessId),
        eq(commTemplates.templateKey, templateKey),
        eq(commTemplates.channel, channel),
        eq(commTemplates.isActive, true),
      ),
    )
    .limit(1);
  const body = template?.body ?? DEFAULT_TEMPLATES[templateKey] ?? "{{body}}";
  return body.replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
    variables[key] !== undefined ? String(variables[key]) : `{{${key}}}`,
  );
}

// ---------------------------------------------------------------------------
// Provider rows
// ---------------------------------------------------------------------------

export async function listProviders(businessId: number) {
  const rows = await db
    .select()
    .from(commProviders)
    .where(eq(commProviders.businessId, businessId))
    .orderBy(commProviders.channel);
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    providerKey: row.providerKey,
    displayName: row.displayName,
    isDefault: row.isDefault,
    isActive: row.isActive,
    configPreview:
      row.configEncrypted !== null
        ? maskConfig(safeDecrypt(row.configEncrypted))
        : null,
  }));
}

function safeDecrypt(encrypted: string): Record<string, unknown> {
  try {
    return decryptConfig(encrypted);
  } catch {
    return { _error: "undecryptable" };
  }
}

export async function upsertProvider(
  businessId: number,
  input: {
    channel: string;
    providerKey: string;
    displayName?: string | null | undefined;
    config?: Record<string, unknown> | null | undefined;
    isDefault?: boolean | undefined;
    isActive?: boolean | undefined;
  },
) {
  if (!["sms", "whatsapp", "email"].includes(input.channel)) {
    throw new BadRequestError("Invalid channel.");
  }
  if (!["console", "generic_http", "whatsapp_cloud", "resend"].includes(input.providerKey)) {
    throw new BadRequestError("Unknown provider key.");
  }
  // One default per channel (partial unique index 0069): demote the
  // current default before promoting this provider.
  if (input.isDefault) {
    await db
      .update(commProviders)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(commProviders.businessId, businessId),
          eq(commProviders.channel, input.channel),
          eq(commProviders.isDefault, true),
        ),
      );
  }
  const [row] = await db
    .insert(commProviders)
    .values({
      businessId,
      channel: input.channel,
      providerKey: input.providerKey,
      displayName: input.displayName ?? null,
      configEncrypted:
        input.config !== null && input.config !== undefined
          ? encryptConfig(input.config)
          : null,
      isDefault: input.isDefault ?? false,
      isActive: input.isActive ?? true,
    })
    .onConflictDoUpdate({
      target: [
        commProviders.businessId,
        commProviders.channel,
        commProviders.providerKey,
      ],
      set: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.config !== undefined && input.config !== null
          ? { configEncrypted: encryptConfig(input.config) }
          : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedAt: new Date(),
      },
    })
    .returning({ id: commProviders.id });
  if (!row) throw new Error("Provider upsert returned no row.");
  return row;
}

async function defaultProviderFor(
  businessId: number,
  channel: string,
): Promise<{ providerKey: string; config: Record<string, unknown> | null } | null> {
  const [row] = await db
    .select()
    .from(commProviders)
    .where(
      and(
        eq(commProviders.businessId, businessId),
        eq(commProviders.channel, channel),
        eq(commProviders.isDefault, true),
        eq(commProviders.isActive, true),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    providerKey: row.providerKey,
    config: row.configEncrypted ? safeDecrypt(row.configEncrypted) : null,
  };
}

// ---------------------------------------------------------------------------
// Sending (queue → deliver), consent + caps
// ---------------------------------------------------------------------------

export interface SendInput {
  businessId: number;
  channel: "sms" | "whatsapp" | "email";
  customerId?: number | null | undefined;
  recipient: string;
  templateKey: string;
  messageClass: "transactional" | "marketing";
  entityType?: string | null | undefined;
  entityId?: number | null | undefined;
  variables: Record<string, string | number>;
}

export interface SendOutcome {
  status: "sent" | "failed" | "skipped";
  reason?: string;
  messageId?: number;
}

/** Per-customer daily cap + consent enforcement (master prompt F6-F). */
async function consentAndCapCheck(
  businessId: number,
  input: SendInput,
): Promise<string | null> {
  if (input.customerId) {
    const [customer] = await db
      .select({
        marketingOptIn: customers.marketingOptIn,
        transactionalOptOut: customers.transactionalOptOut,
      })
      .from(customers)
      .where(
        and(
          eq(customers.id, input.customerId),
          eq(customers.businessId, businessId),
        ),
      )
      .limit(1);
    if (!customer) return "customer_not_found";
    if (input.messageClass === "marketing" && !customer.marketingOptIn) {
      return "marketing_not_opted_in";
    }
    if (
      input.messageClass === "transactional" &&
      customer.transactionalOptOut
    ) {
      return "transactional_opted_out";
    }
    const settings = await getCommSettingsWithDefaults(businessId);
    const [sentToday] = await db
      .select({ count: sql<string>`COUNT(*)` })
      .from(commMessages)
      .where(
        and(
          eq(commMessages.businessId, businessId),
          eq(commMessages.customerId, input.customerId),
          gte(commMessages.createdAt, new Date(new Date().setHours(0, 0, 0, 0))),
        ),
      );
    if (Number(sentToday?.count ?? 0) >= settings.dailyCapPerCustomer) {
      return "daily_cap_reached";
    }
  }
  return null;
}

/**
 * Queues a message (persist FIRST), then delivers best-effort. Skips
 * (with reason) on consent/cap violations. Never throws for delivery
 * failures — the failure lands on the row.
 */
export async function queueAndSend(input: SendInput): Promise<SendOutcome> {
  const skip = await consentAndCapCheck(input.businessId, input);
  if (skip) {
    return { status: "skipped", reason: skip };
  }
  const body = await renderTemplate(
    input.businessId,
    input.templateKey,
    input.channel,
    input.variables,
  );
  const [row] = await db
    .insert(commMessages)
    .values({
      businessId: input.businessId,
      channel: input.channel,
      recipient: input.recipient,
      ...(input.customerId ? { customerId: input.customerId } : {}),
      templateKey: input.templateKey,
      messageClass: input.messageClass,
      ...(input.entityType ? { entityType: input.entityType } : {}),
      ...(input.entityId ? { entityId: input.entityId } : {}),
      body,
      status: "queued",
    })
    .returning({ id: commMessages.id });
  if (!row) throw new Error("Message insert returned no row.");

  try {
    const provider = await defaultProviderFor(input.businessId, input.channel);
    const providerKey = provider?.providerKey ?? "console";
    const config = provider?.config ?? null;
    let result: DeliveryResult;
    if (providerKey === "whatsapp_cloud" && config) {
      result = await deliverViaWhatsappCloud(config, input.recipient, body);
    } else if (providerKey === "generic_http" && config) {
      result = await deliverViaGenericHttp(config, input.recipient, body);
    } else if (providerKey === "resend" && input.channel === "email" && config) {
      result = await deliverViaResend(
        config,
        input.recipient,
        String(input.variables.subject ?? "Message from your store"),
        body,
      );
    } else {
      result = await deliverViaConsole(input.recipient, body, input.channel);
    }
    await db
      .update(commMessages)
      .set({
        status: "sent",
        providerKey,
        providerMessageId: result.providerMessageId,
        sentAt: new Date(),
      })
      .where(eq(commMessages.id, row.id));
    return { status: "sent", messageId: row.id };
  } catch (err) {
    await db
      .update(commMessages)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message.slice(0, 500) : "Delivery failed.",
        retryCount: sql`${commMessages.retryCount} + 1`,
      })
      .where(eq(commMessages.id, row.id));
    return { status: "failed", reason: "delivery_failed", messageId: row.id };
  }
}

/** Manual send (comms.manage): receipts, reminders, custom notifications. */
export async function sendManualMessage(
  businessId: number,
  userId: number,
  input: SendInput & { reason?: string | undefined },
): Promise<SendOutcome> {
  const outcome = await queueAndSend(input);
  recordAudit({
    businessId,
    actorUserId: userId,
    action: "comms.manual_send",
    entityType: "comm_message",
    entityId: outcome.messageId ?? null,
    metadata: {
      channel: input.channel,
      templateKey: input.templateKey,
      status: outcome.status,
      reason: outcome.reason ?? input.reason ?? null,
    },
  });
  return outcome;
}

/** Queues the e-receipt after a sale when the business enables it. */
export async function sendSaleReceiptAfterSale(
  businessId: number,
  saleId: number,
): Promise<void> {
  const settings = await getCommSettingsWithDefaults(businessId);
  if (!settings.autoReceiptEnabled) return;
  const [sale] = await db
    .select({
      customerId: sales.customerId,
      invoiceNumber: sales.invoiceNumber,
      finalTotal: sales.finalTotal,
      dueAmount: sales.dueAmount,
    })
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .limit(1);
  if (!sale?.customerId) return;
  const [customer] = await db
    .select({ phone: customers.phone, email: customers.email })
    .from(customers)
    .where(eq(customers.id, sale.customerId))
    .limit(1);
  if (!customer) return;
  const channel: SendInput["channel"] = customer.phone ? "sms" : "email";
  const recipient = customer.phone ?? customer.email;
  if (!recipient) return;
  await queueAndSend({
    businessId,
    channel,
    customerId: sale.customerId,
    recipient,
    templateKey: "sale_receipt",
    messageClass: "transactional",
    entityType: "sale",
    entityId: saleId,
    variables: {
      invoiceNumber: sale.invoiceNumber ?? String(saleId),
      total: Number(sale.finalTotal ?? 0),
      due: Number(sale.dueAmount ?? 0),
      paid: Number(sale.finalTotal ?? 0) - Number(sale.dueAmount ?? 0),
    },
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Sweeps: due reminders
// ---------------------------------------------------------------------------

export async function runDueReminderSweep(): Promise<{ sent: number }> {
  // Businesses with due reminders enabled.
  const enabled = await db
    .select({ businessId: commSettings.businessId })
    .from(commSettings)
    .where(eq(commSettings.dueRemindersEnabled, true));
  let sent = 0;
  for (const row of enabled) {
    // Customers with outstanding dues (sale-level due amount > 0).
    const dueSales = await db
      .select({
        id: sales.id,
        customerId: sales.customerId,
        invoiceNumber: sales.invoiceNumber,
        dueAmount: sales.dueAmount,
      })
      .from(sales)
      .where(
        and(
          eq(sales.businessId, row.businessId),
          sql`${sales.dueAmount} > 0`,
          eq(sales.status, "completed"),
        ),
      )
      .limit(200);
    for (const sale of dueSales) {
      if (sale.customerId === null) continue;
      const [customer] = await db
        .select({
          name: customers.name,
          phone: customers.phone,
          email: customers.email,
          transactionalOptOut: customers.transactionalOptOut,
        })
        .from(customers)
        .where(eq(customers.id, sale.customerId))
        .limit(1);
      if (!customer || customer.transactionalOptOut) continue;
      // One reminder per customer per day.
      const [today] = await db
        .select({ count: sql<string>`COUNT(*)` })
        .from(commMessages)
        .where(
          and(
            eq(commMessages.businessId, row.businessId),
            eq(commMessages.customerId, sale.customerId),
            eq(commMessages.templateKey, "due_reminder"),
            gte(commMessages.createdAt, new Date(new Date().setHours(0, 0, 0, 0))),
          ),
        );
      if (Number(today?.count ?? 0) > 0) continue;
      const channel: SendInput["channel"] = customer.phone ? "sms" : "email";
      const recipient = customer.phone ?? customer.email;
      if (!recipient) continue;
      const outcome = await queueAndSend({
        businessId: row.businessId,
        channel,
        customerId: sale.customerId,
        recipient,
        templateKey: "due_reminder",
        messageClass: "transactional",
        entityType: "sale",
        entityId: sale.id,
        variables: {
          customerName: customer.name,
          invoiceNumber: sale.invoiceNumber ?? String(sale.id),
          due: Number(sale.dueAmount ?? 0),
        },
      }).catch(() => ({ status: "failed" as const }));
      if (outcome.status === "sent") sent += 1;
    }
  }
  return { sent };
}

// ---------------------------------------------------------------------------
// Delivery webhooks (HMAC-verified, idempotent)
// ---------------------------------------------------------------------------

export async function ensureWebhookSecret(businessId: number): Promise<string> {
  const current = await getCommSettings(businessId);
  if (current?.webhookSecret) return current.webhookSecret;
  const secret = randomBytes(24).toString("hex");
  await db
    .insert(commSettings)
    .values({ businessId, webhookSecret: secret })
    .onConflictDoUpdate({
      target: commSettings.businessId,
      set: { webhookSecret: secret, updatedAt: new Date() },
    });
  return secret;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Idempotent status update by provider message id. */
export async function applyDeliveryWebhook(
  businessId: number,
  providerKey: string,
  providerMessageId: string,
  status: "sent" | "failed",
  error?: string | null,
): Promise<{ applied: boolean }> {
  const result = await db
    .update(commMessages)
    .set({
      status,
      ...(status === "sent" ? { sentAt: new Date() } : {}),
      ...(error ? { error: error.slice(0, 500) } : {}),
    })
    .where(
      and(
        eq(commMessages.businessId, businessId),
        eq(commMessages.providerKey, providerKey),
        eq(commMessages.providerMessageId, providerMessageId),
        // Idempotency: only transition forward from queued/failed→sent once.
        sql`${commMessages.status} <> 'sent'`,
      ),
    )
    .returning({ id: commMessages.id });
  return { applied: result.length > 0 };
}

// ---------------------------------------------------------------------------
// Message log reads
// ---------------------------------------------------------------------------

export async function listMessages(
  businessId: number,
  filters: {
    status?: string;
    channel?: string;
    customerId?: number;
    limit?: number;
    offset?: number;
  },
) {
  const conditions = [eq(commMessages.businessId, businessId)];
  if (filters.status) {
    conditions.push(sql`${commMessages.status} = ${filters.status}::comm_message_status`);
  }
  if (filters.channel) conditions.push(eq(commMessages.channel, filters.channel));
  if (filters.customerId) {
    conditions.push(eq(commMessages.customerId, filters.customerId));
  }
  const where = and(...conditions);
  const rows = await db
    .select()
    .from(commMessages)
    .where(where)
    .orderBy(desc(commMessages.id))
    .limit(Math.min(filters.limit ?? 50, 200))
    .offset(Math.max(filters.offset ?? 0, 0));
  const [counted] = await db
    .select({ total: sql<string>`COUNT(*)` })
    .from(commMessages)
    .where(where);
  return { rows, total: Number(counted?.total ?? 0) };
}
