-- Tax engine (Module 4, Phase 1). Configurable rates with exclusive /
-- inclusive pricing modes, optional location scoping and effective dates;
-- product-level assignment; per-line historical snapshots on sale_items so
-- editing or deactivating a rate can never rewrite past invoices.
CREATE TABLE "tax_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
	"name" varchar(80) NOT NULL,
	"rate" numeric(6, 3) NOT NULL,
	"is_inclusive" boolean DEFAULT false NOT NULL,
	"location_id" integer REFERENCES "locations"("id") ON DELETE SET NULL,
	"valid_from" date,
	"valid_to" date,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_rate_range" CHECK ("tax_rates"."rate" >= 0 AND "tax_rates"."rate" <= 100)
);--> statement-breakpoint
CREATE INDEX "tax_rates_business_idx" ON "tax_rates" ("business_id");--> statement-breakpoint
CREATE TABLE "product_taxes" (
	"product_id" integer NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
	"tax_rate_id" integer NOT NULL REFERENCES "tax_rates"("id") ON DELETE CASCADE,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_taxes_product_id_tax_rate_id_pk" PRIMARY KEY("product_id","tax_rate_id")
);--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "tax_amount" numeric(12, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "tax_detail" jsonb DEFAULT '[]'::jsonb NOT NULL;
