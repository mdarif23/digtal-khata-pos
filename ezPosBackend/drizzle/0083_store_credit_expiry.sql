-- 0083: P3 Phase 1 — store-credit expiry (F4).
--
-- customer_credits rows gain a nullable expiry timestamp (NULL = never
-- expires — every existing row keeps today's behavior) and a new 'expiry'
-- source type. The sweep converts expired-but-unconsumed grant value into
-- ONE explicit negative ledger row per customer (deterministic replay:
-- consumption and prior expiry rows allocate FIFO against grants ordered by
-- expiry then creation), so the balance stays a pure SUM(amount) over the
-- ledger, expiry is an auditable transaction rather than a silent read-side
-- filter, and repeated sweeps cannot double-expire — the replay counts
-- previous 'expiry' rows as consumption.
--
-- Rollback: UPDATE customer_credits SET expires_at = NULL WHERE
-- expires_at IS NOT NULL (keeps granted value alive); drop the index and
-- column; restore the CHECK to ('refund','sale_payment','manual') — that
-- swap fails if 'expiry' rows exist (reverting requires zero expiry rows
-- first, i.e. manually reversing them).
ALTER TABLE customer_credits ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_credits_expiry_idx
  ON customer_credits (business_id, customer_id, expires_at);
--> statement-breakpoint
ALTER TABLE customer_credits DROP CONSTRAINT IF EXISTS customer_credits_source_valid;
--> statement-breakpoint
ALTER TABLE customer_credits ADD CONSTRAINT customer_credits_source_valid
  CHECK (source_type in ('refund','sale_payment','manual','expiry'));
