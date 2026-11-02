-- Payment references are tenant-scoped data: two businesses recording the
-- same gateway reference (each from their own bKash/Nagad merchant account)
-- is legitimate and must not collide globally. Duplicates within one
-- business for the same method remain rejected. Resolves the pending
-- policy decision documented in the old schema comment.
ALTER TABLE "sale_payments" DROP CONSTRAINT "sale_payments_method_reference_unique";--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_business_method_reference_unique" UNIQUE("business_id","payment_method","reference");
