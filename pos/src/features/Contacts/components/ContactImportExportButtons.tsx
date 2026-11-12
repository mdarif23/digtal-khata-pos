import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import api from "@/api/axios.js";

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

interface ImportSessionResponse {
  sessionId: number;
  totalRows: number;
  errorCount: number;
  duplicateOf: number | null;
}

interface SessionDetail {
  session: { id: number; status: string; totals: Record<string, number> | null };
  rows: { rowNumber: number; status: string; errors: { code: string; message: string }[] | null }[];
}

/**
 * Import/Export buttons for the contact lists (Phase 1 F11): template →
 * upload → validate → execute (background) → results, plus the first-class
 * guarded CSV export. One component, entity-parameterized.
 */
export function ContactImportExportButtons(props: { entity: "customers" | "suppliers" }) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<ImportSessionResponse | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const entityLabel = props.entity === "customers" ? "customers" : "suppliers";

  function reset() {
    setSessionInfo(null);
    setSessionDetail(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const bytes = await file.arrayBuffer();
      const res = await api.post<{ success: boolean; data: ImportSessionResponse }>(
        `/import/${props.entity}/upload?filename=${encodeURIComponent(file.name)}`,
        bytes,
        { headers: { "Content-Type": "text/csv" } },
      );
      setSessionInfo(res.data.data);
      const detail = await api.get<{ data: SessionDetail }>(
        `/import/sessions/${res.data.data.sessionId}`,
      );
      setSessionDetail(detail.data.data);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to process the file."), type: "error" });
    } finally {
      setUploading(false);
    }
  }

  async function handleExecute() {
    if (!sessionInfo) return;
    setExecuting(true);
    try {
      await api.post(`/import/sessions/${sessionInfo.sessionId}/execute`);
      // Poll until completed (execution runs in the background).
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const detail = await api.get<{ data: SessionDetail }>(
          `/import/sessions/${sessionInfo.sessionId}`,
        );
        setSessionDetail(detail.data.data);
        if (detail.data.data.session.status === "completed") {
          const totals = detail.data.data.session.totals ?? {};
          toast.add({
            title: `Import finished — ${totals.created ?? 0} created, ${totals.updated ?? 0} updated, ${totals.failed ?? 0} failed`,
            type: (totals.failed ?? 0) > 0 ? "error" : "success",
          });
          break;
        }
      }
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to run the import."), type: "error" });
    } finally {
      setExecuting(false);
    }
  }

  async function handleExport() {
    try {
      const res = await api.get(`/export/${props.entity}`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${entityLabel}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to export."), type: "error" });
    }
  }

  function downloadTemplate(format: "csv" | "xlsx") {
    window.open(
      `/api/import/${props.entity}/template?format=${format}`,
      "_blank",
    );
  }

  function downloadErrorReport() {
    if (!sessionInfo) return;
    window.open(`/api/import/sessions/${sessionInfo.sessionId}/errors`, "_blank");
  }

  const totals = sessionDetail?.session.totals ?? null;
  const errorRows =
    sessionDetail?.rows.filter(
      (r) => r.status === "error" || r.status === "failed",
    ) ?? [];

  return (
    <>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleExport()}>
          <Download className="size-4" /> Export
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            reset();
            setWizardOpen(true);
          }}
        >
          <Upload className="size-4" /> Import
        </Button>
      </div>

      <Dialog open={wizardOpen} onOpenChange={setWizardOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import {entityLabel}</DialogTitle>
            <DialogDescription>
              Download the template, fill it in, upload, review row errors,
              then run the import. Rows with a matching phone/email are
              updated — nothing is deleted.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => downloadTemplate("csv")}>
                Template (CSV)
              </Button>
              <Button variant="outline" size="sm" onClick={() => downloadTemplate("xlsx")}>
                Template (XLSX)
              </Button>
            </div>

            <div className="grid gap-1.5">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.xlsx"
                className="text-sm"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleUpload(file);
                }}
              />
              {uploading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="size-4" /> Validating…
                </div>
              ) : null}
            </div>

            {sessionInfo && sessionDetail ? (
              <div className="grid gap-2 rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span>
                    {sessionInfo.totalRows} rows ·{" "}
                    <span className="text-muted-foreground">
                      {sessionInfo.errorCount} with errors
                    </span>
                    {sessionInfo.duplicateOf ? (
                      <Badge variant="secondary" className="ml-2">
                        same file as #{sessionInfo.duplicateOf}
                      </Badge>
                    ) : null}
                  </span>
                  <Badge
                    variant={sessionDetail.session.status === "completed" ? "default" : "secondary"}
                  >
                    {sessionDetail.session.status}
                  </Badge>
                </div>

                {errorRows.length > 0 ? (
                  <div className="max-h-40 overflow-y-auto rounded-md border">
                    <table className="w-full text-xs">
                      <tbody>
                        {errorRows.slice(0, 20).map((row) => (
                          <tr key={row.rowNumber} className="border-t">
                            <td className="p-1.5 font-mono">row {row.rowNumber}</td>
                            <td className="p-1.5 text-destructive">
                              {row.errors?.map((e) => e.message).join("; ")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                {sessionDetail.session.status === "completed" && totals ? (
                  <p className="text-muted-foreground">
                    {totals.created ?? 0} created · {totals.updated ?? 0} updated ·{" "}
                    {totals.failed ?? 0} failed
                  </p>
                ) : null}

                {sessionInfo.errorCount > 0 ? (
                  <Button variant="link" size="sm" className="justify-start p-0" onClick={downloadErrorReport}>
                    Download error report (CSV)
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            {sessionInfo && sessionDetail?.session.status !== "completed" ? (
              <Button
                onClick={() => void handleExecute()}
                disabled={executing || sessionInfo.totalRows === sessionInfo.errorCount}
              >
                {executing ? (
                  <>
                    <Spinner className="size-4" /> Importing…
                  </>
                ) : (
                  `Import ${sessionInfo.totalRows - sessionInfo.errorCount} valid rows`
                )}
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setWizardOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
