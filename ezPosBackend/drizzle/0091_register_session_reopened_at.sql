-- 0091: G2-001 — session reopen keeps prior-shift movements in expected
-- cash. computeExpectedCash sums ALL register_transactions for the session
-- id, but a reopen reuses the SAME session row: every sale/refund/movement
-- already baked into the previous close is counted again on top of the new
-- opening cash (set from the counted sheet), producing a guaranteed false
-- variance at the next close and polluting the Z-report.
--
-- reopened_at marks the CURRENT shift window. Expected-cash (and shift
-- reports) only consider transactions created after it; sessions never
-- reopened leave the column NULL and behave exactly as before.
--
-- Rollback:
--   ALTER TABLE "register_sessions" DROP COLUMN "reopened_at";

ALTER TABLE "register_sessions"
  ADD COLUMN "reopened_at" timestamp with time zone;
