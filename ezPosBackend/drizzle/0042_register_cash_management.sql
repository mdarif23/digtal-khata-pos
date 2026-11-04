-- 0042: Cash management foundation.
--
-- 1. register_transaction_type gains the movement kinds the drawer ledger
--    needs: cash_refund (counter payouts — previously cash refunds never
--    decreased drawer cash), safe_deposit / safe_withdrawal (drawer ↔ safe
--    transfers) and adjustment_in / adjustment_out (count corrections).
--    Direction stays "amount is positive, the type carries the sign".
--
-- 2. Idempotency for source-attributed movements: a sale, sale_refund,
--    sale_payment or expense_payment can produce at most one drawer
--    movement. Manual movements (reference_type 'manual', reference_id
--    NULL) are exempt via the partial predicate. If production data ever
--    contains duplicate source-attributed rows this migration FAILS
--    VISIBLY rather than deleting financial history — reconcile first.

ALTER TYPE "public"."register_transaction_type" ADD VALUE IF NOT EXISTS 'cash_refund';--> statement-breakpoint
ALTER TYPE "public"."register_transaction_type" ADD VALUE IF NOT EXISTS 'safe_deposit';--> statement-breakpoint
ALTER TYPE "public"."register_transaction_type" ADD VALUE IF NOT EXISTS 'safe_withdrawal';--> statement-breakpoint
ALTER TYPE "public"."register_transaction_type" ADD VALUE IF NOT EXISTS 'adjustment_in';--> statement-breakpoint
ALTER TYPE "public"."register_transaction_type" ADD VALUE IF NOT EXISTS 'adjustment_out';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "register_transactions_reference_uq"
	ON "register_transactions" USING btree ("business_id", "reference_type", "reference_id")
	WHERE "register_transactions"."reference_type" IS NOT NULL
		AND "register_transactions"."reference_id" IS NOT NULL
		AND "register_transactions"."reference_type" <> 'manual';
