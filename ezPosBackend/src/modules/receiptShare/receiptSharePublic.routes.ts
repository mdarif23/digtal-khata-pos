import express from "express";
import * as receiptShareController from "./receiptShare.controller.js";

const router = express.Router();

/**
 * P3 Phase 4 (N1-10): the ONLY unauthenticated receipt surface. A tiny
 * in-memory per-IP sliding-window limiter (no new dependency) blunts token
 * brute-force attempts; the 48-hex token space (2^192) plus hashed storage
 * does the real work. Unknown/expired/revoked tokens answer a uniform 404.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, number[]>();

function publicReceiptLimiter(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const ip =
    req.ip ??
    (typeof req.socket?.remoteAddress === "string"
      ? req.socket.remoteAddress
      : "unknown");
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const list = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  if (list.length >= MAX_PER_WINDOW) {
    res
      .status(429)
      .json({ success: false, message: "Too many requests. Try again shortly." });
    return;
  }
  list.push(now);
  hits.set(ip, list);
  // Opportunistic cleanup: drop stale windows when the map grows.
  if (hits.size > 10_000) {
    for (const [key, timestamps] of hits) {
      if (timestamps.every((t) => t <= windowStart)) hits.delete(key);
    }
  }
  next();
}

router.get(
  "/api/public/receipts/:token",
  publicReceiptLimiter,
  receiptShareController.getPublicReceipt,
);

export default router;
