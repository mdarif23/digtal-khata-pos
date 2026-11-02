-- General-purpose audit trail for business-scoped financial operations.
-- Platform-owner actions stay in saas_admin_audit; subscription lifecycle
-- in subscription_events. Entries are written transactionally with the
-- operation they describe (services/audit.ts). metadata is non-sensitive
-- (amounts, statuses, ids) — never payment references or secrets.
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer REFERENCES "businesses"("id") ON DELETE SET NULL,
	"actor_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
	"action" varchar(80) NOT NULL,
	"entity_type" varchar(40) NOT NULL,
	"entity_id" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "audit_log_business_created_idx" ON "audit_log" ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" ("entity_type","entity_id");
