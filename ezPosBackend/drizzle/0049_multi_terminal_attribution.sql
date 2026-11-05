-- Multi-terminal Phase 1: terminal attribution on financial records,
-- per-business POS policy settings, and the per-business invoice counter
-- repair that converges the two numbering regimes (POS document_sequences
-- vs the legacy global sale_invoice_number_seq default used by online
-- orders) before online orders switch to document_sequences.

-- 1. Terminal attribution on sales. Nullable: storefront/WooCommerce
-- orders and all legacy rows have no terminal. The composite FK guarantees
-- the terminal belongs to the same business at the database level.
ALTER TABLE "sales" ADD COLUMN "terminal_id" integer;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "idempotency_payload_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_terminal_business_fkey" FOREIGN KEY ("terminal_id","business_id") REFERENCES "pos_terminals"("id","business_id");--> statement-breakpoint
CREATE INDEX "sales_business_terminal_idx" ON "sales" ("business_id","terminal_id");--> statement-breakpoint

-- 2. Terminal attribution on register (cash drawer) sessions.
ALTER TABLE "register_sessions" ADD COLUMN "terminal_id" integer;--> statement-breakpoint
ALTER TABLE "register_sessions" ADD CONSTRAINT "register_sessions_terminal_business_fkey" FOREIGN KEY ("terminal_id","business_id") REFERENCES "pos_terminals"("id","business_id");--> statement-breakpoint
CREATE INDEX "register_sessions_open_terminal_idx" ON "register_sessions" ("terminal_id") WHERE "status" = 'open';--> statement-breakpoint

-- 3. Drawer sessions: replace the per-user open-session unique index with a
-- user+terminal variant. NULLS NOT DISTINCT keeps today's semantics for
-- terminal-less sessions (NULL equals NULL, so a user still holds at most
-- one terminal-less open session); two open sessions bound to DIFFERENT
-- terminals may now coexist at the DB level — the service still gates that
-- behind the allow_multiple_drawer_sessions business policy, and the same
-- terminal can never hold two open sessions (one drawer = one session).
DROP INDEX "register_sessions_one_open_per_user";--> statement-breakpoint
CREATE UNIQUE INDEX "register_sessions_one_open_per_user" ON "register_sessions" ("user_id","business_id","terminal_id") NULLS NOT DISTINCT WHERE "status" = 'open';--> statement-breakpoint

-- 4. Per-business POS policy settings (singleton row, created on demand).
CREATE TABLE "pos_settings" (
	"business_id" integer PRIMARY KEY REFERENCES "businesses"("id") ON DELETE CASCADE,
	"require_terminal" boolean DEFAULT false NOT NULL,
	"allow_multiple_drawer_sessions" boolean DEFAULT false NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

-- 5. Invoice counter repair. The two numbering regimes (per-business
-- document_sequences for POS/exchanges, the global sale_invoice_number_seq
-- column default for online orders) can each hand out the same
-- INV-YYYY-NNNNNN within one business; sales_business_invoice_unique then
-- rejects the loser. Seed/bump every business's sale_invoice counter past
-- every invoice number it has actually issued so both channels can share
-- one counter from here on (online orders now allocate from
-- document_sequences too). Non-'INV-...' invoice numbers are ignored.
INSERT INTO "document_sequences" ("business_id", "sequence_key", "next_value")
SELECT s."business_id", 'sale_invoice', MAX((substring(s."invoice_number" from '^INV-[0-9]{4}-([0-9]+)$'))::bigint) + 1
FROM "sales" s
WHERE s."invoice_number" LIKE 'INV-%'
GROUP BY s."business_id"
ON CONFLICT ("business_id", "sequence_key") DO UPDATE
SET "next_value" = GREATEST("document_sequences"."next_value", EXCLUDED."next_value");
