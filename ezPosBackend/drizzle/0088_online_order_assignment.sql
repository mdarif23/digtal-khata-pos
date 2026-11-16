-- 0088: Flexible Business Operating Model — online order assignment.
--
-- Online managers assign orders to employees: the CURRENT owner of the
-- fulfillment task lives on the sales row (nullable — NULL = unassigned,
-- every pre-existing row). Assignment history is the append-only
-- sale_order_events trail ('assigned'/'unassigned' events with actor +
-- metadata), so reassignment never rewrites history. The assignee is an
-- operational owner, NOT a commission attribution — salesperson_* columns
-- keep that separate role.
--
-- Rollback: DROP INDEX IF EXISTS sales_business_assignee_idx;
--           ALTER TABLE sales DROP COLUMN assigned_by_user_id,
--             DROP COLUMN assigned_at, DROP COLUMN assigned_to_user_id;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS assigned_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE sales ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
--> statement-breakpoint
ALTER TABLE sales ADD COLUMN IF NOT EXISTS assigned_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
-- The manager's work queue: open (completed-but-not-final) orders per
-- assignee. Delivered/returned orders leave the queue, so the partial
-- index keeps it small.
CREATE INDEX IF NOT EXISTS sales_business_assignee_idx ON sales (business_id, assigned_to_user_id)
  WHERE status = 'completed'
    AND assigned_to_user_id IS NOT NULL
    AND fulfillment_status NOT IN ('delivered', 'returned', 'partially_returned');
