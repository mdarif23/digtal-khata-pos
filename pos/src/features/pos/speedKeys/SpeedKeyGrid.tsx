import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import useProductStore from "@/features/products/useProductStore";
import { useCartStore } from "@/features/pos/stores/useCartStore";
import { resolveDefaultSaleUnit } from "@/features/pos/hooks/useSellUnits";
import {
  getSpeedKeysApi,
  saveSpeedKeysApi,
  TILE_COLOR_CLASS,
  TILE_COLORS,
  type SpeedKeyTile,
} from "./speedKeys.api";

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

/**
 * Speed keys / visual product grid (Phase 3 — master prompt Feature 2).
 * Tiles reference real variants from the product store — clicking adds the
 * same default sale unit the product grid does. Per-user layout, edited
 * inline (label, color, order, remove).
 */
export function SpeedKeyGrid() {
  const [tiles, setTiles] = useState<SpeedKeyTile[] | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<SpeedKeyTile[]>([]);
  const [saving, setSaving] = useState(false);
  const products = useProductStore((state) => state.products);
  // Variant picker options built from the loaded catalog (variantId →
  // "Product · SKU") — no dependency on the add-product option groups.
  const variantPickerOptions = useMemo(
    () =>
      products.flatMap((product) =>
        product.variants
          .filter((v) => v.id !== undefined)
          .map((v) => ({
            value: String(v.id),
            label: `${product.name}${v.sku ? ` · ${v.sku}` : ""}`,
          })),
      ),
    [products],
  );
  const addToCart = useCartStore((state) => state.addToCart);

  const load = useCallback(async () => {
    try {
      setTiles(await getSpeedKeysApi());
    } catch {
      setTiles([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleTileClick = useCallback(
    async (tile: SpeedKeyTile) => {
      const product = products.find((p) =>
        p.variants.some((v) => v.id === tile.variantId),
      );
      if (!product) {
        toast.add({
          title: "Product not in the loaded catalog — search for it instead.",
          type: "error",
        });
        return;
      }
      const variant = product.variants.find((v) => v.id === tile.variantId);
      if (!variant || variant.id === undefined) {
        addToCart(product);
        return;
      }
      try {
        const unit = await resolveDefaultSaleUnit(variant.id);
        addToCart(product, unit ?? undefined);
      } catch {
        addToCart(product);
      }
    },
    [products, addToCart],
  );

  const sortedTiles = useMemo(
    () => (tiles ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [tiles],
  );

  function openEditor() {
    setDraft([...(tiles ?? [])].sort((a, b) => a.sortOrder - b.sortOrder));
    setEditorOpen(true);
  }

  async function saveEditor() {
    setSaving(true);
    try {
      const normalized = draft.map((tile, idx) => ({ ...tile, sortOrder: idx }));
      await saveSpeedKeysApi(normalized);
      setTiles(normalized);
      setEditorOpen(false);
      toast.add({ title: "Speed keys saved.", type: "success" });
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to save the layout."), type: "error" });
    } finally {
      setSaving(false);
    }
  }

  const selectedIds = new Set(draft.map((t) => t.variantId));

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Speed keys</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs"
          onClick={openEditor}
        >
          <Pencil className="size-3" /> Edit
        </Button>
      </div>
      {sortedTiles.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No speed keys yet — add your best sellers.
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 lg:grid-cols-8">
          {sortedTiles.map((tile) => (
            <button
              key={`${tile.variantId}-${tile.sortOrder}`}
              type="button"
              onClick={() => void handleTileClick(tile)}
              className={`truncate rounded-md border px-1.5 py-2 text-xs font-medium transition-colors ${TILE_COLOR_CLASS[tile.color] ?? TILE_COLOR_CLASS.slate}`}
              title={tile.label}
            >
              {tile.label}
            </button>
          ))}
        </div>
      )}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit speed keys</DialogTitle>
            <DialogDescription>
              Tiles reference your products — reordering here changes the grid
              for YOUR login only.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {draft.map((tile, idx) => (
              <div key={`${tile.variantId}-${idx}`} className="flex items-center gap-1.5">
                <Input
                  className="h-8 flex-1"
                  value={tile.label}
                  onChange={(e) =>
                    setDraft(
                      draft.map((t, i) =>
                        i === idx ? { ...t, label: e.target.value } : t,
                      ),
                    )
                  }
                />
                <select
                  className="h-8 rounded-md border bg-background text-xs"
                  value={tile.color}
                  onChange={(e) =>
                    setDraft(
                      draft.map((t, i) =>
                        i === idx ? { ...t, color: e.target.value } : t,
                      ),
                    )
                  }
                >
                  {TILE_COLORS.map((color) => (
                    <option key={color} value={color}>
                      {color}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={idx === 0}
                  onClick={() => {
                    const next = [...draft];
                    [next[idx - 1], next[idx]] = [next[idx]!, next[idx - 1]!];
                    setDraft(next);
                  }}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={idx === draft.length - 1}
                  onClick={() => {
                    const next = [...draft];
                    [next[idx + 1], next[idx]] = [next[idx]!, next[idx + 1]!];
                    setDraft(next);
                  }}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraft(draft.filter((_, i) => i !== idx))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}

            <div className="mt-1 grid gap-1.5 rounded-md border border-dashed p-2">
              <Label className="text-xs">Add a variant</Label>
              <Select
                onValueChange={(value) => {
                  const variantId = Number(value);
                  if (!Number.isInteger(variantId) || selectedIds.has(variantId)) return;
                  const product = products.find((p) =>
                    p.variants.some((v) => v.id === variantId),
                  );
                  setDraft([
                    ...draft,
                    {
                      variantId,
                      label: product?.name ?? `Variant ${variantId}`,
                      color: TILE_COLORS[draft.length % TILE_COLORS.length]!,
                      sortOrder: draft.length,
                    },
                  ]);
                }}
                items={variantPickerOptions}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick a product / variant" />
                </SelectTrigger>
                <SelectContent>
                  {variantPickerOptions.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={selectedIds.has(Number(option.value))}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {draft.length === 0 ? (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Plus className="size-3" /> Pick products above to add tiles.
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => void saveEditor()} disabled={saving}>
              {saving ? "Saving…" : "Save layout"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
