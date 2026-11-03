CREATE TYPE "public"."document_type" AS ENUM('sales_receipt', 'sales_invoice');--> statement-breakpoint
CREATE TABLE "document_settings" (
	"business_id" integer NOT NULL,
	"doc_type" "document_type" NOT NULL,
	"config" jsonb NOT NULL,
	"template_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_settings_business_id_doc_type_pk" PRIMARY KEY("business_id","doc_type")
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "website" varchar(255);--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "vat_bin" varchar(60);--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "tagline" varchar(160);--> statement-breakpoint
ALTER TABLE "document_settings" ADD CONSTRAINT "document_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;