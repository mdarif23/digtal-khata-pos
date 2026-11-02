-- Sale payment architecture (Phase 1). Per-business provider configs
-- (credentials AES-256-GCM encrypted at rest) and electronic payment
-- intents that are always verified server-side before a sale_payments row
-- is recorded. Manual cashier entries (cash/card/QR reference rows) remain
-- exactly as before — this layer adds VERIFIED electronic payments on top.
CREATE TABLE "payment_provider_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"provider" varchar(40) NOT NULL,
	"mode" varchar(10) DEFAULT 'sandbox' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"credentials_encrypted" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_provider_configs_business_provider_unique" UNIQUE("business_id","provider"),
	CONSTRAINT "payment_provider_configs_mode_valid" CHECK ("payment_provider_configs"."mode" in ('sandbox','live'))
);--> statement-breakpoint
CREATE INDEX "payment_provider_configs_business_idx" ON "payment_provider_configs" ("business_id");--> statement-breakpoint
CREATE TABLE "sale_payment_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"sale_id" integer NOT NULL,
	"provider" varchar(40) NOT NULL,
	"method" varchar(50) NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'BDT' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"provider_session_id" varchar(120),
	"provider_txn_id" varchar(120),
	"gateway_url" text,
	"idempotency_key" varchar(120) NOT NULL,
	"verify_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"raw_response" jsonb,
	"captured_sale_payment_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_payment_intents_business_idempotency_unique" UNIQUE("business_id","idempotency_key"),
	CONSTRAINT "sale_payment_intents_sale_business_fkey" FOREIGN KEY ("sale_id","business_id") REFERENCES "sales"("id","business_id") ON DELETE CASCADE,
	CONSTRAINT "sale_payment_intents_business_id_sale_payment_intents_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE,
	CONSTRAINT "sale_payment_intents_amount_positive" CHECK ("sale_payment_intents"."amount" > 0),
	CONSTRAINT "sale_payment_intents_status_valid" CHECK ("sale_payment_intents"."status" in ('pending','captured','failed','cancelled')),
	CONSTRAINT "sale_payment_intents_method_valid" CHECK ("sale_payment_intents"."method" in ('bangla_qr','card'))
);--> statement-breakpoint
CREATE INDEX "sale_payment_intents_business_idx" ON "sale_payment_intents" ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "sale_payment_intents_sale_idx" ON "sale_payment_intents" ("sale_id");
