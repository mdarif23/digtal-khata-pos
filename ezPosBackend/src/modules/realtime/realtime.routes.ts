import express from "express";
import { mintTicket, openStream } from "./realtime.service.js";
import { requireAuth } from "../../middleware/auth.js";
import { getBusinessId, requireBusinessContext } from "../../middleware/business.js";
import { getLocationId, requireLocationAccess } from "../../middleware/location.js";

const router = express.Router();

/**
 * Real-time register updates (Module 11). The ticket endpoint runs the full
 * auth stack; the stream itself authenticates via the one-time ticket.
 */
router.post(
  "/api/realtime/ticket",
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
  (req, res) => {
    const ticket = mintTicket(req.user!.id, getBusinessId(req), getLocationId(req));
    res.status(200).json({ success: true, data: { ticket } });
  },
);

// The stream is its own auth surface (one-time ticket) — no requireAuth.
router.get("/api/realtime/stream", (req, res) => {
  openStream(req, res);
});


export default router;
