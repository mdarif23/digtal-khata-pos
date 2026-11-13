-- 0078: P0 fix — fractional refunds for sold-by-weight lines.
-- sale_refund_items.quantity was integer while sale_items.quantity became
-- double precision in 0075. A full-line refund of a 0.75 kg sale line wrote
-- 0.75 into an integer column — Postgres's assignment cast silently rounded
-- it to 1, overstating the returned quantity in the refund ledger (the
-- per-line remaining computation SUMs this column) while stock restock used
-- the correct fractional value. Widening to double precision matches every
-- other quantity column (0075) and keeps refund ledger, stock and reports
-- consistent.
-- customer_warranties.returned_quantity has the same defect class: partial
-- refunds bump it by the returned quantity, so a warranted sold-by-weight
-- line would silently round its returned amount. Same widening.
-- Rollback: ALTER COLUMN TYPE integer (fails once fractional values exist —
-- reverting requires zero fractional rows first).

ALTER TABLE "sale_refund_items" ALTER COLUMN "quantity" TYPE double precision;
--> statement-breakpoint
ALTER TABLE "customer_warranties" ALTER COLUMN "returned_quantity" TYPE double precision;
