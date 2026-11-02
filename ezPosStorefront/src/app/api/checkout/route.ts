import { NextResponse } from "next/server";
import { submitCheckout } from "@/lib/backend";


/**
 * Server-side checkout bridge: the browser posts its cart here, and this
 * route forwards it to the backend's internal storefront endpoint with the
 * shared token. The backend recomputes prices, validates stock and zones,
 * and creates the order — nothing from the client is trusted.
 */
export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload || typeof payload.storefrontId !== "number") {
    return NextResponse.json(
      { ok: false, message: "Invalid checkout request." },
      { status: 400 },
    );
  }

  const result = await submitCheckout(payload);
  return NextResponse.json(
    { ok: result.ok, message: result.message, data: result.data },
    { status: result.ok ? 201 : 400 },
  );
}
