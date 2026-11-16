-- 0080: P3 Phase 1 — named sale-level charges (F1).
--
-- POS sales had no first-class place for sale-level fees (delivery, service,
-- packing). The storefront's sales.delivery_fee column is online-only
-- semantics (online profitability treats it as shipping income and POS
-- createSale never writes it), so POS charges get their own child table
-- instead of overloading that column. Charges are post-VAT additive
-- components of final_total (approved decision D1) and are deliberately NOT
-- sale_items rows, so every product-level profitability report (which
-- aggregates from sale_items) is unaffected by construction.
--
-- Composite (sale_id, business_id) FK mirrors sale_payments' house style so
-- a charge row can never point at another tenant's sale.
--
-- Rollback: DROP TABLE sale_charges (purely additive; no existing column
-- changes meaning; amounts live in final_total exactly as written at sale
-- time, so dropping the table loses only the per-charge label breakdown).
CREATE TABLE IF NOT EXISTS sale_charges (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sale_id INTEGER NOT NULL,
  label VARCHAR(120) NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sale_charges_amount_nonnegative CHECK (amount >= 0),
  CONSTRAINT sale_charges_label_nonempty CHECK (length(btrim(label)) > 0),
  CONSTRAINT sale_charges_sale_business_fkey
    FOREIGN KEY (sale_id, business_id) REFERENCES sales(id, business_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sale_charges_business_sale_idx ON sale_charges (business_id, sale_id);
