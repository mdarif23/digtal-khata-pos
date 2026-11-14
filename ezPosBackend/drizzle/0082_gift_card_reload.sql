-- 0082: P3 Phase 1 — gift-card reload (F3).
--
-- gift_card_transactions previously allowed only 'issue'/'redeem' sources
-- and carried no reference column, so a reload could neither be recorded as
-- a distinct ledger event nor deduplicated. This migration adds the
-- 'reload' source value and an optional client-supplied reference with a
-- partial unique index per (business, card, reference): a retried reload
-- carrying the same reference is rejected (23505 → 409) instead of doubling
-- the card balance. Note the journal-side idempotency cannot use the card id
-- as sourceId for reloads — paid issuance already occupies
-- (business, 'gift_card_issue', cardId), and the posted-entry replay would
-- silently reuse it — so reloads key the journal on the reload transaction
-- row id instead (service-level decision, no DDL needed here).
--
-- Rollback: drop the index and column, then restore the CHECK to
-- ('issue','redeem') — the constraint swap fails if 'reload' rows exist
-- (reverting requires zero reload rows first).
ALTER TABLE gift_card_transactions DROP CONSTRAINT IF EXISTS gift_card_transactions_source_valid;
--> statement-breakpoint
ALTER TABLE gift_card_transactions ADD CONSTRAINT gift_card_transactions_source_valid
  CHECK (source_type in ('issue','redeem','reload'));
--> statement-breakpoint
ALTER TABLE gift_card_transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(100);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS gift_card_transactions_reference_uq
  ON gift_card_transactions (business_id, gift_card_id, reference)
  WHERE reference IS NOT NULL;
