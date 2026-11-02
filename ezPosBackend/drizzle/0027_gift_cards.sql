-- Gift cards (Module 7, Phase 4). Codes are stored ONLY as SHA-256 hashes
-- (the full code is shown once at issuance, never recoverable). Balances
-- are a pure transaction ledger (+ issue, − redeem): balance = SUM(amount),
-- reconciling by construction. Redemption locks the card's ledger FOR
-- UPDATE inside the sale transaction — concurrent double-redemption is
-- impossible. Expiry is a real rule: expired or deactivated cards cannot
-- redeem.
CREATE TABLE "gift_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"code_hash" varchar(64) NOT NULL UNIQUE,
	"code_last4" varchar(4) NOT NULL,
	"initial_amount" numeric(10, 2) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"customer_id" integer REFERENCES "customers"("id") ON DELETE SET NULL,
	"issued_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
	"note" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_cards_amount_positive" CHECK ("gift_cards"."initial_amount" > 0),
	CONSTRAINT "gift_cards_status_valid" CHECK ("gift_cards"."status" in ('active','inactive'))
);--> statement-breakpoint
CREATE INDEX "gift_cards_business_idx" ON "gift_cards" ("business_id");--> statement-breakpoint
CREATE TABLE "gift_card_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"gift_card_id" integer NOT NULL REFERENCES "gift_cards"("id") ON DELETE CASCADE,
	"amount" numeric(10, 2) NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"source_id" integer,
	"actor_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_card_transactions_amount_nonzero" CHECK ("gift_card_transactions"."amount" <> 0),
	CONSTRAINT "gift_card_transactions_source_valid" CHECK ("gift_card_transactions"."source_type" in ('issue','redeem'))
);--> statement-breakpoint
CREATE INDEX "gift_card_transactions_card_idx" ON "gift_card_transactions" ("gift_card_id");--> statement-breakpoint
ALTER TABLE "sale_payments" DROP CONSTRAINT "sale_payments_method_valid";--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_method_valid"
  CHECK ("sale_payments"."payment_method" in ('cash','bangla_qr','card','store_credit','loyalty_points','gift_card'));
