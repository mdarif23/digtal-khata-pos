import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, Download, FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import {
  productImportApi,
  type ImportSessionDetail,
  type ImportTotals,
} from "./import.api";

/**
 * Product import wizard (Phase F): upload → mapping → validate/preview →
 * configure → confirm → results, in one guided flow with step anchors.
 */

const FIELD_LABELS: Record<string, string> = {
  product_name: "Product name *",
  product_type: "Product type",
  category: "Category",
  brand: "Brand",
  unit: "Unit *",
  package_unit: "Package unit (e.g. Box)",
  package_factor: "Units per package",
  package_sale_price: "Package sale price",
  package_barcode: "Package barcode",
  description: "Description",
  sku: "SKU",
  has_variants: "Has variants",
  variant_options: "Variant options (Size: Small | …)",
  barcode: "Barcode",
  selling_price: "Selling price *",
  purchase_price: "Purchase cost",
  alert_quantity: "Alert quantity",
  tracking_type: "Tracking type",
  opening_stock: "Opening stock",
  location: "Location",
  batch_number: "Batch number",
  expiry_date: "Expiry date",
  serial_numbers: "Serial numbers (;-separated)",
  image_url: "Image URL (https)",
  status: "Status",
};

const UPDATE_FIELDS = [
  "product_name", "product_type", "category", "brand", "unit", "description",
  "sku", "barcode", "selling_price", "alert_quantity", "status",
  "package_unit", "package_factor", "package_sale_price", "package_barcode",
];

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-slate-200 px-4 text-center text-sm text-slate-500">
      {children}
    </div>
  );
}

export function ImportWizardPage() {
  const [step, setStep] = useState(1);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [headers, setHeaders] = useState<string[]>([]);
  const [fileMeta, setFileMeta] = useState<{ name: string; size: number } | null>(null);
  const [worksheet, setWorksheet] = useState<string | undefined>(undefined);
  const [worksheets, setWorksheets] = useState<string[]>([]);
  const [headerRow, setHeaderRow] = useState(1);
  const [mode, setMode] = useState<"create" | "update" | "upsert" | "skip">("create");
  const [createMissing, setCreateMissing] = useState(true);
  const [totals, setTotals] = useState<ImportTotals | null>(null);
  const [detail, setDetail] = useState<ImportSessionDetail | null>(null);
  const [filter, setFilter] = useState<"all" | "valid" | "error">("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mappedFields = useMemo(() => new Set(Object.values(mapping)), [mapping]);
  const missingRequired = ["product_name", "selling_price", "unit"].filter(
    (field) => !mappedFields.has(field),
  );

  const handleFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const result = await productImportApi.upload(file, worksheet, headerRow);
      setSessionId(result.sessionId);
      setMapping(result.mapping);
      setHeaders(result.sheet.headers);
      setWorksheets(result.sheet.availableWorksheets);
      setFileMeta({ name: file.name, size: file.size });
      if (result.duplicateOf) {
        toast.add({
          title: "This file was imported before",
          description: `Matches a previous import (session #${result.duplicateOf}). Review before continuing.`,
          type: "warning",
        });
      }
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const saveAndValidate = async (nextMode = mode) => {
    if (sessionId === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createEntityPromiseToast({
        data: sessionId,
        apiCall: async () => {
          await productImportApi.patch(sessionId, {
            mapping,
            mode: nextMode,
            options: { createMissingMasterData: createMissing },
          });
          return productImportApi.validate(sessionId);
        },
        entityName: "Validation",
      });
      setTotals(result);
      const detailData = await productImportApi.get(sessionId);
      setDetail(detailData);
      setStep(5);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (sessionId === null) return;
    setBusy(true);
    try {
      const result = await createEntityPromiseToast({
        data: sessionId,
        apiCall: () => productImportApi.execute(sessionId),
        entityName: "Product import",
      });
      setTotals(result);
      setStep(8);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const card = "rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm shadow-slate-950/[0.02]";
  const stepLabel = (n: number, label: string, active: boolean, done: boolean) => (
    <span
      className={`flex items-center gap-2 text-sm ${active ? "font-semibold text-slate-900" : done ? "text-emerald-700" : "text-slate-400"}`}
    >
      <span
        className={`flex size-6 items-center justify-center rounded-full text-xs ${
          active ? "bg-emerald-600 text-white" : done ? "bg-emerald-50 text-emerald-700" : "bg-slate-100"
        }`}
      >
        {done ? "✓" : n}
      </span>
      {label}
    </span>
  );

  const rows = detail?.rows ?? [];
  const filteredRows = rows.filter((row) =>
    filter === "all" ? true : filter === "error" ? row.status === "error" : row.status === "valid",
  );

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <Link to="/purchases-list" className="text-sm font-semibold text-emerald-700 hover:text-emerald-900">
          ← Back
        </Link>
        <a
          href="/api/products/import/template?format=xlsx"
          className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-700 hover:text-emerald-900"
          onClick={(e) => {
            e.preventDefault();
            window.open(`/api/products/import/template?format=xlsx`, "_blank");
          }}
        >
          <Download className="size-4" /> Template (.xlsx)
        </a>
      </div>

      <div className="flex flex-wrap gap-4">
        {stepLabel(1, "Upload", step === 1, step > 1)}
        {stepLabel(2, "Mapping", step === 2, step > 2)}
        {stepLabel(3, "Validate", step === 3, step > 3)}
        {stepLabel(4, "Configure", step === 4, step > 4)}
        {stepLabel(5, "Results", step === 5, false)}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>
      )}

      {step === 1 && (
        <div className={card}>
          <Label className="text-sm font-semibold">Upload CSV or XLSX</Label>
          <label
            className="mt-3 flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 p-4 text-sm text-slate-500 hover:border-emerald-500 hover:bg-emerald-50/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) void handleFile(file);
            }}
          >
            {busy ? (
              <Spinner className="size-5" />
            ) : (
              <>
                <FileSpreadsheet className="mb-2 size-6 text-slate-400" />
                Drag & drop or click to choose (.csv / .xlsx, max 15 MB)
              </>
            )}
            <input
              type="file"
              accept=".csv,.xlsx"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
          </label>
        </div>
      )}

      {step >= 2 && fileMeta && (
        <div className={card}>
          <p className="text-sm font-semibold text-slate-700">
            {fileMeta.name}{" "}
            <span className="font-normal text-slate-400">
              ({(fileMeta.size / 1024).toFixed(0)} KB)
            </span>
          </p>
          {worksheets.length > 1 && (
            <div className="mt-2">
              <Label className="text-xs text-slate-500">Worksheet</Label>
              <select
                className="mt-1 rounded-md border border-slate-200 px-2 py-1 text-sm"
                value={worksheet ?? ""}
                onChange={(e) => setWorksheet(e.target.value)}
              >
                {worksheets.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <Label className="mt-4 block text-sm font-semibold text-slate-700">
            Column mapping
          </Label>
          <p className="mt-1 text-xs text-slate-400">
            ezPos matched your columns automatically — adjust anything wrong.
            Unmapped columns are ignored (nothing is silently discarded without
            a mapping decision).
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {headers.map((header) => (
              <div key={header} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-slate-600" title={header}>
                  {header}
                </span>
                <span className="text-slate-300">→</span>
                <select
                  className="w-44 rounded-md border border-slate-200 px-2 py-1 text-sm"
                  value={mapping[header] ?? ""}
                  onChange={(e) =>
                    setMapping((current) => ({
                      ...current,
                      [header]: e.target.value,
                    }))
                  }
                >
                  <option value="">— ignore —</option>
                  {Object.entries(FIELD_LABELS).map(([field, label]) => (
                    <option key={field} value={field}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          {missingRequired.length > 0 && (
            <p className="mt-3 text-sm text-amber-700">
              Required fields not mapped: {missingRequired.map((f) => FIELD_LABELS[f]).join(", ")}
            </p>
          )}
          <div className="mt-4 flex justify-end">
            <Button
              disabled={busy || missingRequired.length > 0}
              nativeButton={false}
              render={
                <button onClick={() => void saveAndValidate()} disabled={busy || missingRequired.length > 0} />
              }
            >
              {busy ? "Validating…" : "Save mapping & validate"}
            </Button>
          </div>
        </div>
      )}

      {step >= 5 && totals && (
        <div className={card}>
          <Label className="text-sm font-semibold text-slate-700">Validation results</Label>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Total rows", totals.totalRows],
              ["Valid", totals.validRows],
              ["Errors", totals.errorRows],
              ["Products", totals.products],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl bg-slate-50 p-3 text-center">
                <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
                <p className="text-lg font-semibold text-slate-900">{value}</p>
              </div>
            ))}
          </div>

          <Label className="mt-4 block text-sm font-semibold text-slate-700">Import mode</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["create", "update", "upsert", "skip"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                className={`rounded-full border px-3 py-1 text-sm capitalize ${
                  mode === option
                    ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 text-slate-600"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm text-slate-600">
            <Checkbox
              checked={createMissing}
              onCheckedChange={(checked) => setCreateMissing(checked === true)}
            />
            Create missing categories / brands / units (else map to existing or skip)
          </label>
          {mode !== "create" && (
            <p className="mt-1 text-xs text-slate-400">
              Update modes match rows by SKU (barcode as fallback). Only mapped fields with
              values are overwritten.
            </p>
          )}

          {rows.length > 0 && (
            <>
              <div className="mt-4 flex items-center justify-between">
                <Label className="text-sm font-semibold text-slate-700">Row preview</Label>
                <div className="flex gap-1 text-xs">
                  {(["all", "valid", "error"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFilter(f)}
                      className={`rounded-full px-2.5 py-1 capitalize ${
                        filter === f ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-slate-100">
                <table className="w-full text-left text-sm">
                  <tbody className="divide-y divide-slate-50">
                    {filteredRows.map((row) => (
                      <tr key={row.id}>
                        <td className="w-14 px-3 py-2 text-xs text-slate-400">#{row.rowNumber}</td>
                        <td className="px-3 py-2">{row.productRef}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              row.status === "error" || row.status === "failed"
                                ? "bg-rose-50 text-rose-700"
                                : row.status === "valid"
                                  ? "bg-emerald-50 text-emerald-700"
                                  : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {row.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-rose-600">
                          {row.errors?.map((e) => e.message).join("; ")}
                          {row.payload?.issues
                            ?.filter((i) => i.code === "similar_name_warning")
                            .map((i) => i.message)
                            .join("; ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {sessionId !== null && (
                <a
                  href={`/api/products/import/${sessionId}/errors`}
                  className="mt-2 inline-block text-xs font-semibold text-emerald-700"
                  onClick={(e) => {
                    e.preventDefault();
                    window.open(`/api/products/import/${sessionId}/errors`, "_blank");
                  }}
                >
                  Download error report
                </a>
              )}
            </>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" nativeButton={false} render={<button onClick={() => void saveAndValidate(mode)} disabled={busy} />}>
              Re-validate
            </Button>
            {sessionId !== null && (
              <Button
                disabled={busy || (totals.errorRows ?? 0) > 0}
                nativeButton={false}
                render={
                  <button
                    onClick={() => {
                      if (window.confirm(`Import ${totals.validRows} rows now? This creates/updates real products.`)) {
                        void execute();
                      }
                    }}
                    disabled={busy || (totals.errorRows ?? 0) > 0}
                  />
                }
              >
                Import now
              </Button>
            )}
          </div>
        </div>
      )}

      {step === 8 && totals && (
        <div className={card}>
          <Label className="text-sm font-semibold text-emerald-700">Import complete</Label>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Created", totals.created ?? 0],
              ["Updated", totals.updated ?? 0],
              ["Skipped", totals.skipped ?? 0],
              ["Failed", totals.failed ?? 0],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl bg-slate-50 p-3 text-center">
                <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
                <p className="text-lg font-semibold text-slate-900">{value}</p>
              </div>
            ))}
          </div>
          {totals.processingMs != null && (
            <p className="mt-2 text-xs text-slate-400">
              Finished in {(totals.processingMs / 1000).toFixed(1)}s
            </p>
          )}
          <div className="mt-4 flex gap-3">
            <Link to="/product/import-history" className="text-sm font-semibold text-emerald-700">
              View import history →
            </Link>
            <button
              type="button"
              className="text-sm font-semibold text-emerald-700"
              onClick={() => {
                setStep(1);
                setSessionId(null);
                setTotals(null);
                setDetail(null);
              }}
            >
              Import another file
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
