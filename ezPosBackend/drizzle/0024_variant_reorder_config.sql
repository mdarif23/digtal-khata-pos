-- Automated replenishment (Module 2C): per-variant reorder configuration.
-- Suggestions are DERIVED (stock + outstanding purchases vs the reorder
-- point) at read time — never stored — so they are always fresh.
ALTER TABLE "product_variants" ADD COLUMN "reorder_point" integer;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "reorder_quantity" integer;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_reorder_nonnegative"
  CHECK (("reorder_point" IS NULL OR "reorder_point" >= 0)
    AND ("reorder_quantity" IS NULL OR "reorder_quantity" >= 0));
