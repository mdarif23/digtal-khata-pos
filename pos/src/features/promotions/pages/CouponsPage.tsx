import { useCallback, useEffect, useState } from "react";
import { Ticket } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import {
  Card,
  CardContent,
} from "@/components/ui/card.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { StatusBadge } from "@/components/common/StatusBadge";
import { EmptyState } from "@/components/common/EmptyState";
import { formatCurrency, formatDate } from "@/lib/format";
import { toast } from "@/components/ui/toast.js";
import axios from "../../../api/axios.js";

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
        // End of the chosen business day (H1-04): a bare date parses to
        // 00:00 UTC, which in Dhaka kills the coupon at 06:00 local on its
        // last day. Same end-of-day convention as PromotionsPage.
        endsAt: endsAt ? new Date(`${endsAt}T23:59:59`).toISOString() : null,
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
    <PageContainer width="wide">
      <PageHeader
        title="Coupons"
        description="Codes are validated server-side at checkout: windows, minimums, caps and usage limits all enforced; every redemption is recorded against its sale."
      />
      <Card>
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
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead className="text-right">Discount</TableHead>
                    <TableHead className="text-right">Used</TableHead>
                    <TableHead>Limits</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {coupons.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6}>
                        <EmptyState
                          icon={Ticket}
                          title="No coupons yet"
                          description="Create a code above to discount orders at checkout."
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    coupons.map((coupon) => (
                      <TableRow key={coupon.id}>
                        <TableCell className="font-mono">{coupon.code}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {coupon.discountType === "percentage"
                            ? `${coupon.value}%`
                            : formatCurrency(coupon.value)}
                          {coupon.maxDiscountAmount !== null && (
                            <span className="text-xs text-muted-foreground">
                              {" "}
                              (cap {formatCurrency(coupon.maxDiscountAmount)})
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {coupon.usedCount}
                          {coupon.usageLimit !== null
                            ? ` / ${coupon.usageLimit}`
                            : ""}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {coupon.perCustomerLimit !== null
                            ? `${coupon.perCustomerLimit}× per customer`
                            : ""}
                          {coupon.endsAt
                            ? ` · ends ${formatDate(coupon.endsAt)}`
                            : ""}
                        </TableCell>
                        <TableCell>
                          {coupon.isActive ? (
                            <StatusBadge tone="success">Active</StatusBadge>
                          ) : (
                            <StatusBadge tone="warning">Paused</StatusBadge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void toggle(coupon)}
                          >
                            {coupon.isActive ? "Pause" : "Activate"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
