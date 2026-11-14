import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { productImportApi } from "./import.api";

export function ImportHistoryPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["product-import-history"],
    queryFn: () => productImportApi.history(),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <Link to="/purchases-list" className="text-sm font-semibold text-success hover:text-success">
        ← Back
      </Link>
      <h1 className="text-xl font-bold text-foreground">Import history</h1>

      {isLoading ? (
        <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
          <Spinner className="mr-2 size-4" /> Loading…
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Could not load import history.
        </div>
      ) : !data?.length ? (
        <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
          No imports yet.{" "}
          <Link to="/product/import" className="ml-1 font-semibold text-success">
            Start your first import →
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50/80 text-xs uppercase tracking-wide text-muted-foreground/80">
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Mode</th>
                <th className="px-4 py-3 text-right">Rows</th>
                <th className="px-4 py-3 text-right">Created</th>
                <th className="px-4 py-3 text-right">Updated</th>
                <th className="px-4 py-3 text-right">Failed</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.map((session) => (
                <tr key={session.id}>
                  <td className="max-w-52 truncate px-4 py-3 font-medium text-foreground">
                    {session.filename}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        session.status === "completed"
                          ? "bg-success/10 text-success"
                          : session.status === "failed"
                            ? "bg-destructive/10 text-destructive"
                            : "bg-muted text-foreground"
                      }`}
                    >
                      {session.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 capitalize text-foreground">{session.mode}</td>
                  <td className="px-4 py-3 text-right">{session.totals?.totalRows ?? "—"}</td>
                  <td className="px-4 py-3 text-right text-success">
                    {session.totals?.created ?? 0}
                  </td>
                  <td className="px-4 py-3 text-right">{session.totals?.updated ?? 0}</td>
                  <td className="px-4 py-3 text-right text-destructive">
                    {session.totals?.failed ?? 0}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {new Date(session.createdAt).toLocaleString("en-BD", { dateStyle: "medium", timeStyle: "short" })}
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={`/api/products/import/${session.id}/errors`}
                      onClick={(e) => {
                        e.preventDefault();
                        window.open(`/api/products/import/${session.id}/errors`, "_blank");
                      }}
                      className="text-xs font-semibold text-success"
                    >
                      Errors
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
