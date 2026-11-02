CREATE TABLE "online_order_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"storefront_id" integer,
	"sale_id" integer NOT NULL,
	"idempotency_key" varchar(120) NOT NULL,
	"provider" varchar(30) NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'BDT' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"session_id" varchar(255),
	"val_id" varchar(255),
	"gateway_reference" varchar(255),
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "online_order_payments_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "online_order_payments_amount_positive" CHECK ("online_order_payments"."amount" > 0),
	CONSTRAINT "online_order_payments_status_valid" CHECK ("online_order_payments"."status" in ('pending','succeeded','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "shopper_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"shopper_id" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "shopper_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "shoppers" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"storefront_id" integer NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(128) NOT NULL,
	"full_name" varchar(120),
	"phone" varchar(20),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "shoppers_storefront_email_unique" UNIQUE("storefront_id","email"),
	CONSTRAINT "shoppers_status_valid" CHECK ("shoppers"."status" in ('active','suspended'))
);
--> statement-breakpoint
ALTER TABLE "sale_payments" DROP CONSTRAINT "sale_payments_method_reference_unique";--> statement-breakpoint
ALTER TABLE "sale_payments" DROP CONSTRAINT "sale_payments_method_valid";--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "delivery_fee" numeric(10, 2) DEFAULT 0;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "shopper_id" integer;--> statement-breakpoint
ALTER TABLE "storefronts" ADD COLUMN "shopper_accounts_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "online_order_payments" ADD CONSTRAINT "online_order_payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_order_payments" ADD CONSTRAINT "online_order_payments_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_order_payments" ADD CONSTRAINT "online_order_payments_sale_business_fkey" FOREIGN KEY ("sale_id","business_id") REFERENCES "public"."sales"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopper_sessions" ADD CONSTRAINT "shopper_sessions_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shoppers" ADD CONSTRAINT "shoppers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shoppers" ADD CONSTRAINT "shoppers_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "online_order_payments_business_idx" ON "online_order_payments" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "online_order_payments_sale_idx" ON "online_order_payments" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "shopper_sessions_shopper_idx" ON "shopper_sessions" USING btree ("shopper_id");--> statement-breakpoint
CREATE INDEX "shoppers_business_idx" ON "shoppers" USING btree ("business_id");--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_method_reference_unique" UNIQUE("business_id","payment_method","reference");--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_method_valid" CHECK ("sale_payments"."payment_method" in ('cash','bangla_qr','card','sslcommerz'));