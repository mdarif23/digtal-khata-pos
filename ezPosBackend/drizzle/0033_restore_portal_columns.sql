-- Restores the portal-completion schema that the refactor lineage had
-- reverted along with the ezposwebsite feature line. The merged code
-- (portal logo upload, onboarding resume, terms acceptance, session
-- last-active, ticket triage) requires these columns. Column shapes match
-- the original migrations verbatim so existing databases converge.
ALTER TABLE "businesses" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "onboarding_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "category" varchar(40) DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "priority" varchar(10) DEFAULT 'normal' NOT NULL;
