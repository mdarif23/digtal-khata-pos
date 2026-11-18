-- 0090: Round-3 audit follow-through (WB-01 companion). WooCommerce order
-- webhooks with status 'processing'/'completed' mean the money was already
-- taken in Woo. The ingest now records that capture as a first-class
-- sale_payments row (confirmWooPaidOrder → confirm prepaid), so the GL
-- debits the bank account instead of leaving an unpaid COD receivable for
-- a paid order. The sale_payments_method_valid check constraint (0000,
-- extended by 0026/0027/0035) does not yet accept the 'woocommerce'
-- method — the insert would violate it and abort the confirm.
--
-- Rollback: restore the previous constraint (sslcommerz list, no woocommerce)
--   ALTER TABLE "sale_payments" DROP CONSTRAINT "sale_payments_method_valid";
--   ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_method_valid"
--     CHECK ("sale_payments"."payment_method" in
--     ('cash','bangla_qr','card','store_credit','loyalty_points','gift_card','sslcommerz'));

ALTER TABLE "sale_payments" DROP CONSTRAINT "sale_payments_method_valid";--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_method_valid"
  CHECK ("sale_payments"."payment_method" in ('cash','bangla_qr','card','store_credit','loyalty_points','gift_card','sslcommerz','woocommerce'));
