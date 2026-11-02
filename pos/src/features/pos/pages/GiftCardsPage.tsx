import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Badge } from "@/components/ui/badge.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { toast } from "@/components/ui/toast.js";
import axios from "../../../api/axios.js";

const tk = (n: number) => `৳${Number(n).toFixed(2)}`;

interface GiftCardRow {
  id: number;
  codeLast4: string;
  initialAmount: number;
  balance: number;
  status: string;
  expiresAt: string | null;
  issuedAt: string;
  note: string | null;
}

interface GiftCardDetail {
  card: GiftCardRow;
  balance: number;
  transactions: {
    id: number;
    amount: number;
    sourceType: string;
    note: string | null;
    createdAt: string;
  }[];
}

/**
 * Gift cards (Module 7): issue (the code is shown exactly once — only its
 * SHA-256 hash is stored), track balances, and deactivate. Redemption
 * happens at the register via the Gift card payment method; balances are
 * ledger sums and every redemption is transactionally locked.
 */
export function GiftCardsPage() {
  const [cards, setCards] = useState<GiftCardRow[] | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [expiry, setExpiry] = useState("");
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<GiftCardDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await axios.get<{ data: GiftCardRow[] }>("/gift-cards");
      setCards(res.data.data);
    } catch {
      toast.add({ type: "error", description: "Could not load gift cards." });
      setCards([]);
    }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    try {
      const res = await axios.get<{ data: GiftCardDetail }>(`/gift-cards/${id}`);
      setDetail(res.data.data);
    } catch {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (detailId !== null) void loadDetail(detailId);
  }, [detailId, loadDetail]);

  async function issue() {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.add({ type: "error", description: "Enter a positive amount." });
      return;
    }
    setBusy(true);
    try {
      const res = await axios.post<{ data: { code: string } }>("/gift-cards", {
        initialAmount: parsed,
        expiresAt: expiry ? new Date(expiry).toISOString() : null,
      });
      setIssuedCode(res.data.data.code);
      setAmount("");
      setExpiry("");
      await load();
    } catch (err) {
      toast.add({
        type: "error",
        description:
          err instanceof Error ? err.message : "Could not issue the card.",
        priority: "high",
      });
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(card: GiftCardRow) {
    setBusy(true);
    try {
      await axios.post(`/gift-cards/${card.id}/status`, {
        status: card.status === "active" ? "inactive" : "active",
      });
      await load();
      if (detailId === card.id) await loadDetail(card.id);
    } catch {
      toast.add({ type: "error", description: "Could not update the card." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle>Gift cards</CardTitle>
            <CardDescription>
              Codes are stored hashed — the full code is shown exactly once
              at issue. Redeem at the register with the Gift card payment
              method; every redemption is transactionally locked.
            </CardDescription>
          </div>
          <Button onClick={() => setIssueOpen(true)}>Issue card</Button>
        </CardHeader>
        <CardContent>
          {cards === null ? (
            <Skeleton className="h-32 w-full" />
          ) : cards.length === 0 ? (
            <p className="text-sm text-muted-foreground">No gift cards yet.</p>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Card</th>
                    <th className="p-2 text-right font-medium">Issued</th>
                    <th className="p-2 text-right font-medium">Balance</th>
                    <th className="p-2 font-medium">Status</th>
                    <th className="p-2 font-medium">Expires</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {cards.map((card) => (
                    <tr key={card.id} className="border-t">
                      <td className="p-2">
                        <button
                          type="button"
                          className="font-medium underline-offset-2 hover:underline"
                          onClick={() => setDetailId(card.id)}
                        >
                          ••{card.codeLast4}
                        </button>
                      </td>
                      <td className="p-2 text-right font-mono">
                        {tk(card.initialAmount)}
                      </td>
                      <td className="p-2 text-right font-mono">
                        {tk(card.balance)}
                      </td>
                      <td className="p-2">
                        <Badge
                          variant={
                            card.status === "active" ? "default" : "secondary"
                          }
                        >
                          {card.status}
                        </Badge>
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {card.expiresAt
                          ? new Date(card.expiresAt).toLocaleDateString()
                          : "Never"}
                      </td>
                      <td className="p-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void toggleStatus(card)}
                        >
                          {card.status === "active" ? "Deactivate" : "Activate"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Issue dialog */}
      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogContent className="sm:max-w-md">
          {issuedCode === null ? (
            <>
              <DialogHeader>
                <DialogTitle>Issue a gift card</DialogTitle>
                <DialogDescription>
                  The code is generated server-side and shown once after
                  creation.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Amount</span>
                  <Input
                    type="number"
                    min={0.01}
                    step={0.01}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="500"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">
                    Expires (optional)
                  </span>
                  <Input
                    type="date"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                  />
                </label>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setIssueOpen(false)}>
                    Cancel
                  </Button>
                  <Button disabled={busy} onClick={() => void issue()}>
                    {busy ? "Issuing…" : "Issue card"}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Card issued</DialogTitle>
                <DialogDescription>
                  Copy this code now — it is shown{" "}
                  <span className="font-semibold">only this once</span> and
                  cannot be recovered (only its hash is stored).
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-md border bg-muted/40 p-4 text-center font-mono text-xl tracking-widest">
                {issuedCode}
              </div>
              <div className="flex justify-end">
                <Button
                  onClick={() => {
                    setIssuedCode(null);
                    setIssueOpen(false);
                  }}
                >
                  Done
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <Dialog
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Gift card ••{detail.card.codeLast4}
                </DialogTitle>
                <DialogDescription>
                  Balance {tk(detail.balance)} of {tk(detail.card.initialAmount)}{" "}
                  issued
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1">
                {detail.transactions.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between border-b py-1 text-sm last:border-0"
                  >
                    <span>
                      {t.sourceType}
                      {t.note ? ` — ${t.note}` : ""}
                    </span>
                    <span
                      className={`font-mono ${
                        t.amount < 0 ? "text-red-600" : "text-emerald-700"
                      }`}
                    >
                      {t.amount > 0 ? "+" : ""}
                      {tk(t.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
