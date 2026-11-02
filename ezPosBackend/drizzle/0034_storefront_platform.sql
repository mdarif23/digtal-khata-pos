CREATE TYPE "public"."storefront_analytics_event_type" AS ENUM('visit', 'product_view', 'add_to_cart', 'checkout_start');--> statement-breakpoint
CREATE TYPE "public"."storefront_domain_kind" AS ENUM('subdomain', 'custom');--> statement-breakpoint
CREATE TYPE "public"."storefront_domain_status" AS ENUM('pending', 'verified', 'failed', 'removed');--> statement-breakpoint
CREATE TYPE "public"."storefront_payment_method" AS ENUM('cod', 'sslcommerz');--> statement-breakpoint
CREATE TYPE "public"."storefront_ssl_status" AS ENUM('pending', 'issued', 'failed');--> statement-breakpoint
CREATE TYPE "public"."storefront_status" AS ENUM('draft', 'preview', 'published', 'suspended', 'archived');--> statement-breakpoint
CREATE TABLE "storefront_analytics_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"storefront_id" integer NOT NULL,
	"event_type" "storefront_analytics_event_type" NOT NULL,
	"path" varchar(300),
	"product_id" integer,
	"visitor_ref" varchar(64),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storefront_delivery_zones" (
	"id" serial PRIMARY KEY NOT NULL,
	"storefront_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"areas" text[] NOT NULL,
	"rate" numeric(10, 2) NOT NULL,
	"estimated_days_min" integer,
	"estimated_days_max" integer,
	"free_threshold" numeric(10, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "storefront_domains" (
	"id" serial PRIMARY KEY NOT NULL,
	"storefront_id" integer NOT NULL,
	"kind" "storefront_domain_kind" NOT NULL,
	"domain" varchar(253) NOT NULL,
	"verification_token" varchar(64),
	"status" "storefront_domain_status" DEFAULT 'pending' NOT NULL,
	"ssl_status" "storefront_ssl_status" DEFAULT 'pending' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "storefront_domains_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "storefront_media" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"object_key" varchar(300) NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "storefront_media_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "storefront_pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"storefront_id" integer NOT NULL,
	"slug" varchar(100) NOT NULL,
	"title" varchar(200) NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seo_title" varchar(200),
	"seo_description" varchar(300),
	"is_published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "storefront_payment_methods" (
	"id" serial PRIMARY KEY NOT NULL,
	"storefront_id" integer NOT NULL,
	"method" "storefront_payment_method" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"label" varchar(100)
);
--> statement-breakpoint
CREATE TABLE "storefront_product_visibility" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"storefront_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"seo_title" varchar(200),
	"seo_description" varchar(300),
	"website_image_urls" text[],
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "storefront_publish_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"storefront_id" integer NOT NULL,
	"version_number" integer NOT NULL,
	"theme_id" varchar(50) NOT NULL,
	"config" jsonb NOT NULL,
	"seo" jsonb,
	"contact" jsonb,
	"published_by_user_id" integer,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storefronts" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"subdomain" varchar(63) NOT NULL,
	"status" "storefront_status" DEFAULT 'draft' NOT NULL,
	"theme_id" varchar(50) NOT NULL,
	"draft_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_version_id" integer,
	"seo" jsonb,
	"contact" jsonb,
	"store_pickup_enabled" boolean DEFAULT false NOT NULL,
	"analytics_enabled" boolean DEFAULT false NOT NULL,
	"search_indexing_enabled" boolean DEFAULT true NOT NULL,
	"published_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "storefronts_subdomain_unique" UNIQUE("subdomain")
);
--> statement-breakpoint
ALTER TABLE "storefront_analytics_events" ADD CONSTRAINT "storefront_analytics_events_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_delivery_zones" ADD CONSTRAINT "storefront_delivery_zones_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_domains" ADD CONSTRAINT "storefront_domains_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_media" ADD CONSTRAINT "storefront_media_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_pages" ADD CONSTRAINT "storefront_pages_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payment_methods" ADD CONSTRAINT "storefront_payment_methods_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_product_visibility" ADD CONSTRAINT "storefront_product_visibility_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_product_visibility" ADD CONSTRAINT "storefront_product_visibility_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_product_visibility" ADD CONSTRAINT "storefront_product_visibility_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_publish_versions" ADD CONSTRAINT "storefront_publish_versions_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefronts" ADD CONSTRAINT "storefronts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storefront_analytics_events_storefront_idx" ON "storefront_analytics_events" USING btree ("storefront_id","occurred_at");--> statement-breakpoint
CREATE INDEX "storefront_delivery_zones_storefront_idx" ON "storefront_delivery_zones" USING btree ("storefront_id");--> statement-breakpoint
CREATE INDEX "storefront_domains_storefront_idx" ON "storefront_domains" USING btree ("storefront_id");--> statement-breakpoint
CREATE INDEX "storefront_domains_status_idx" ON "storefront_domains" USING btree ("status");--> statement-breakpoint
CREATE INDEX "storefront_media_business_idx" ON "storefront_media" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_pages_slug_unique" ON "storefront_pages" USING btree ("storefront_id","slug");--> statement-breakpoint
CREATE INDEX "storefront_pages_storefront_idx" ON "storefront_pages" USING btree ("storefront_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_payment_methods_unique" ON "storefront_payment_methods" USING btree ("storefront_id","method");--> statement-breakpoint
CREATE INDEX "storefront_payment_methods_storefront_idx" ON "storefront_payment_methods" USING btree ("storefront_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_product_visibility_unique" ON "storefront_product_visibility" USING btree ("storefront_id","product_id");--> statement-breakpoint
CREATE INDEX "storefront_product_visibility_storefront_idx" ON "storefront_product_visibility" USING btree ("storefront_id","published");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_publish_versions_unique" ON "storefront_publish_versions" USING btree ("storefront_id","version_number");--> statement-breakpoint
CREATE INDEX "storefront_publish_versions_storefront_idx" ON "storefront_publish_versions" USING btree ("storefront_id");--> statement-breakpoint
CREATE INDEX "storefronts_business_idx" ON "storefronts" USING btree ("business_id");