-- 0087: P3 Phase 4 (N1-10) — secure expiring receipt share links.
--
-- Share links let a merchant hand a customer a receipt URL without exposing
-- the internal sale id or granting any account access. Tokens are stored
-- ONLY as SHA-256 hashes (the CFD display-token model: the plaintext token
-- is shown/copied exactly once at creation), scoped per business + sale,
-- expiring, and revocable. No permanent public exposure: an expired or
-- revoked token resolves to nothing.
--
-- Rollback: DROP TABLE receipt_share_tokens (links simply stop resolving).
CREATE TABLE IF NOT EXISTS receipt_share_tokens (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sale_id INTEGER NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT receipt_share_tokens_sale_business_fkey
    FOREIGN KEY (sale_id, business_id) REFERENCES sales(id, business_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS receipt_share_tokens_token_uq ON receipt_share_tokens (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS receipt_share_tokens_business_sale_idx ON receipt_share_tokens (business_id, sale_id);
