import { NextResponse } from "next/server";
import { shopperMe, shopperSession } from "@/lib/backend";

/**
 * Shopper account bridge: the browser never touches the backend's internal
 * token — this route attaches it server-side.
 * POST { action: "login" | "register", storefrontId, ...credentials }
 * GET  /api/shopper?storefrontId=N with Authorization: Bearer <shopper token>
 */
export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as
    | (Record<string, unknown> & { action?: string })
    | null;
  if (!payload || typeof payload.storefrontId !== "number") {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const action = payload.action === "register" ? "register" : "login";
  const result = await shopperSession(action, payload);
  return NextResponse.json(
    { ok: result.ok, message: result.message, token: result.token },
    { status: result.ok ? 200 : 400 },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const storefrontId = Number(url.searchParams.get("storefrontId") ?? "");
  const auth = request.headers.get("authorization") ?? "";
  if (!Number.isInteger(storefrontId) || storefrontId <= 0 || !auth.startsWith("Bearer ")) {
    return NextResponse.json({ ok: false, message: "Not signed in." }, { status: 401 });
  }
  const result = await shopperMe(storefrontId, auth.slice(7));
  return NextResponse.json(
    { ok: result.ok, message: result.message, data: result.data },
    { status: result.ok ? 200 : 401 },
  );
}
