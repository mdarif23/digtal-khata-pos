import express from "express";
import * as giftCardsController from "./giftCards.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";
import { requireLocationAccess } from "../../middleware/location.js";

const router = express.Router();

const read = [requireAuth, requireBusinessContext()] as const;
const write = [...read, requireFullAccess] as const;

router.get(
  "/api/gift-cards",
  ...read,
  requirePermission("pos.view"),
  giftCardsController.listGiftCards,
);
// Issues a card. Paid issues (paymentMethod given) post the money side —
// GL cash/bank vs 2040 plus a drawer cash_in — so the route resolves the
// caller's location for the drawer attribution.
router.post(
  "/api/gift-cards",
  ...write,
  requireLocationAccess(),
  requirePermission("pos.create_sale"),
  giftCardsController.issueGiftCard,
);
// Balance lookup by code for the checkout redeem flow.
router.post(
  "/api/gift-cards/lookup",
  ...write,
  requirePermission("pos.create_sale"),
  giftCardsController.lookupGiftCard,
);
router.get(
  "/api/gift-cards/:id",
  ...read,
  requirePermission("pos.view"),
  giftCardsController.getGiftCard,
);
router.post(
  "/api/gift-cards/:id/status",
  ...write,
  requirePermission("pos.create_sale"),
  giftCardsController.setGiftCardStatus,
);

export default router;
