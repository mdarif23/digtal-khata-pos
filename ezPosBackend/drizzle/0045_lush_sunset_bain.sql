CREATE TYPE "public"."landed_cost_settlement_type" AS ENUM('expense_payment', 'supplier_payable', 'cash', 'unpaid');--> statement-breakpoint
ALTER TABLE "landed_cost_expenses" ADD COLUMN "settlement_type" "landed_cost_settlement_type" DEFAULT 'unpaid' NOT NULL;--> statement-breakpoint
ALTER TABLE "landed_cost_expenses" ADD COLUMN "settlement_reference_id" integer;