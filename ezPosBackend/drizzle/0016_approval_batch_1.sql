ALTER TABLE "businesses" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "onboarding_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "category" varchar(40) DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "priority" varchar(10) DEFAULT 'normal' NOT NULL;