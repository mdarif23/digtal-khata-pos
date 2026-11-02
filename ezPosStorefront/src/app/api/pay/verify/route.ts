import { NextResponse } from "next/server";
import { verifyOrderPayment } from "@/lib/backend";

/**
 * Payment verification bridge (renderer → backend internal verify core).
 * The gateway redirect never marks an order paid; this endpoint triggers
 * the idempotent server-side verification.
 */
export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload) {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const result = await verifyOrderPayment(payload);
  return NextResponse.json(
    { ok: result.ok, message: result.message, data: result.data },
    { status: result.ok ? 200 : 400 },
  );
}
