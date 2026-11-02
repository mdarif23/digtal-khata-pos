-- Idempotency keys must be unique per business, not globally: two tenants
-- generating the same client-side key would otherwise collide on the global
-- constraint (and the pre-check that resolves replays is business-scoped).
ALTER TABLE "sales" DROP CONSTRAINT "sales_idempotency_key_unique";--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_idempotency_key_business_unique" UNIQUE("business_id", "idempotency_key");
