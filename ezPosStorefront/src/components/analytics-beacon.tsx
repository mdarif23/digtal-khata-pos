"use client";

import { useEffect, useRef } from "react";

/**
 * Fire-and-forget analytics beacons (only mounted when the store has
 * analytics enabled). No cookies, no PII — a random per-session visitor ref.
 */
export function AnalyticsBeacon({
  storefrontId,
  productId,
}: {
  storefrontId: number;
  productId?: number;
}) {
  const visitorRef = useRef<string | null>(null);
  if (visitorRef.current === null) {
    visitorRef.current =
      globalThis.crypto?.randomUUID?.().slice(0, 24) ??
      `v-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  useEffect(() => {
    const payload = {
      storefrontId,
      eventType: productId ? ("product_view" as const) : ("visit" as const),
      path: window.location.pathname,
      ...(productId ? { productId } : {}),
      visitorRef: visitorRef.current,
    };
    const controller = new AbortController();
    void fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      keepalive: true,
    }).catch(() => undefined);
    return () => controller.abort();
  }, [storefrontId, productId]);

  return null;
}
