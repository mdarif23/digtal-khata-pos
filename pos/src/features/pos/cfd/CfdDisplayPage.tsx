import { useCallback, useEffect, useRef, useState } from "react";
import { Monitor, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { claimCfdApi } from "./cfd.api";

interface CfdPayload {
  status: "idle" | "cart" | "paid";
  businessName: string;
  logoUrl: string | null;
  idleMessage: string | null;
  promoMessage: string | null;
  items: {
    name: string;
    variantName: string | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
  discountTotal: number;
  vatTotal: number;
  grandTotal: number;
  paidTotal: number;
  dueTotal: number;
}

const TOKEN_KEY = "ezpos.cfd.displayToken";

function formatBDT(value: number): string {
  return `৳${value.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Customer-facing display (Phase 3 — master prompt Feature 1): a READ-ONLY
 * second screen. Pairs once with an 8-character code from the POS, then
 * follows the live cart over SSE. Strictly read-only — this page has no
 * write paths and no authenticated API access beyond its own token.
 */
export function CfdDisplayPage() {
  const [token, setToken] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [payload, setPayload] = useState<CfdPayload | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("Customer display");
  const [pairing, setPairing] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY));
  }, []);

  const connect = useCallback((displayToken: string) => {
    sourceRef.current?.close();
    const source = new EventSource(`/api/cfd/stream?token=${displayToken}`);
    sourceRef.current = source;
    source.onopen = () => setConnected(true);
    source.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects; a revoked token keeps failing until
      // the display re-pairs (the error state shows the pairing form).
      setTimeout(() => {
        if (source.readyState === EventSource.CLOSED) {
          source.close();
          setToken((current) => (current === displayToken ? null : current));
        }
      }, 2000);
    };
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as {
          type: string;
          payload?: CfdPayload;
        };
        if (parsed.type === "connected") setConnected(true);
        if (parsed.type === "payload" && parsed.payload) setPayload(parsed.payload);
      } catch {
        // ignore malformed frames
      }
    };
  }, []);

  useEffect(() => {
    if (token) connect(token);
    return () => sourceRef.current?.close();
  }, [token, connect]);

  async function handleClaim() {
    if (!/^[A-Z0-9]{8}$/.test(code.trim().toUpperCase())) return;
    setPairing(true);
    try {
      const claimed = await claimCfdApi(code.trim().toUpperCase(), name);
      localStorage.setItem(TOKEN_KEY, claimed.token);
      setToken(claimed.token);
      setConnected(false);
    } catch {
      // the form shows a generic hint; wrong/expired codes just fail
    } finally {
      setPairing(false);
    }
  }

  // ---- Pairing screen ----
  if (!token) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-gray-950 p-8 text-white">
        <div className="flex items-center gap-3 text-2xl font-semibold">
          <Monitor className="size-7" /> Customer display
        </div>
        <div className="grid w-full max-w-sm gap-3 rounded-xl bg-gray-900 p-6">
          <p className="text-sm text-gray-400">
            Enter the pairing code shown on the register (valid 10 minutes).
          </p>
          <Input
            autoFocus
            className="h-12 border-gray-700 bg-gray-800 text-center font-mono text-2xl tracking-[0.4em] text-white placeholder:text-gray-600"
            maxLength={8}
            placeholder="········"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && void handleClaim()}
          />
          <Input
            className="border-gray-700 bg-gray-800 text-white"
            placeholder="Display name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            className="h-11"
            disabled={pairing || code.length !== 8}
            onClick={() => void handleClaim()}
          >
            {pairing ? "Pairing…" : "Pair this screen"}
          </Button>
        </div>
      </div>
    );
  }

  // ---- Display screens ----
  const status = payload?.status ?? "idle";
  return (
    <div className="relative flex min-h-dvh flex-col bg-gray-950 text-white">
      <div className="absolute right-4 top-4 flex items-center gap-2 text-xs">
        {connected ? (
          <span className="flex items-center gap-1.5 rounded-full bg-green-900/60 px-2.5 py-1 text-green-300">
            <span className="size-2 rounded-full bg-green-400" /> Connected
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-full bg-red-900/60 px-2.5 py-1 text-red-300">
            <WifiOff className="size-3" /> Reconnecting…
          </span>
        )}
      </div>

      {status === "idle" || payload === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 p-10 text-center">
          <h1 className="text-5xl font-bold">
            {payload?.businessName || "Welcome"}
          </h1>
          <p className="max-w-xl text-xl text-gray-400">
            {payload?.promoMessage || payload?.idleMessage || "We're glad you're here."}
          </p>
        </div>
      ) : status === "paid" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 p-10 text-center">
          <h1 className="text-5xl font-bold text-green-400">Thank you!</h1>
          <p className="text-2xl text-gray-300">
            Paid {formatBDT(payload.paidTotal)}
            {payload.dueTotal > 0
              ? ` · due ${formatBDT(payload.dueTotal)}`
              : ""}
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-4 p-8">
          <h1 className="text-3xl font-semibold">{payload.businessName}</h1>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-xl">
              <tbody>
                {payload.items.map((item, idx) => (
                  <tr key={idx} className="border-b border-gray-800">
                    <td className="py-3">
                      {item.name}
                      {item.variantName ? (
                        <span className="ml-2 text-sm text-gray-500">
                          {item.variantName}
                        </span>
                      ) : null}
                      <span className="ml-3 text-gray-400">× {item.quantity}</span>
                    </td>
                    <td className="py-3 text-right font-mono">
                      {formatBDT(item.lineTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ml-auto w-full max-w-sm space-y-2 text-2xl">
            {payload.discountTotal > 0 ? (
              <div className="flex justify-between text-gray-400">
                <span>Discount</span>
                <span>-{formatBDT(payload.discountTotal)}</span>
              </div>
            ) : null}
            {payload.vatTotal > 0 ? (
              <div className="flex justify-between text-gray-400">
                <span>VAT</span>
                <span>{formatBDT(payload.vatTotal)}</span>
              </div>
            ) : null}
            <div className="flex justify-between font-bold text-green-400">
              <span>Total</span>
              <span>{formatBDT(payload.grandTotal)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
