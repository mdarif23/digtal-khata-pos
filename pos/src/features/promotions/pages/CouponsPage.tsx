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
import { Skeleton } from "@/components/ui/skeleton.js";
import { toast } from "@/components/ui/toast.js";
import axios from "../../../api/axios.js";

const tk = (n: number) => `৳${Number(n).toFixed(2)}`;

interface CouponRow {
  id: number;
  code: string;
  description: string | null;
  discountType: string;
  value: number;
  minOrderAmount: number;
  maxDiscountAmount: number | null;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  usedCount: number;
  isActive: boolean;
}

/**
 * Coupon management (Module 6): codes with windows, order minimums, caps
 * and usage limits. Redemption happens at the register (server-validated);
 * auto-applied promotions (BOGO, category rules) are a future engine.
 */
export function CouponsPage() {
  const [coupons, setCoupons] = useState<CouponRow[] | null>(null);
  const [code, setCode] = useState("");
  const [type, setType] = useState<"percentage" | "fixed">("percentage");
  const [value, setValue] = useState("");
  const [minOrder, setMinOrder] = useState("");
  const [cap, setCap] = useState("");
  const [usageLimit, setUsageLimit] = useState("");
  const [perCustomerLimit, setPerCustomerLimit] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await axios.get<{ data: CouponRow[] }>("/coupons");
      setCoupons(res.data.data);
    } catch {
      toast.add({ type: "error", description: "Could not load coupons." });
      setCoupons([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    const parsedValue = Number(value);
    if (!code.trim() || !Number.isFinite(parsedValue) || parsedValue < 0) {
      toast.add({ type: "error", description: "Enter a code and value." });
      return;
    }
    setBusy(true);
    try {
      await axios.post("/coupons", {
        code: code.trim().toUpperCase(),
        discountType: type,
        value: parsedValue,
        minOrderAmount: minOrder ? Number(minOrder) : 0,
        maxDiscountAmount: cap ? Number(cap) : null,
        usageLimit: usageLimit ? Number(usageLimit) : null,
        perCustomerLimit: perCustomerLimit ? Number(perCustomerLimit) : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      });
      toast.add({ type: "success", description: "Coupon created." });
      setCode("");
      setValue("");
      setMinOrder("");
      setCap("");
      setUsageLimit("");
      setPerCustomerLimit("");
      setEndsAt("");
      await load();
    } catch (err) {
      toast.add({
        type: "error",
        description:
          err instanceof Error ? err.message : "Could not create the coupon.",
        priority: "high",
      });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(coupon: CouponRow) {
    setBusy(true);
    try {
      await axios.patch(`/coupons/${coupon.id}`, {
        isActive: !coupon.isActive,
      });
      await load();
    } catch {
      toast.add({ type: "error", description: "Could not update the coupon." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>Coupons</CardTitle>
          <CardDescription>
            Codes are validated server-side at checkout: windows, minimums,
            caps and usage limits all enforced; every redemption is recorded
            against its sale.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 rounded-md border p-3 sm:grid-cols-4">
            <label className="text-sm">
              <span className="mb-1 block font-medium">Code</span>
              <Input
                className="uppercase"
                maxLength={60}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="SAVE10"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Type</span>
              <select
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={type}
                onChange={(e) =>
                  setType(e.target.value as "percentage" | "fixed")
                }
              >
                <option value="percentage">Percentage</option>
                <option value="fixed">Fixed amount</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">
                Value {type === "percentage" ? "(%)" : "(৳)"}
              </span>
              <Input
                type="number"
                min={0}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Min order (৳)</span>
              <Input
                type="number"
                min={0}
                value={minOrder}
                onChange={(e) => setMinOrder(e.target.value)}
                placeholder="0"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Max discount (৳)</span>
              <Input
                type="number"
                min={0}
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                placeholder="no cap"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Usage limit</span>
              <Input
                type="number"
                min={0}
                value={usageLimit}
                onChange={(e) => setUsageLimit(e.target.value)}
                placeholder="unlimited"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Per customer</span>
              <Input
                type="number"
                min={0}
                value={perCustomerLimit}
                onChange={(e) => setPerCustomerLimit(e.target.value)}
                placeholder="unlimited"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Ends at</span>
              <Input
                type="date"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </label>
            <div className="col-span-2 flex items-end sm:col-span-4">
              <Button disabled={busy} onClick={() => void create()}>
                Create coupon
              </Button>
            </div>
          </div>

          {coupons === null ? (
            <Skeleton className="h-32 w-full" />
          ) : coupons.length === 0 ? (
            <p className="text-sm text-muted-foreground">No coupons yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Code</th>
                    <th className="p-2 font-medium">Discount</th>
                    <th className="p-2 text-right font-medium">Used</th>
                    <th className="p-2 font-medium">Limits</th>
                    <th className="p-2 font-medium">Status</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {coupons.map((coupon) => (
                    <tr key={coupon.id} className="border-t">
                      <td className="p-2 font-mono">{coupon.code}</td>
                      <td className="p-2">
                        {coupon.discountType === "percentage"
                          ? `${coupon.value}%`
                          : tk(coupon.value)}
                        {coupon.maxDiscountAmount !== null && (
                          <span className="text-xs text-muted-foreground">
                            {" "}
                            (cap {tk(coupon.maxDiscountAmount)})
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-right font-mono">
                        {coupon.usedCount}
                        {coupon.usageLimit !== null
                          ? ` / ${coupon.usageLimit}`
                          : ""}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {coupon.perCustomerLimit !== null
                          ? `${coupon.perCustomerLimit}× per customer`
                          : ""}
                        {coupon.endsAt
                          ? ` · ends ${new Date(coupon.endsAt).toLocaleDateString()}`
                          : ""}
                      </td>
                      <td className="p-2">
                        <Badge
                          variant={coupon.isActive ? "default" : "secondary"}
                        >
                          {coupon.isActive ? "Active" : "Paused"}
                        </Badge>
                      </td>
                      <td className="p-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void toggle(coupon)}
                        >
                          {coupon.isActive ? "Pause" : "Activate"}
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
    </div>
  );
}
