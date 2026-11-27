-- 0092: E3-004 — quotation conversion was a double-sale race. The old flow
-- validated + released the quote lock, created the sale in its OWN
-- transaction, and only then conditionally claimed the quote — so two
-- concurrent converts BOTH created a real sale (stock consumed twice) and
-- the loser failed after its sale had already committed.
--
-- The fix claims the quote FIRST: status flips to 'converting' under the
-- row lock, the sale engine runs, then the claim is finalized with the
-- sale id. converted_claimed_at distinguishes an in-flight claim (fresh →
-- a concurrent convert gets a clean 409) from a crashed one (older than
-- 5 minutes with no sale id → reclaimable). createSale failures revert
-- the claim to the previous status.
--
-- Rollback:
--   ALTER TABLE "quotations" DROP COLUMN "converted_claimed_at";
--   (leaving the 'converting' enum value in place is harmless)

ALTER TYPE "quotation_status" ADD VALUE IF NOT EXISTS 'converting';--> statement-breakpoint
ALTER TABLE "quotations"
  ADD COLUMN "converted_claimed_at" timestamp with time zone;
