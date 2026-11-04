-- 0043: POS terminal registry, pairing, and hardware command relay.
--
-- pos_terminals: one Windows computer running the local hardware bridge.
-- Registered by a pos_terminal.manage holder at a location; the bridge
-- completes pairing through a one-time code and receives a secret that is
-- stored SHA-256 hashed (shown once, never retrievable). Terminal rows
-- follow the registers tenant pattern: composite (location_id, business_id)
-- FK plus (id, business_id) candidate key for child references.
--
-- terminal_pairing_codes: short-lived, single-use, stored hashed.
--
-- hardware_commands: targeted commands authored by the backend (drawer
-- kick) and claimed/executed/acked by the paired bridge. Command rows are
-- the audit trail — never financial records. Status transitions are
-- terminal (one-way): received/validated/executing → completed | failed |
-- unknown_outcome, expired server-side. No auto-retry of uncertain outcomes.

CREATE TYPE "public"."terminal_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."hardware_command_type" AS ENUM('drawer_open');--> statement-breakpoint
CREATE TYPE "public"."hardware_command_status" AS ENUM('pending', 'received', 'validated', 'executing', 'completed', 'failed', 'expired', 'unknown_outcome');--> statement-breakpoint
CREATE TABLE "pos_terminals" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"status" "terminal_status" DEFAULT 'active' NOT NULL,
	"secret_hash" varchar(64),
	"paired_at" timestamp with time zone,
	"created_by" integer,
	"device_info" jsonb,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "pos_terminals_location_name_unique" UNIQUE("location_id", "name"),
	CONSTRAINT "pos_terminals_id_business_uq" UNIQUE("id", "business_id")
);--> statement-breakpoint
CREATE TABLE "terminal_pairing_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"created_by" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "terminal_pairing_codes_code_hash_uq" UNIQUE("code_hash")
);--> statement-breakpoint
CREATE TABLE "hardware_commands" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"terminal_id" integer NOT NULL,
	"type" "hardware_command_type" NOT NULL,
	"status" "hardware_command_status" DEFAULT 'pending' NOT NULL,
	"requested_by" integer,
	"sale_id" integer,
	"reason" varchar(200),
	"note" text,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "hardware_commands_id_business_uq" UNIQUE("id", "business_id")
);--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_location_business_fkey" FOREIGN KEY ("location_id","business_id") REFERENCES "public"."locations"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_pairing_codes" ADD CONSTRAINT "terminal_pairing_codes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_pairing_codes" ADD CONSTRAINT "terminal_pairing_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_commands" ADD CONSTRAINT "hardware_commands_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_commands" ADD CONSTRAINT "hardware_commands_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_commands" ADD CONSTRAINT "hardware_commands_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_commands" ADD CONSTRAINT "hardware_commands_terminal_business_fkey" FOREIGN KEY ("terminal_id","business_id") REFERENCES "public"."pos_terminals"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pos_terminals_business_location_idx" ON "pos_terminals" USING btree ("business_id","location_id");--> statement-breakpoint
CREATE INDEX "terminal_pairing_codes_business_idx" ON "terminal_pairing_codes" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "hardware_commands_terminal_status_idx" ON "hardware_commands" USING btree ("terminal_id","status");--> statement-breakpoint
CREATE INDEX "hardware_commands_business_idx" ON "hardware_commands" USING btree ("business_id","created_at");
