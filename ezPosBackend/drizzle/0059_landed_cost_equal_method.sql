-- 0059: "equal" landed-cost allocation method (owner-approved plan,
-- Phase 6): every eligible received line shares the capitalizable total
-- equally. Additive enum value — no data migration, no row changes.
ALTER TYPE "landed_cost_allocation_method" ADD VALUE 'equal';
