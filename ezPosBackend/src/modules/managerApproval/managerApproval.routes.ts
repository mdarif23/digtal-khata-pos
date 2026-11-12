import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessContext, requireFullAccess } from "../../middleware/business.js";
import * as controller from "./managerApproval.controller.js";

const router = express.Router();

const read = [requireAuth, requireBusinessContext()] as const;
// Setting/removing a PIN mutates security credentials — subscription-gated
// like other writes. Verifying mints an approval token and is deliberately
// not full-access-gated: the CONSUMING operation enforces its own gates, and
// the pin check itself is the rate-limited secret gate.
const write = [...read, requireFullAccess] as const;

router.get("/api/manager-approval/ops", ...read, controller.getApprovalOps);
router.post("/api/manager-approval/pin", ...write, controller.postPin);
router.delete("/api/manager-approval/pin", ...write, controller.deletePin);
router.post("/api/manager-approval/verify", ...read, controller.postVerify);

export default router;
