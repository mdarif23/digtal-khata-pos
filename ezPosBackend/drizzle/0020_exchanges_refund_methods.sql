-- Exchanges and refund methods (Module 5, Phase 1).
-- sales.exchange_of_sale_id links the replacement sale back to the original
-- (composite FK preserves tenant scoping). sale_refunds records HOW the
-- money went back to the customer and the provider's refund reference when
-- refunded to the original instrument.
ALTER TABLE "sales" ADD COLUMN "exchange_of_sale_id" integer;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_exchange_of_sale_business_fkey"
  FOREIGN KEY ("exchange_of_sale_id","business_id") REFERENCES "sales"("id","business_id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sale_refunds" ADD COLUMN "refund_method" varchar(20);--> statement-breakpoint
ALTER TABLE "sale_refunds" ADD COLUMN "provider_refund_id" varchar(120);--> statement-breakpoint
ALTER TABLE "sale_refunds" ADD CONSTRAINT "sale_refunds_method_valid"
  CHECK ("refund_method" IS NULL OR "refund_method" in ('cash','original_payment'));--> statement-breakpoint
CREATE INDEX "sales_exchange_of_sale_idx" ON "sales" ("exchange_of_sale_id");
