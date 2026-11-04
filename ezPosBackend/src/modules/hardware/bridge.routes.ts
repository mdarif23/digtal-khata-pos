import express from "express";
import * as bridgeController from "./bridge.controller.js";
import { requireTerminalAuth } from "../../middleware/terminalAuth.js";
import { authRateLimit, bridgePollRateLimit } from "../../middleware/rateLimit.js";

const router = express.Router();

// Pairing exchange is public-by-design (the bridge has no credentials yet):
// the one-time code is the credential, IP rate-limited like auth endpoints.
router.post(
  "/api/bridge/pair",
  authRateLimit,
  bridgeController.bridgePair,
);

// Everything below requires a paired terminal's secret. Poll endpoints get
// a per-terminal ceiling so a runaway bridge cannot hammer the database.
const terminal = [requireTerminalAuth(), bridgePollRateLimit] as const;

router.get(
  "/api/bridge/terminal",
  ...terminal,
  bridgeController.bridgeTerminalSelf,
);
router.post(
  "/api/bridge/commands/claim",
  ...terminal,
  bridgeController.bridgeClaimCommands,
);
router.post(
  "/api/bridge/commands/:commandId/ack",
  ...terminal,
  bridgeController.bridgeAckCommand,
);

export default router;
