-- Migration 0037: Online order fulfillment (online order management module)
-- Hand-authored from the approved schema proposal
-- (docs/ONLINE-ORDERS-IMPLEMENTATION-PLAN.md §2). The auto-generated diff was
-- discarded because the meta snapshot chain is stale (snapshots 0015–0031 and
-- 0033–0036 are missing); this file contains exactly the approved changes.
-- Statement text matches drizzle-kit's canonical output so future generates
-- diff cleanly against meta/0037_snapshot.json (full post-0037 schema).

-- 2.1 Fulfillment workflow states (additive; existing rows unchanged)
ALTER TYPE "public"."fulfillment_status" ADD VALUE 'confirmed' BEFORE 'processing';--> statement-breakpoint
ALTER TYPE "public"."fulfillment_status" ADD VALUE 'packed' BEFORE 'shipped';--> statement-breakpoint
ALTER TYPE "public"."fulfillment_status" ADD VALUE 'ready_to_ship' BEFORE 'shipped';--> statement-breakpoint
ALTER TYPE "public"."fulfillment_status" ADD VALUE 'return_requested';--> statement-breakpoint
ALTER TYPE "public"."fulfillment_status" ADD VALUE 'partially_returned';--> statement-breakpoint
ALTER TYPE "public"."fulfillment_status" ADD VALUE 'returned';--> statement-breakpoint
-- 2.4 Courier shipments (one active shipment per order)
CREATE TABLE "sale_shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"sale_id" integer NOT NULL,
	"courier_name" varchar(120),
	"courier_service" varchar(120),
	"tracking_number" varchar(120),
	"shipment_date" timestamp with time zone,
	"expected_delivery_date" timestamp with time zone,
	"shipping_cost" numeric(10, 2) DEFAULT 0,
	"status" varchar(20) DEFAULT 'preparing' NOT NULL,
	"notes" text,
	"reference_url" varchar(300),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "sale_shipments_sale_unique" UNIQUE("sale_id","business_id")
);--> statement-breakpoint
ALTER TABLE "sale_shipments" ADD CONSTRAINT "sale_shipments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_shipments" ADD CONSTRAINT "sale_shipments_sale_business_fkey" FOREIGN KEY ("sale_id","business_id") REFERENCES "public"."sales"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_shipments_business_date_idx" ON "sale_shipments" USING btree ("business_id","shipment_date");--> statement-breakpoint
-- 2.5 Packages (product shipping defaults are copied at pack time)
CREATE TABLE "sale_packages" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"sale_id" integer NOT NULL,
	"package_no" integer DEFAULT 1 NOT NULL,
	"package_type" varchar(50),
	"weight_kg" numeric(10, 3),
	"length_cm" numeric(10, 2),
	"width_cm" numeric(10, 2),
	"height_cm" numeric(10, 2),
	"materials_note" text,
	"packing_cost" numeric(10, 2) DEFAULT 0,
	"packed_by_user_id" integer,
	"packed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "sale_packages_sale_no_unique" UNIQUE("sale_id","package_no")
);--> statement-breakpoint
ALTER TABLE "sale_packages" ADD CONSTRAINT "sale_packages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_packages" ADD CONSTRAINT "sale_packages_packed_by_user_id_users_id_fk" FOREIGN KEY ("packed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_packages" ADD CONSTRAINT "sale_packages_sale_business_fkey" FOREIGN KEY ("sale_id","business_id") REFERENCES "public"."sales"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_packages_business_id_idx" ON "sale_packages" USING btree ("business_id");--> statement-breakpoint
-- 2.6 Append-only order timeline
CREATE TABLE "sale_order_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"sale_id" integer NOT NULL,
	"event_type" varchar(40) NOT NULL,
	"previous_status" varchar(30),
	"new_status" varchar(30),
	"actor_type" varchar(20) DEFAULT 'user' NOT NULL,
	"actor_user_id" integer,
	"actor_label" varchar(120),
	"note" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "sale_order_events" ADD CONSTRAINT "sale_order_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_events" ADD CONSTRAINT "sale_order_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_events" ADD CONSTRAINT "sale_order_events_sale_business_fkey" FOREIGN KEY ("sale_id","business_id") REFERENCES "public"."sales"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_order_events_sale_created_idx" ON "sale_order_events" USING btree ("sale_id","created_at");--> statement-breakpoint
CREATE INDEX "sale_order_events_business_id_idx" ON "sale_order_events" USING btree ("business_id");--> statement-breakpoint
-- 2.2/2.3 Order-time shipping snapshot + channel commission
ALTER TABLE "sales" ADD COLUMN "shipping_name" varchar(150);--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "shipping_phone" varchar(30);--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "shipping_address" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "shipping_city" varchar(100);--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "shipping_area" varchar(100);--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "delivery_instructions" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "marketplace_commission" numeric(10, 2) DEFAULT 0;--> statement-breakpoint
CREATE INDEX "sales_business_channel_date_idx" ON "sales" USING btree ("business_id","channel","purchase_date");--> statement-breakpoint
-- 2.7 Gateway fee capture + method CHECK aligned with live DB (0035)
ALTER TABLE "sale_payments" ADD COLUMN "gateway_fee" numeric(12, 2) DEFAULT 0;--> statement-breakpoint
ALTER TABLE "sale_payments" DROP CONSTRAINT "sale_payments_method_valid";--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_method_valid" CHECK ("sale_payments"."payment_method" in ('cash','bangla_qr','card','store_credit','loyalty_points','gift_card','sslcommerz'));--> statement-breakpoint
-- 2.8 Expense channel attribution + order link
ALTER TABLE "expenses" ADD COLUMN "channel" "sale_channel";--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "sale_id" integer;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_sale_business_fkey" FOREIGN KEY ("sale_id","business_id") REFERENCES "public"."sales"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 2.9 Product shipping & packaging defaults (copied into packages at pack time)
ALTER TABLE "products" ADD COLUMN "shipping_weight_kg" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "shipping_length_cm" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "shipping_width_cm" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "shipping_height_cm" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "packaging_instructions" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "handling_instructions" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_fragile" boolean DEFAULT false NOT NULL;
