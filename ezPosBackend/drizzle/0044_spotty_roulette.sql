CREATE TYPE "public"."landed_cost_adjustment_type" AS ENUM('receive_delta', 'manual', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."landed_cost_allocation_method" AS ENUM('quantity', 'value', 'weight', 'manual');--> statement-breakpoint
CREATE TYPE "public"."landed_cost_expense_type" AS ENUM('shipping', 'loading', 'customs', 'transportation', 'insurance', 'handling', 'other');--> statement-breakpoint
CREATE TYPE "public"."landed_cost_payment_source" AS ENUM('expense_payment', 'supplier_payable', 'cash', 'unpaid');--> statement-breakpoint
CREATE TYPE "public"."landed_cost_posting_type" AS ENUM('capitalization', 'expense', 'cogs_adjustment', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."landed_cost_status" AS ENUM('draft', 'posted', 'adjusted', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."landed_cost_tax_treatment" AS ENUM('none', 'recoverable', 'non_recoverable');--> statement-breakpoint
CREATE TABLE "landed_cost_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"landed_cost_id" integer NOT NULL,
	"adjustment_type" "landed_cost_adjustment_type" NOT NULL,
	"previous_allocated_amount" numeric(14, 2) NOT NULL,
	"new_allocated_amount" numeric(14, 2) NOT NULL,
	"adjustment_amount" numeric(14, 2) NOT NULL,
	"inventory_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"cogs_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"reason" varchar(300),
	"reference_type" varchar(50),
	"reference_id" integer,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landed_cost_adjustments_id_business_uq" UNIQUE("id","business_id"),
	CONSTRAINT "landed_cost_adjustments_split_check" CHECK (("landed_cost_adjustments"."inventory_amount" + "landed_cost_adjustments"."cogs_amount") = "landed_cost_adjustments"."adjustment_amount")
);
--> statement-breakpoint
CREATE TABLE "landed_cost_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"landed_cost_id" integer NOT NULL,
	"expense_id" integer,
	"purchase_item_id" integer NOT NULL,
	"inventory_batch_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"allocation_method" "landed_cost_allocation_method" NOT NULL,
	"basis_value" numeric(14, 4) NOT NULL,
	"allocated_amount" numeric(14, 4) NOT NULL,
	"allocated_per_unit" numeric(14, 6) NOT NULL,
	"quantity_snapshot" numeric(12, 3) NOT NULL,
	"weight_snapshot" numeric(14, 4),
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landed_cost_allocations_id_business_uq" UNIQUE("id","business_id")
);
--> statement-breakpoint
CREATE TABLE "landed_cost_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"landed_cost_id" integer NOT NULL,
	"action" varchar(50) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb,
	"actor_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landed_cost_audit_logs_id_business_uq" UNIQUE("id","business_id")
);
--> statement-breakpoint
CREATE TABLE "landed_cost_expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"landed_cost_id" integer NOT NULL,
	"expense_type" "landed_cost_expense_type" NOT NULL,
	"description" varchar(255),
	"amount" numeric(14, 2) NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"tax_treatment" "landed_cost_tax_treatment" DEFAULT 'none' NOT NULL,
	"is_capitalizable" boolean DEFAULT true NOT NULL,
	"vendor_id" integer,
	"reference_number" varchar(100),
	"expense_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landed_cost_expenses_id_business_uq" UNIQUE("id","business_id"),
	CONSTRAINT "landed_cost_expenses_amount_check" CHECK ("landed_cost_expenses"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "landed_cost_postings" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"landed_cost_id" integer NOT NULL,
	"adjustment_id" integer,
	"posting_type" "landed_cost_posting_type" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"payment_source" "landed_cost_payment_source" NOT NULL,
	"payment_reference_type" varchar(50),
	"payment_reference_id" integer,
	"description" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landed_cost_postings_id_business_uq" UNIQUE("id","business_id")
);
--> statement-breakpoint
CREATE TABLE "landed_costs" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"purchase_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"allocation_method" "landed_cost_allocation_method" NOT NULL,
	"status" "landed_cost_status" DEFAULT 'draft' NOT NULL,
	"currency" varchar(3) DEFAULT 'BDT' NOT NULL,
	"total_expense_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"total_capitalizable_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"total_allocated_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"pending_allocation_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"created_by" integer NOT NULL,
	"posted_by" integer,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landed_costs_purchase_business_unique" UNIQUE("business_id","purchase_id"),
	CONSTRAINT "landed_costs_id_business_uq" UNIQUE("id","business_id")
);
--> statement-breakpoint
CREATE TABLE "sale_item_batch_consumptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"sale_id" integer NOT NULL,
	"sale_item_id" integer NOT NULL,
	"batch_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost_at_consumption" numeric(14, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_item_batch_consumptions_id_business_uq" UNIQUE("id","business_id"),
	CONSTRAINT "sale_item_batch_consumptions_qty_check" CHECK ("sale_item_batch_consumptions"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD COLUMN "additional_cost_per_unit" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD COLUMN "landed_cost_per_unit" numeric(14, 6) GENERATED ALWAYS AS (( (purchase_price + coalesce(additional_cost_per_unit, 0)) )) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "weight" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "weight_unit" varchar(5);--> statement-breakpoint
ALTER TABLE "landed_cost_adjustments" ADD CONSTRAINT "landed_cost_adjustments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_adjustments" ADD CONSTRAINT "landed_cost_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_adjustments" ADD CONSTRAINT "landed_cost_adjustments_document_business_fkey" FOREIGN KEY ("landed_cost_id","business_id") REFERENCES "public"."landed_costs"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_allocations" ADD CONSTRAINT "landed_cost_allocations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_allocations" ADD CONSTRAINT "landed_cost_allocations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_allocations" ADD CONSTRAINT "landed_cost_allocations_document_business_fkey" FOREIGN KEY ("landed_cost_id","business_id") REFERENCES "public"."landed_costs"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_allocations" ADD CONSTRAINT "landed_cost_allocations_expense_business_fkey" FOREIGN KEY ("expense_id","business_id") REFERENCES "public"."landed_cost_expenses"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_allocations" ADD CONSTRAINT "landed_cost_allocations_purchase_item_business_fkey" FOREIGN KEY ("purchase_item_id","business_id") REFERENCES "public"."purchase_items"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_allocations" ADD CONSTRAINT "landed_cost_allocations_batch_business_fkey" FOREIGN KEY ("inventory_batch_id","business_id") REFERENCES "public"."inventory_batches"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_allocations" ADD CONSTRAINT "landed_cost_allocations_variant_business_fkey" FOREIGN KEY ("variant_id","business_id") REFERENCES "public"."product_variants"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_audit_logs" ADD CONSTRAINT "landed_cost_audit_logs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_audit_logs" ADD CONSTRAINT "landed_cost_audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_audit_logs" ADD CONSTRAINT "landed_cost_audit_logs_document_business_fkey" FOREIGN KEY ("landed_cost_id","business_id") REFERENCES "public"."landed_costs"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_expenses" ADD CONSTRAINT "landed_cost_expenses_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_expenses" ADD CONSTRAINT "landed_cost_expenses_document_business_fkey" FOREIGN KEY ("landed_cost_id","business_id") REFERENCES "public"."landed_costs"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_expenses" ADD CONSTRAINT "landed_cost_expenses_vendor_business_fkey" FOREIGN KEY ("vendor_id","business_id") REFERENCES "public"."suppliers"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_postings" ADD CONSTRAINT "landed_cost_postings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_postings" ADD CONSTRAINT "landed_cost_postings_document_business_fkey" FOREIGN KEY ("landed_cost_id","business_id") REFERENCES "public"."landed_costs"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_postings" ADD CONSTRAINT "landed_cost_postings_adjustment_business_fkey" FOREIGN KEY ("adjustment_id","business_id") REFERENCES "public"."landed_cost_adjustments"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_purchase_business_fkey" FOREIGN KEY ("purchase_id","business_id") REFERENCES "public"."purchases"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_location_business_fkey" FOREIGN KEY ("location_id","business_id") REFERENCES "public"."locations"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_item_batch_consumptions" ADD CONSTRAINT "sale_item_batch_consumptions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_item_batch_consumptions" ADD CONSTRAINT "sale_item_batch_consumptions_sale_business_fkey" FOREIGN KEY ("sale_id","business_id") REFERENCES "public"."sales"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_item_batch_consumptions" ADD CONSTRAINT "sale_item_batch_consumptions_sale_item_business_fkey" FOREIGN KEY ("sale_item_id","business_id") REFERENCES "public"."sale_items"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_item_batch_consumptions" ADD CONSTRAINT "sale_item_batch_consumptions_batch_business_fkey" FOREIGN KEY ("batch_id","business_id") REFERENCES "public"."inventory_batches"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_item_batch_consumptions" ADD CONSTRAINT "sale_item_batch_consumptions_variant_business_fkey" FOREIGN KEY ("variant_id","business_id") REFERENCES "public"."product_variants"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "landed_cost_adjustments_document_idx" ON "landed_cost_adjustments" USING btree ("landed_cost_id");--> statement-breakpoint
CREATE INDEX "landed_cost_allocations_document_idx" ON "landed_cost_allocations" USING btree ("landed_cost_id");--> statement-breakpoint
CREATE INDEX "landed_cost_allocations_batch_idx" ON "landed_cost_allocations" USING btree ("inventory_batch_id");--> statement-breakpoint
CREATE INDEX "landed_cost_audit_logs_document_idx" ON "landed_cost_audit_logs" USING btree ("landed_cost_id","created_at");--> statement-breakpoint
CREATE INDEX "landed_cost_expenses_document_idx" ON "landed_cost_expenses" USING btree ("landed_cost_id");--> statement-breakpoint
CREATE INDEX "landed_cost_postings_document_idx" ON "landed_cost_postings" USING btree ("landed_cost_id");--> statement-breakpoint
CREATE INDEX "landed_costs_business_status_idx" ON "landed_costs" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "sale_item_batch_consumptions_item_idx" ON "sale_item_batch_consumptions" USING btree ("sale_item_id");--> statement-breakpoint
CREATE INDEX "sale_item_batch_consumptions_batch_idx" ON "sale_item_batch_consumptions" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "inventory_batches_variant_location_idx" ON "inventory_batches" USING btree ("variant_id","location_id");--> statement-breakpoint
CREATE INDEX "inventory_batches_purchase_item_idx" ON "inventory_batches" USING btree ("purchase_item_id");--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_weight_unit_check" CHECK ("product_variants"."weight_unit" IS NULL OR "product_variants"."weight_unit" IN ('kg', 'g', 'lb', 'oz'));