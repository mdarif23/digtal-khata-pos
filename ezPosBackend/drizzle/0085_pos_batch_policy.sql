-- 0085: P3 Phase 2 — expired-batch POS policy + expiry warning window.
--
-- expired_batch_policy: 'block' (default — expired batches can never be
-- sold, silently or otherwise; every pre-existing business keeps today's
-- stock-accurate behavior except that expired stock is no longer consumed)
-- or 'allow_with_approval' (expired batches may be sold ONLY via explicit
-- manual selection carrying a one-time manager approval token — FEFO never
-- auto-selects expired stock under either policy).
--
-- expiry_warning_days: per-business near-expiry notification window for the
-- existing sweepExpiringInventory job (default 7 — today's fixed window).
--
-- Rollback: ALTER TABLE pos_settings DROP COLUMN expired_batch_policy,
-- DROP COLUMN expiry_warning_days (defaults preserved behavior).
ALTER TABLE pos_settings ADD COLUMN IF NOT EXISTS expired_batch_policy VARCHAR(20) NOT NULL DEFAULT 'block';
--> statement-breakpoint
ALTER TABLE pos_settings ADD CONSTRAINT pos_settings_expired_batch_policy_valid
  CHECK (expired_batch_policy in ('block','allow_with_approval'));
--> statement-breakpoint
ALTER TABLE pos_settings ADD COLUMN IF NOT EXISTS expiry_warning_days INTEGER DEFAULT 7;
