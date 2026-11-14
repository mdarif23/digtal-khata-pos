import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { PageHeader } from "@/components/common/PageHeader.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { Badge } from "@/components/ui/badge.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { usePermissions } from "@/hooks/usePermissions";
import axios from "../../../api/axios.js";
import { toast } from "@/components/ui/toast.js";

const tk = (n: number) => `৳${n}`;

interface TaxRate {
  id: number;
  name: string;
  rate: number;
  isInclusive: boolean;
  locationId: number | null;
  validFrom: string | null;
  validTo: string | null;
  isDefault: boolean;
  isActive: boolean;
}

/**
 * Tax rate configuration (Module 4). Rates apply business-wide in this UI;
 * location-scoped rates and effective dates can be set via the API and are
 * shown read-only here.
 */
export function TaxRatesPage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("taxes.manage");

  const [rates, setRates] = useState<TaxRate[] | null>(null);
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [inclusive, setInclusive] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await axios.get<{ data: TaxRate[] }>("/tax-rates", {
        params: { includeInactive: true },
      });
      setRates(res.data.data);
    } catch {
      toast.add({
        type: "error",
        description: "Could not load tax rates.",
        priority: "high",
      });
      setRates([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createRate() {
    const parsedRate = Number(rate);
    if (!name.trim() || !Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100) {
      toast.add({
        type: "error",
        description: "Enter a name and a rate between 0 and 100.",
        priority: "high",
      });
      return;
    }
    setBusy(true);
    try {
      await axios.post("/tax-rates", {
        name: name.trim(),
        rate: parsedRate,
        isInclusive: inclusive,
      });
      toast.add({ type: "success", description: "Tax rate created." });
      setName("");
      setRate("");
      setInclusive(false);
      await load();
    } catch (err) {
      toast.add({
        type: "error",
        description:
          err instanceof Error ? err.message : "Could not create the tax rate.",
        priority: "high",
      });
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(id: number) {
    setBusy(true);
    try {
      await axios.delete(`/tax-rates/${id}`);
      toast.add({ type: "success", description: "Tax rate deactivated." });
      await load();
    } catch (err) {
      toast.add({
        type: "error",
        description:
          err instanceof Error ? err.message : "Could not deactivate the rate.",
        priority: "high",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-6">
      <PageHeader
        title="Tax rates"
        description="Configurable VAT / tax rules. Rates apply to products assigned to them; historical sales keep the rate they were charged at."
      />
      <Card>
        <CardContent className="space-y-4 pt-0">
          {canManage && (
            <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
              <label className="text-sm">
                <span className="mb-1 block font-medium">Name</span>
                <Input
                  className="w-44"
                  placeholder="VAT 15%"
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">Rate (%)</span>
                <Input
                  className="w-28"
                  type="number"
                  min={0}
                  max={100}
                  step={0.001}
                  placeholder="15"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <Switch checked={inclusive} onCheckedChange={setInclusive} />
                Price includes tax
              </label>
              <Button className="ml-auto" disabled={busy} onClick={() => void createRate()}>
                Add rate
              </Button>
            </div>
          )}

          {rates === null ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : rates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No tax rates yet. Products without an assigned rate are
              tax-exempt; sales without rules use the manual VAT percent.
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Name</th>
                    <th className="p-2 font-medium">Rate</th>
                    <th className="p-2 font-medium">Mode</th>
                    <th className="p-2 font-medium">Status</th>
                    {canManage && <th className="p-2" />}
                  </tr>
                </thead>
                <tbody>
                  {rates.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="p-2">{r.name}</td>
                      <td className="p-2 font-mono">{tk(r.rate)}%</td>
                      <td className="p-2">
                        {r.isInclusive ? "Inclusive" : "Exclusive"}
                      </td>
                      <td className="p-2">
                        {r.isActive ? (
                          <Badge variant="outline">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Inactive</Badge>
                        )}
                        {r.isDefault && (
                          <Badge className="ml-1" variant="outline">
                            Default
                          </Badge>
                        )}
                      </td>
                      {canManage && (
                        <td className="p-2 text-right">
                          {r.isActive && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => void deactivate(r.id)}
                            >
                              Deactivate
                            </Button>
                          )}
                        </td>
                      )}
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
