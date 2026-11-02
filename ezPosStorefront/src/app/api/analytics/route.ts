import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * Analytics beacon bridge: shopper browsers POST here (fire-and-forget),
 * this route rate-limits per IP and forwards to the backend's internal
 * sink with the shared token. Never blocks or errors the shopper.
 */
export async function POST(request: Request) {
  const { allowed } = rateLimit(`analytics:${clientIp(request)}`, 30, 60_000);
  if (!allowed) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }
  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload) {
    return NextResponse.json({ ok: true });
  }
  try {
    const { serverConfig, requireInternalToken } = await import("@/lib/config");
    await fetch(
      `${serverConfig.backendUrl}/api/internal/storefront/analytics`,
      {
        method: "POST",
        headers: {
          "x-internal-token": requireInternalToken(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      },
    );
  } catch {
    // Fire-and-forget: swallow forwarding failures.
  }
  return NextResponse.json({ ok: true });
}
