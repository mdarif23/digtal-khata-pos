import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PermissionButton, PermissionGuard } from "@/components/common/PermissionGuard";
import { formatCurrency } from "@/features/reports/utils/reportUtils.js";
import { getProductSelectOptionsApi } from "@/features/products/product.api.js";
import { useReceiptSettingsStore } from "@/features/pos/stores/useReceiptSettingsStore.js";
import {
  assignBarcodeApi,
  generateBarcodesApi,
  getProductUomApi,
  type BarcodeVariantView,
  type ProductUomConfigRow,
} from "../barcode.api.js";
import { useBarcodeSearch, usePrintHistory } from "../hooks/useBarcodes.js";
import {
  DEFAULT_LABEL_SIZE_ID,
  LABEL_SIZES,
  labelSizeById,
  type LabelConfig,
  type LabelItem,
} from "../labelTemplates.js";
import { BarcodeLabelPreview } from "../components/BarcodeLabelPreview.js";
import { BarcodePrintDialog } from "../components/BarcodePrintDialog.js";

/**
 * The Barcode Generator page (§5): product/variant selection → barcode
 * configuration → label configuration → live preview → print/PDF.
 * Barcode rendering lives in barcodeRenderer/labelRenderer — this page is
 * business logic and layout only.
 */

interface SelectedItem {
  variantId: number;
  productId: number;
  productName: string;
  variantLabel: string | null;
  sku: string;
  barcode: string;
  barcodeFormat: string | null;
  sellingPrice: number;
}

const PAGE_SIZE = 20;

export function BarcodeGeneratorPage() {
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined);
  const [brandId, setBrandId] = useState<number | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sizeId, setSizeId] = useState(DEFAULT_LABEL_SIZE_ID);
  const [copies, setCopies] = useState(1);
  const [configOverrides, setConfigOverrides] = useState<Partial<LabelConfig>>({});
  const [manualBarcode, setManualBarcode] = useState("");
  const [manualTarget, setManualTarget] = useState<"primary" | "alias">("alias");
  const [printOpen, setPrintOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  /**
   * UOM (migration 0062): the packaging unit an ALIAS assignment stands
   * for (a box-of-12 code). Null = a plain base-unit alias.
   */
  const [manualUomConversionId, setManualUomConversionId] = useState<
    number | null
  >(null);
  /**
   * Per-variant packaging label line ("Box of 12") recorded when a package
   * alias is assigned here — labels of those variants print the line under
   * the code. Session-scoped: the search payload does not expose an alias's
   * conversion row, so previously assigned package aliases cannot be
   * re-derived after a reload.
   */
  const [packageUnitByVariant, setPackageUnitByVariant] = useState<
    Map<number, string>
  >(new Map());

  const size = labelSizeById(sizeId);
  const config: LabelConfig = useMemo(
    () => ({ ...size.defaults, ...configOverrides }),
    [size, configOverrides],
  );

  const shopName = useReceiptSettingsStore((state) => state.settings.shopName);
  const logoUrl = useReceiptSettingsStore((state) => state.settings.logoUrl ?? null);
  const optionsQuery = useQuery({
    queryKey: ["product", "select-options"],
    queryFn: getProductSelectOptionsApi,
    staleTime: 60_000,
  });
  const searchQuery = useBarcodeSearch({
    search: search.trim() || undefined,
    categoryId,
    brandId,
    page,
  });
  const historyQuery = usePrintHistory(showHistory);

  const optionData = (optionsQuery.data ?? {}) as {
    categories?: { value: number; label: string }[];
    brands?: { value: number; label: string }[];
  };
  const categories = optionData.categories ?? [];
  const brands = optionData.brands ?? [];

  const rows = searchQuery.data?.rows ?? [];
  const total = searchQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const selectedItem = (view: BarcodeVariantView): SelectedItem | null =>
    view.barcode === null
      ? null
      : {
          variantId: view.variantId,
          productId: view.productId,
          productName: view.productName,
          variantLabel: view.variantLabel,
          sku: view.sku,
          barcode: view.barcode,
          barcodeFormat: view.barcodeFormat,
          sellingPrice: view.sellingPrice,
        };

  const selectedItems: SelectedItem[] = useMemo(() => {
    const all = new Map(rows.map((row) => [row.variantId, row]));
    return Array.from(selectedIds)
      .map((variantId) => {
        const view = all.get(variantId);
        return view ? selectedItem(view) : null;
      })
      .filter((item): item is SelectedItem => item !== null);
  }, [rows, selectedIds]);

  // UOM config of the single selected item's product — feeds the optional
  // "Packaging unit" select of the alias-assign flow.
  const singleSelected = selectedItems.length === 1 ? selectedItems[0]! : null;
  const uomQuery = useQuery({
    queryKey: ["product", "uom", singleSelected?.productId ?? 0],
    queryFn: () => getProductUomApi(singleSelected!.productId),
    enabled: singleSelected !== null,
    staleTime: 60_000,
  });
  const packagingUnitOptions = useMemo(() => {
    if (!singleSelected || !uomQuery.data) return [];
    // Applicable rows: product-level or this variant's own, ACTIVE only.
    return uomQuery.data.units.filter(
      (row: ProductUomConfigRow) =>
        row.status === "active" &&
        (row.variantId === null || row.variantId === singleSelected.variantId),
    );
  }, [singleSelected, uomQuery.data]);
  // A target switch or selection change invalidates the chosen unit.
  useEffect(() => {
    setManualUomConversionId(null);
  }, [singleSelected?.variantId, manualTarget]);
  useEffect(() => {
    setManualUomConversionId((current) =>
      current !== null &&
      !packagingUnitOptions.some((row) => row.id === current)
        ? null
        : current,
    );
  }, [packagingUnitOptions]);

  // Labels need a barcode to render — selected-but-unbarcoded rows are
  // excluded from printing (generate first, then print).
  const printableItems = selectedItems.filter(
    (item): item is SelectedItem & { barcode: string } => item.barcode !== "",
  );

  function toggle(variantId: number, checked: boolean) {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (checked) next.add(variantId);
      else next.delete(variantId);
      return next;
    });
  }

  function selectAllVisible(checked: boolean) {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const row of rows) {
        if (checked) next.add(row.variantId);
        else next.delete(row.variantId);
      }
      return next;
    });
  }

  async function onGenerate(regenerate: boolean) {
    const targetIds = rows
      .filter((row) => selectedIds.has(row.variantId))
      .map((row) => row.variantId);
    if (targetIds.length === 0) {
      toast.add({ title: "Select at least one item first.", type: "error" });
      return;
    }
    if (
      regenerate &&
      !window.confirm(
        "Regenerate replaces the existing barcodes of the selected items (old codes are archived). Continue?",
      )
    ) {
      return;
    }
    try {
      const result = await generateBarcodesApi({ variantIds: targetIds, regenerate });
      toast.add({
        title: `Generated ${result.generated.length} barcode(s).`,
        description: result.generated.every((g) => g.target === "alias")
          ? "Existing barcodes kept — new codes added as aliases."
          : undefined,
        type: "success",
        priority: "high",
      });
      setSelectedIds(new Set());
    } catch (error) {
      toast.add({
        title: error instanceof Error ? error.message : "Generation failed.",
        type: "error",
        priority: "high",
      });
    }
  }

  async function onAssignManual() {
    const code = manualBarcode.trim();
    if (code === "") {
      toast.add({ title: "Enter a barcode first.", type: "error" });
      return;
    }
    if (selectedIds.size !== 1) {
      toast.add({
        title: "Select exactly one item to assign a manual barcode.",
        type: "error",
      });
      return;
    }
    const variantId = Array.from(selectedIds)[0]!;
    try {
      await assignBarcodeSafe(variantId, code, manualTarget, manualUomConversionId);
      setManualBarcode("");
    } catch (error) {
      toast.add({
        title: error instanceof Error ? error.message : "Assignment failed.",
        type: "error",
        priority: "high",
      });
    }
  }

  async function assignBarcodeSafe(
    variantId: number,
    code: string,
    target: "primary" | "alias",
    uomConversionId: number | null,
  ) {
    // The packaging qualifier applies to ALIASES only — primary barcodes
    // always mean one base unit.
    const unit =
      target === "alias" && uomConversionId != null
        ? packagingUnitOptions.find((row) => row.id === uomConversionId)
        : undefined;
    await assignBarcodeApi({
      variantId,
      barcode: code,
      target,
      ...(target === "alias" && uomConversionId != null
        ? { uomConversionId }
        : {}),
    });
    if (unit) {
      // Record the package line for this variant's labels ("Box of 12").
      setPackageUnitByVariant((previous) => {
        const next = new Map(previous);
        next.set(
          variantId,
          `${unit.unitName} of ${unit.conversionFactor}`,
        );
        return next;
      });
    }
    toast.add({ title: "Barcode assigned.", type: "success" });
    void searchQuery.refetch();
  }

  const labelItems: LabelItem[] = printableItems.map((item) => ({
    variantId: item.variantId,
    productId: item.productId,
    productName: item.productName,
    variantLabel: item.variantLabel,
    sku: item.sku,
    barcode: item.barcode,
    barcodeFormat: item.barcodeFormat,
    sellingPrice: item.sellingPrice,
    packageUnitLine: packageUnitByVariant.get(item.variantId) ?? null,
  }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Barcode Generator</h2>
          <p className="text-sm text-slate-500">
            Generate internal CODE128 barcodes, assign manufacturer codes, and
            print scanner-ready labels.
          </p>
        </div>
        <Button variant="ghost" onClick={() => setShowHistory((open) => !open)}>
          {showHistory ? "Hide print history" : "Print history"}
        </Button>
      </div>

      {showHistory ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          {(historyQuery.data?.length ?? 0) === 0 ? (
            <div className="p-4 text-sm text-slate-400">No print jobs recorded yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2 text-right">Items</th>
                  <th className="px-3 py-2 text-right">Copies</th>
                  <th className="px-3 py-2">Template</th>
                </tr>
              </thead>
              <tbody>
                {(historyQuery.data ?? []).map((entry) => (
                  <tr key={entry.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{entry.createdAt?.slice(0, 19).replace("T", " ")}</td>
                    <td className="px-3 py-2 text-right">{entry.variantCount}</td>
                    <td className="px-3 py-2 text-right">{entry.copies}</td>
                    <td className="px-3 py-2">{entry.template ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        {/* ---- Selection ---- */}
        <div className="space-y-3 rounded-xl border border-slate-200 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search by product, SKU, or barcode…"
              className="min-w-48 flex-1"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
            <Select
              items={[
                { value: "all", label: "All categories" },
                ...categories.map((category) => ({
                  value: String(category.value),
                  label: category.label,
                })),
              ]}
              value={categoryId ? String(categoryId) : "all"}
              onValueChange={(value) => {
                setCategoryId(value === "all" ? undefined : Number(value));
                setPage(1);
              }}
            >
              <SelectTrigger className="w-40"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.value} value={String(category.value)}>
                    {category.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              items={[
                { value: "all", label: "All brands" },
                ...brands.map((brand) => ({
                  value: String(brand.value),
                  label: brand.label,
                })),
              ]}
              value={brandId ? String(brandId) : "all"}
              onValueChange={(value) => {
                setBrandId(value === "all" ? undefined : Number(value));
                setPage(1);
              }}
            >
              <SelectTrigger className="w-40"><SelectValue placeholder="Brand" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All brands</SelectItem>
                {brands.map((brand) => (
                  <SelectItem key={brand.value} value={String(brand.value)}>
                    {brand.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {searchQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-slate-400">
              <Spinner className="size-4" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
              No products match — adjust the search or filters.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">
                      <Checkbox
                        aria-label="Select all visible items"
                        checked={
                          rows.length > 0 &&
                          rows.every((row) => selectedIds.has(row.variantId))
                        }
                        onCheckedChange={(checked) => selectAllVisible(checked === true)}
                      />
                    </th>
                    <th className="px-3 py-2">Product / variant</th>
                    <th className="px-3 py-2">Barcode</th>
                    <th className="px-3 py-2 text-right">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.variantId} className="border-t border-slate-100">
                      <td className="px-3 py-2">
                        <Checkbox
                          aria-label={`Select ${row.productName}`}
                          checked={selectedIds.has(row.variantId)}
                          onCheckedChange={(checked) => toggle(row.variantId, checked === true)}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{row.productName}</div>
                        <div className="text-xs text-slate-500">
                          {row.variantLabel ?? "Default variant"} · {row.sku}
                          {row.aliases.length > 0 ? ` · +${row.aliases.length} alias(es)` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {row.barcode ?? <span className="text-slate-400">none yet</span>}
                      </td>
                      <td className="px-3 py-2 text-right">{formatCurrency(row.sellingPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">
              {total} item(s) — page {page} of {totalPages}
            </span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                Prev
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>

        {/* ---- Configuration + preview ---- */}
        <div className="space-y-3">
          <div className="space-y-3 rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between">
              <Label className="font-semibold">Generate internal barcodes</Label>
              <Badge variant="secondary">CODE128 · EZ…</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <PermissionButton
                permission="products.edit"
                size="sm"
                variant="outline"
                onClick={() => void onGenerate(false)}
              >
                Generate for selected
              </PermissionButton>
              <PermissionGuard permission="products.edit" fallback={null}>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-rose-600"
                  onClick={() => void onGenerate(true)}
                >
                  Regenerate (replace)…
                </Button>
              </PermissionGuard>
            </div>
            <div className="border-t border-slate-100 pt-3">
              <Label className="mb-1.5 block">Assign a manual / manufacturer code</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="e.g. 4006381333931"
                  value={manualBarcode}
                  onChange={(event) => setManualBarcode(event.target.value)}
                />
                <Select
                  items={[
                    { value: "alias", label: "As alias" },
                    { value: "primary", label: "As primary" },
                  ]}
                  value={manualTarget}
                  onValueChange={(value) =>
                    setManualTarget(value === "alias" ? "alias" : "primary")
                  }
                >
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="alias">As alias</SelectItem>
                    <SelectItem value="primary">As primary</SelectItem>
                  </SelectContent>
                </Select>
                <PermissionButton
                  permission="products.edit"
                  size="sm"
                  variant="outline"
                  disabled={manualBarcode.trim() === "" || selectedIds.size !== 1}
                  onClick={() => void onAssignManual()}
                >
                  Assign
                </PermissionButton>
              </div>
              {manualTarget === "alias" && packagingUnitOptions.length > 0 && (
                <div className="mt-2">
                  <Label className="text-xs">Packaging unit (optional)</Label>
                  <Select
                    items={[
                      { value: "none", label: "None — one piece (base unit)" },
                      ...packagingUnitOptions.map((row) => ({
                        value: String(row.id),
                        label: `${row.unitName} (1 ${row.unitName} = ${row.conversionFactor} ${uomQuery.data?.baseUnit?.name ?? "base"})`,
                      })),
                    ]}
                    value={
                      manualUomConversionId === null
                        ? "none"
                        : String(manualUomConversionId)
                    }
                    onValueChange={(value) =>
                      setManualUomConversionId(
                        value === "none" ? null : Number(value),
                      )
                    }
                  >
                    <SelectTrigger className="mt-1 w-full">
                      <SelectValue placeholder="Packaging unit" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">
                        None — one piece (base unit)
                      </SelectItem>
                      {packagingUnitOptions.map((row) => (
                        <SelectItem key={row.id} value={String(row.id)}>
                          {row.unitName} (1 {row.unitName} ={" "}
                          {row.conversionFactor}{" "}
                          {uomQuery.data?.baseUnit?.name ?? "base"})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-slate-500">
                    A package barcode means ONE of the chosen unit — scanning
                    it counts a whole package (e.g. 12 pieces).
                  </p>
                </div>
              )}
              <p className="mt-1 text-xs text-slate-500">
                Retail codes are validated (GS1 check digit); duplicates are
                refused. Select exactly one item.
              </p>
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-slate-200 p-4">
            <Label className="font-semibold">Label configuration</Label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Label size</Label>
                <Select
                  items={LABEL_SIZES.map((labelSize) => ({
                    value: labelSize.id,
                    label: labelSize.label,
                  }))}
                  value={sizeId}
                  onValueChange={(value) => { if (value) { setSizeId(value); setConfigOverrides({}); } }}
                >
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LABEL_SIZES.map((labelSize) => (
                      <SelectItem key={labelSize.id} value={labelSize.id}>
                        {labelSize.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Copies per item</Label>
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  value={copies}
                  onChange={(event) => {
                  const parsed = Number(event.target.value);
                  setCopies(Number.isFinite(parsed) ? Math.max(1, parsed) : 1);
                }}
                />
              </div>
              <div>
                <Label className="text-xs">Barcode height (mm)</Label>
                <Input
                  type="number"
                  min={6}
                  max={30}
                  step={0.5}
                  value={config.barcodeHeightMm}
                  onChange={(event) =>
                    setConfigOverrides((previous) => ({
                      ...previous,
                      barcodeHeightMm: Math.max(6, Number(event.target.value) || 8),
                    }))
                  }
                />
              </div>
              <div>
                <Label className="text-xs">Quiet zone (mm)</Label>
                <Input
                  type="number"
                  min={1.5}
                  max={8}
                  step={0.5}
                  value={config.quietZoneMm}
                  onChange={(event) =>
                    setConfigOverrides((previous) => ({
                      ...previous,
                      quietZoneMm: Math.max(1.5, Number(event.target.value) || 3),
                    }))
                  }
                />
              </div>
              <div>
                <Label className="text-xs">Name font (pt)</Label>
                <Input
                  type="number"
                  min={5}
                  max={16}
                  value={config.nameFontSizePt}
                  onChange={(event) =>
                    setConfigOverrides((previous) => ({
                      ...previous,
                      nameFontSizePt: Math.max(5, Number(event.target.value) || 7),
                    }))
                  }
                />
              </div>
              <div>
                <Label className="text-xs">Price font (pt)</Label>
                <Input
                  type="number"
                  min={6}
                  max={24}
                  value={config.priceFontSizePt}
                  onChange={(event) =>
                    setConfigOverrides((previous) => ({
                      ...previous,
                      priceFontSizePt: Math.max(6, Number(event.target.value) || 12),
                    }))
                  }
                />
              </div>
              {size.kind === "a4" ? (
                <>
                  <div>
                    <Label className="text-xs">Labels per row</Label>
                    <Input
                      type="number"
                      min={1}
                      max={6}
                      value={config.labelsPerRow ?? 3}
                      onChange={(event) =>
                        setConfigOverrides((previous) => ({
                          ...previous,
                          labelsPerRow: Math.max(1, Number(event.target.value) || 3),
                        }))
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">H-spacing (mm)</Label>
                    <Input
                      type="number"
                      min={0}
                      max={20}
                      step={0.5}
                      value={config.horizontalSpacingMm ?? 2.5}
                      onChange={(event) =>
                        setConfigOverrides((previous) => ({
                          ...previous,
                          horizontalSpacingMm: Math.max(0, Number(event.target.value) || 2.5),
                        }))
                      }
                    />
                  </div>
                </>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pt-1">
              {(
                [
                  ["includeProductName", "Product name"],
                  ["includeVariantName", "Variant name"],
                  ["includeSku", "SKU"],
                  ["includePrice", "Price"],
                  ["includeShopName", "Shop name"],
                  ["includeLogo", "Logo"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={config[key]}
                    onCheckedChange={(checked) =>
                      setConfigOverrides((previous) => ({
                        ...previous,
                        [key]: checked === true,
                      }))
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <BarcodeLabelPreview
            items={labelItems}
            size={size}
            config={config}
            copiesPerItem={copies}
            shopName={shopName}
            logoDataUrl={logoUrl}
          />

          <div className="flex items-center justify-between rounded-xl border border-slate-200 p-3">
            <span className="text-sm text-slate-600">
              <strong>{selectedItems.length}</strong> selected ·{" "}
              {labelItems.length * copies} label(s)
              {selectedItems.length > labelItems.length ? (
                <span className="text-amber-600">
                  {" "}· {selectedItems.length - labelItems.length} without barcode (generate first)
                </span>
              ) : null}
            </span>
            <PermissionButton
              permission="products.print_labels"
              disabled={printableItems.length === 0}
              onClick={() => setPrintOpen(true)}
            >
              Print / PDF…
            </PermissionButton>
          </div>
        </div>
      </div>

      <BarcodePrintDialog
        open={printOpen}
        onOpenChange={setPrintOpen}
        items={labelItems}
        size={size}
        config={config}
        copiesPerItem={copies}
        shopName={shopName}
        logoDataUrl={logoUrl}
      />
    </div>
  );
}
