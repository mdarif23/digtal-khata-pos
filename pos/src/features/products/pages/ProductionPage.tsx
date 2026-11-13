import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import api from "@/api/axios.js";

interface BomComponent {
  id?: number;
  componentVariantId: number;
  componentName: string;
  componentSku: string | null;
  quantity: number;
  wastePercent: number;
}

interface BomResponse {
  parentVariantId: number;
  components: BomComponent[];
  estimatedUnitCost: number;
}

function extractError(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: { data?: { message?: string } } }).response
      ?.data?.message === "string"
  ) {
    return (error as { response: { data: { message: string } } }).response.data
      .message;
  }
  return fallback;
}

interface VariantOption {
  id: number;
  label: string;
}

/**
 * Production (Phase 4 — Features 9): BOM editor per variant plus one-click
 * production runs. Assemble-on-sale composites consume components at sale
 * time; production runs pre-assemble finished stock at component cost.
 */
export function ProductionPage() {
  const [options, setOptions] = useState<VariantOption[]>([]);
  const [locations, setLocations] = useState<{ id: number; name: string }[]>([]);
  const [selectedVariant, setSelectedVariant] = useState("");
  const [bom, setBom] = useState<BomResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runQuantity, setRunQuantity] = useState("1");
  const [runLocation, setRunLocation] = useState("");
  const [newComponent, setNewComponent] = useState("");

  const loadCatalog = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: unknown[] }>("/products");
      const products = (res.data.data ?? []) as {
        name: string;
        variants: { id: number; sku: string | null }[];
      }[];
      setOptions(
        products.flatMap((product) =>
          product.variants
            .filter((v) => v.id !== undefined)
            .map((v) => ({
              id: v.id!,
              label: `${product.name}${v.sku ? ` · ${v.sku}` : ""}`,
            })),
        ),
      );
    } catch {
      setOptions([]);
    }
    try {
      const res = await api.get<{
        data: { id: number; name: string }[];
      }>("/locations");
      const list = res.data.data ?? [];
      setLocations(list);
      if (list.length > 0) {
        setRunLocation(String(list[0]!.id));
      }
    } catch {
      setLocations([]);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const loadBom = useCallback(async (variantId: number) => {
    setLoading(true);
    try {
      const res = await api.get<{ success: boolean; data: BomResponse }>(
        `/variants/${variantId}/bom`,
      );
      setBom(res.data.data);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to load the BOM."), type: "error" });
      setBom(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedVariant !== "") void loadBom(Number(selectedVariant));
    else setBom(null);
  }, [selectedVariant, loadBom]);

  async function saveBom() {
    if (!bom) return;
    setSaving(true);
    try {
      await api.put(`/variants/${bom.parentVariantId}/bom`, {
        components: bom.components.map((c) => ({
          componentVariantId: c.componentVariantId,
          quantity: c.quantity,
          wastePercent: c.wastePercent,
        })),
      });
      toast.add({ title: "BOM saved.", type: "success" });
      await loadBom(bom.parentVariantId);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to save the BOM."), type: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function runProduction() {
    if (!bom || bom.components.length === 0) return;
    setRunning(true);
    try {
      const res = await api.post(`/variants/${bom.parentVariantId}/production-runs`, {
        locationId: Number(runLocation),
        quantity: Number(runQuantity) || 1,
      });
      const cost = (res.data.data as { componentCost: number }).componentCost;
      toast.add({
        title: `Production run completed — component cost ৳${cost.toFixed(2)}`,
        type: "success",
      });
      await loadBom(bom.parentVariantId);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to run production."), type: "error" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="grid gap-5 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold">Production & BOM</h1>
        <p className="text-sm text-muted-foreground">
          Define what goes into a composite product, then run production to
          build finished stock from components.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="prod-variant">Composite variant</Label>
        <select
          id="prod-variant"
          className="max-w-md rounded-md border bg-background p-2 text-sm"
          value={selectedVariant}
          onChange={(e) => setSelectedVariant(e.target.value)}
        >
          <option value="">Pick a variant</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? <Skeleton className="h-48 w-full" /> : null}

      {bom ? (
        <div className="grid gap-4">
          <section className="grid gap-2 rounded-md border p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Components</h2>
              <span className="text-xs text-muted-foreground">
                Estimated cost: ৳{(bom.estimatedUnitCost ?? 0).toFixed(2)} / unit
              </span>
            </div>
            {bom.components.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No components — add what the composite is made of.
              </p>
            ) : (
              bom.components.map((component) => (
                <div key={component.componentVariantId} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {component.componentName}
                    {component.componentSku ? (
                      <span className="ml-1 text-xs text-muted-foreground">
                        {component.componentSku}
                      </span>
                    ) : null}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    step="0.0001"
                    className="h-8 w-24"
                    value={component.quantity}
                    onChange={(e) =>
                      setBom({
                        ...bom,
                        components: bom.components.map((c) =>
                          c.componentVariantId === component.componentVariantId
                            ? { ...c, quantity: Number(e.target.value) || 0 }
                            : c,
                        ),
                      })
                    }
                  />
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    className="h-8 w-20"
                    title="Waste %"
                    value={component.wastePercent}
                    onChange={(e) =>
                      setBom({
                        ...bom,
                        components: bom.components.map((c) =>
                          c.componentVariantId === component.componentVariantId
                            ? { ...c, wastePercent: Number(e.target.value) || 0 }
                            : c,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setBom({
                        ...bom,
                        components: bom.components.filter(
                          (c) => c.componentVariantId !== component.componentVariantId,
                        ),
                      })
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))
            )}
            <div className="flex items-end gap-2">
              <div className="grid gap-1">
                <Label htmlFor="new-component">Add component (variant id)</Label>
                <select
                  id="new-component"
                  className="w-72 rounded-md border bg-background p-2 text-sm"
                  value={newComponent}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    if (
                      !id ||
                      bom.components.some((c) => c.componentVariantId === id)
                    ) {
                      return;
                    }
                    const label = options.find((o) => o.id === id)?.label ?? "";
                    setBom({
                      ...bom,
                      components: [
                        ...bom.components,
                        {
                          componentVariantId: id,
                          componentName: label,
                          componentSku: null,
                          quantity: 1,
                          wastePercent: 0,
                        },
                      ],
                    });
                    setNewComponent("");
                  }}
                >
                  <option value="">Pick a variant</option>
                  {options
                    .filter((o) => o.id !== bom.parentVariantId)
                    .map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                </select>
              </div>
              <Button
                size="sm"
                onClick={() => void saveBom()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save BOM"}
              </Button>
            </div>
          </section>

          <section className="grid gap-2 rounded-md border border-dashed p-4">
            <h2 className="font-medium">Production run</h2>
            <p className="text-xs text-muted-foreground">
              Consumes components at this location and adds finished stock at
              the summed component cost.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1">
                <Label htmlFor="run-qty">Quantity</Label>
                <Input
                  id="run-qty"
                  type="number"
                  min={1}
                  className="w-28"
                  value={runQuantity}
                  onChange={(e) => setRunQuantity(e.target.value)}
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="run-loc">Location</Label>
                <select
                  id="run-loc"
                  className="w-56 rounded-md border bg-background p-2 text-sm"
                  value={runLocation}
                  onChange={(e) => setRunLocation(e.target.value)}
                >
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                onClick={() => void runProduction()}
                disabled={running || bom.components.length === 0 || runLocation === ""}
              >
                {running ? "Running…" : "Run production"}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
