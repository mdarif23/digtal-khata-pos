-- 0093: walk-in (supplier-less) purchases could never be returned —
-- purchase_returns.supplier_id was NOT NULL and the whole return flow was
-- supplier-gated, so a walk-in purchase (the only payment path being
-- receive-time) was permanently stuck with unwanted stock. Returns are
-- stock events; the supplier credit note is what needs a supplier — that
-- insert is skipped for walk-ins (no phantom credit without a payee).
--
-- Rollback: rows with NULL supplier_id must be deleted first.
--   DELETE FROM purchase_returns WHERE supplier_id IS NULL;
--   ALTER TABLE "purchase_returns" ALTER COLUMN "supplier_id" SET NOT NULL;

ALTER TABLE "purchase_returns" ALTER COLUMN "supplier_id" DROP NOT NULL;
