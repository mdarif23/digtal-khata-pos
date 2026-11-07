-- 0052: Purchase quantity discrepancy management (owner-approved schema).
-- 1) purchase_items gains the delivered/rejected split; the baseline
--    "cancelled_quantity   " column (identifier contains trailing spaces,
--    unused by any code) is renamed to a clean identifier.
-- 2) Per-delivery audit records (one row per purchase item per receiving
--    submission: delivered/accepted/rejected split, approver, reasons).
-- 3) Discrepancy/resolution records (over-receival, shortage, rejection,
--    cancellation) with reason, category, resolution and actors.
-- 4) Per-business over-receiving tolerance setting.

ALTER TABLE "purchase_items" RENAME COLUMN "cancelled_quantity   " TO "cancelled_quantity";

ALTER TABLE "purchase_items" ADD COLUMN "delivered_quantity" numeric(12, 3) DEFAULT 0 NOT NULL;
ALTER TABLE "purchase_items" ADD COLUMN "rejected_quantity" numeric(12, 3) DEFAULT 0 NOT NULL;

CREATE TABLE "purchase_receiving_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"purchase_id" integer NOT NULL,
	"purchase_item_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"delivered_quantity" numeric(12, 3) NOT NULL,
	"accepted_quantity" numeric(12, 3) NOT NULL,
	"rejected_quantity" numeric(12, 3) DEFAULT 0 NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"rejection_category" varchar(30),
	"rejection_reason" text,
	"over_received" boolean DEFAULT false NOT NULL,
	"approval_reason" text,
	"received_by_user_id" integer NOT NULL,
	"approved_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_receiving_records_quantities_check" CHECK (
		"accepted_quantity" >= 0 AND "rejected_quantity" >= 0
		AND "delivered_quantity" = "accepted_quantity" + "rejected_quantity"
	),
	CONSTRAINT "purchase_receiving_records_rejection_reason_check" CHECK (
		"rejected_quantity" = 0 OR ("rejection_category" IS NOT NULL AND "rejection_reason" IS NOT NULL)
	)
);
ALTER TABLE "purchase_receiving_records" ADD CONSTRAINT "purchase_receiving_records_purchase_business_fkey" FOREIGN KEY ("purchase_id","business_id") REFERENCES "purchases"("id","business_id") ON DELETE CASCADE;
ALTER TABLE "purchase_receiving_records" ADD CONSTRAINT "purchase_receiving_records_item_business_fkey" FOREIGN KEY ("purchase_item_id","business_id") REFERENCES "purchase_items"("id","business_id") ON DELETE CASCADE;
ALTER TABLE "purchase_receiving_records" ADD CONSTRAINT "purchase_receiving_records_variant_business_fkey" FOREIGN KEY ("variant_id","business_id") REFERENCES "product_variants"("id","business_id") ON DELETE CASCADE;
ALTER TABLE "purchase_receiving_records" ADD CONSTRAINT "purchase_receiving_records_location_business_fkey" FOREIGN KEY ("location_id","business_id") REFERENCES "locations"("id","business_id") ON DELETE CASCADE;
ALTER TABLE "purchase_receiving_records" ADD CONSTRAINT "purchase_receiving_records_received_by_fkey" FOREIGN KEY ("received_by_user_id") REFERENCES "users"("id");
ALTER TABLE "purchase_receiving_records" ADD CONSTRAINT "purchase_receiving_records_approved_by_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id");
CREATE INDEX "purchase_receiving_records_purchase_idx" ON "purchase_receiving_records" USING btree ("business_id","purchase_id");
CREATE INDEX "purchase_receiving_records_item_idx" ON "purchase_receiving_records" USING btree ("business_id","purchase_item_id");

CREATE TABLE "purchase_discrepancies" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"purchase_id" integer NOT NULL,
	"purchase_item_id" integer NOT NULL,
	"receiving_record_id" integer,
	"type" varchar(20) NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"reason" text,
	"category" varchar(30),
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"resolution" varchar(20),
	"requested_by_user_id" integer NOT NULL,
	"resolved_by_user_id" integer,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_discrepancies_type_check" CHECK (
		"type" IN ('over_receival','shortage','rejection','cancellation')
	),
	CONSTRAINT "purchase_discrepancies_status_check" CHECK (
		"status" IN ('open','resolved','cancelled')
	),
	CONSTRAINT "purchase_discrepancies_resolution_check" CHECK (
		"resolution" IS NULL OR "resolution" IN
		('receive_later','cancel','backordered','supplier_credit','replacement')
	)
);
ALTER TABLE "purchase_discrepancies" ADD CONSTRAINT "purchase_discrepancies_purchase_business_fkey" FOREIGN KEY ("purchase_id","business_id") REFERENCES "purchases"("id","business_id") ON DELETE CASCADE;
ALTER TABLE "purchase_discrepancies" ADD CONSTRAINT "purchase_discrepancies_item_business_fkey" FOREIGN KEY ("purchase_item_id","business_id") REFERENCES "purchase_items"("id","business_id") ON DELETE CASCADE;
ALTER TABLE "purchase_discrepancies" ADD CONSTRAINT "purchase_discrepancies_receiving_record_fkey" FOREIGN KEY ("receiving_record_id") REFERENCES "purchase_receiving_records"("id") ON DELETE SET NULL;
ALTER TABLE "purchase_discrepancies" ADD CONSTRAINT "purchase_discrepancies_requested_by_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id");
ALTER TABLE "purchase_discrepancies" ADD CONSTRAINT "purchase_discrepancies_resolved_by_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id");
CREATE INDEX "purchase_discrepancies_purchase_idx" ON "purchase_discrepancies" USING btree ("business_id","purchase_id");

CREATE TABLE "purchase_receiving_settings" (
	"business_id" integer PRIMARY KEY NOT NULL,
	"over_receive_tolerance_percent" numeric(5, 2) DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_receiving_settings_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE,
	CONSTRAINT "purchase_receiving_settings_tolerance_check" CHECK ("over_receive_tolerance_percent" >= 0)
);
