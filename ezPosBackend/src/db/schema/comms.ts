import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.js";
import { customers } from "./customers.js";

/**
 * Customer communication foundation (Phase 2C — master prompt Feature 6).
 * Provider configs are AES-256-GCM encrypted at rest and never serialized
 * to the frontend; every outbound message persists before delivery; consent
 * (marketing opt-in / transactional opt-out) is enforced in the send path.
 */
export const commMessageStatusEnum = pgEnum("comm_message_status", [
  "queued",
  "sent",
  "failed",
]);

export const commProviders = pgTable(
  "comm_providers",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    channel: varchar("channel", { length: 10 }).notNull(),
    providerKey: varchar("provider_key", { length: 30 }).notNull(),
    displayName: varchar("display_name", { length: 80 }),
    /** AES-256-GCM ciphertext (iv:tag:ciphertext, base64). */
    configEncrypted: text("config_encrypted"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("comm_providers_business_channel_key_uq").on(
      t.businessId,
      t.channel,
      t.providerKey,
    ),
    check(
      "comm_providers_channel_check",
      sql`${t.channel} IN ('sms', 'whatsapp', 'email')`,
    ),
    check(
      "comm_providers_key_check",
      sql`${t.providerKey} IN ('console', 'generic_http', 'whatsapp_cloud', 'resend')`,
    ),
  ],
);

export const commTemplates = pgTable(
  "comm_templates",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** sale_receipt | due_reminder | payment_received | custom */
    templateKey: varchar("template_key", { length: 40 }).notNull(),
    channel: varchar("channel", { length: 10 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    body: text("body").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("comm_templates_business_key_channel_uq").on(
      t.businessId,
      t.templateKey,
      t.channel,
    ),
    check(
      "comm_templates_channel_check",
      sql`${t.channel} IN ('sms', 'whatsapp', 'email')`,
    ),
  ],
);

export const commMessages = pgTable(
  "comm_messages",
  {
    id: serial("id").primaryKey().notNull(),
    businessId: integer("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    channel: varchar("channel", { length: 10 }).notNull(),
    providerKey: varchar("provider_key", { length: 30 }).notNull().default("console"),
    recipient: varchar("recipient", { length: 255 }).notNull(),
    customerId: integer("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    templateKey: varchar("template_key", { length: 40 }).notNull().default("custom"),
    /** transactional | marketing — consent class (master prompt F6-F). */
    messageClass: varchar("message_class", { length: 12 })
      .notNull()
      .default("transactional"),
    entityType: varchar("entity_type", { length: 40 }),
    entityId: integer("entity_id"),
    body: text("body").notNull(),
    status: commMessageStatusEnum("status").notNull().default("queued"),
    providerMessageId: varchar("provider_message_id", { length: 120 }),
    error: text("error"),
    retryCount: integer("retry_count").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("comm_messages_business_created_idx").on(t.businessId, t.createdAt),
    index("comm_messages_customer_idx").on(
      t.businessId,
      t.customerId,
      t.createdAt,
    ),
    check(
      "comm_messages_class_check",
      sql`${t.messageClass} IN ('transactional', 'marketing')`,
    ),
  ],
);

/** Per-business comms policy (defaults = nothing sends automatically). */
export const commSettings = pgTable("comm_settings", {
  businessId: integer("business_id")
    .primaryKey()
    .references(() => businesses.id, { onDelete: "cascade" }),
  autoReceiptEnabled: boolean("auto_receipt_enabled").notNull().default(false),
  dueRemindersEnabled: boolean("due_reminders_enabled").notNull().default(false),
  dailyCapPerCustomer: integer("daily_cap_per_customer").notNull().default(3),
  /** HMAC secret for inbound delivery webhooks (shown once, stored hashed? no — needed to verify). */
  webhookSecret: varchar("webhook_secret", { length: 64 }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
