import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";

const jsonMessage = (message: string) => ({
  success: false,
  message,
});

/**
 * Tighter limit for credential entry points (login, registration, email
 * verification). Keyed by IP; adjust or add a store before horizontal scaling.
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage(
    "Too many attempts. Please try again in a few minutes.",
  ),
});

/**
 * Refresh happens automatically per client whenever the short-lived access
 * token expires, so it gets a higher ceiling than credential endpoints.
 */
export const refreshRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.refreshRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage(
    "Too many session refreshes. Please try again in a few minutes.",
  ),
});

/**
 * Public, unauthenticated contact form — kept tight so it cannot be used
 * as a spam relay into the support inbox. Keyed by IP.
 */
export const contactRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage(
    "Too many messages sent. Please try again in an hour.",
  ),
});

/**
 * Gateway IPN callbacks (server-to-server, no auth by design — payloads
 * are verified with the provider). Generous ceiling for legit retries,
 * tight enough to not be a public write amplifier. Keyed by IP.
 */
export const ipnRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage("Too many requests."),
});

/**
 * Drawer-command authoring: keyed by USER (POS terminals often share one
 * office IP), tight enough that a compromised session cannot spam physical
 * drawer kicks (each command expires in 15 s anyway). Cashier workflows
 * need at most a few kicks per minute.
 */
export const drawerCommandRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.user?.id !== undefined
      ? String(req.user.id)
      : ipKeyGenerator(req.ip ?? "anonymous"),
  message: jsonMessage("Too many drawer commands — wait a moment."),
});

/**
 * Bridge claim/ack polling: keyed by terminal id. Legit bridges poll every
 * ~2 s (≈30 claims/min); the ceiling tolerates a few terminals behind one
 * address without letting a runaway client hammer the database.
 */
export const bridgePollRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const raw = req.headers["x-terminal-id"];
    const id = Array.isArray(raw) ? raw[0] : raw;
    return id ? `terminal-${id}` : ipKeyGenerator(req.ip ?? "anonymous");
  },
  message: jsonMessage("Too many bridge requests — check the bridge poll interval."),
});
