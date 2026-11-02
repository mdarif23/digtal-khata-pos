import { NextResponse } from "next/server";
import { trackOrder } from "@/lib/backend";


/** Order tracking bridge: invoice number + phone, verified by the backend. */
export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload || typeof payload.storefrontId !== "number") {
    return NextResponse.json(
      { ok: false, message: "Invalid request." },
      { status: 400 },
    );
  }
  const result = await trackOrder(payload);
  return NextResponse.json(
    { ok: result.ok, message: result.message, data: result.data },
    { status: result.ok ? 200 : 404 },
  );
}
