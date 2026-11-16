-- 0086: P3 Phase 3 — sale void with batch-aware restoration (E1-003).
--
-- sales gains void bookkeeping columns: the mandatory human reason, the
-- acting user, and the moment — the original invoice number is PRESERVED
-- (its per-business unique index keeps the number reserved forever; a
-- voided sale's row is never deleted). Status uses the existing
-- 'cancelled' enum value (only the reservation sweep wrote it before).
--
-- Instrument ledgers: a voided sale's gift-card redemptions and store-credit
-- spends are reversed with explicit POSITIVE 'void_restore' rows (never
-- deletion) — both CHECK constraints gain the value. The reversal preserves
-- the append-only ledger invariant; the finance journal side uses the
-- existing reverseEntry (no DDL needed).
--
-- Rollback: UPDATE sales SET cancel_reason = NULL, cancelled_by_user_id =
-- NULL, cancelled_at = NULL WHERE status = 'cancelled'; drop the columns;
-- restore both CHECKs to their Phase-1 value lists — those swaps fail if
-- 'void_restore' rows exist (reverting requires reversing them first).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(500);
--> statement-breakpoint
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancelled_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
--> statement-breakpoint
ALTER TABLE gift_card_transactions DROP CONSTRAINT IF EXISTS gift_card_transactions_source_valid;
--> statement-breakpoint
ALTER TABLE gift_card_transactions ADD CONSTRAINT gift_card_transactions_source_valid
  CHECK (source_type in ('issue','redeem','reload','void_restore'));
--> statement-breakpoint
ALTER TABLE customer_credits DROP CONSTRAINT IF EXISTS customer_credits_source_valid;
--> statement-breakpoint
ALTER TABLE customer_credits ADD CONSTRAINT customer_credits_source_valid
  CHECK (source_type in ('refund','sale_payment','manual','expiry','void_restore'));
