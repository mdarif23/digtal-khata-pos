-- 0044: Barcode aliases + primary barcode format (approved 2026-11-05).
--
-- variant_barcode_aliases: extra scannable codes per variant. The PRIMARY
-- barcode remains product_variants.barcode (single source of truth; all
-- existing scans/queries keep reading it). Aliases carry old codes kept
-- after regeneration, manufacturer alternates and internal print codes.
-- Per-business uniqueness mirrors the primary-barcode index; the service
-- additionally enforces cross-table uniqueness so a scanned code always
-- resolves to exactly one variant.
--
-- product_variants.barcode_format: symbology of the primary barcode
-- (ean13 | ean8 | upca | code128 | code39 | qr). NULL for legacy rows —
-- rendering auto-detects. Nothing else changes; additive only.

CREATE TABLE "variant_barcode_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"barcode" varchar(100) NOT NULL,
	"barcode_format" varchar(20),
	"source" varchar(20) DEFAULT 'external' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "variant_barcode_aliases_business_barcode_uq" UNIQUE("business_id","barcode"),
	CONSTRAINT "variant_barcode_aliases_id_business_uq" UNIQUE("id","business_id")
);--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "barcode_format" varchar(20);--> statement-breakpoint
ALTER TABLE "variant_barcode_aliases" ADD CONSTRAINT "variant_barcode_aliases_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_barcode_aliases" ADD CONSTRAINT "variant_barcode_aliases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_barcode_aliases" ADD CONSTRAINT "variant_barcode_aliases_variant_business_fkey" FOREIGN KEY ("variant_id","business_id") REFERENCES "public"."product_variants"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "variant_barcode_aliases_variant_idx" ON "variant_barcode_aliases" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "variant_barcode_aliases_business_idx" ON "variant_barcode_aliases" USING btree ("business_id");
