-- 0094: pairing codes can target an EXISTING terminal.
--
-- The Bangladesh-typical shop is 1 PC + printer + drawer, and offline sync
-- requires a terminal record even with zero hardware. Until now the ONLY way
-- to create a terminal was the bridge pairing exchange (code → insert), so
-- hardware-less shops had to run the bridge once just to register a PC.
-- A terminal can now be created directly (POST /api/terminals), and a
-- pairing code minted FOR that terminal attaches the bridge to it instead
-- of creating a duplicate.
--
-- terminal_id is nullable: legacy codes (bridge creates the terminal) stay
-- terminal-agnostic. Codes are single-use and short-lived; deleting a
-- terminal discards its outstanding codes.
--
-- Rollback: ALTER TABLE "terminal_pairing_codes" DROP COLUMN "terminal_id";

ALTER TABLE "terminal_pairing_codes"
  ADD COLUMN "terminal_id" integer REFERENCES "pos_terminals"("id") ON DELETE CASCADE;
