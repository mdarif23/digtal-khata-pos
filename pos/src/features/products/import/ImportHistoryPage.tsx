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
      <Link to="/purchases-list" className="text-sm font-semibold text-emerald-700 hover:text-emerald-900">
        ← Back
      </Link>
      <h1 className="text-xl font-bold text-slate-900">Import history</h1>

      {isLoading ? (
        <div className="flex min-h-40 items-center justify-center text-sm text-slate-500">
          <Spinner className="mr-2 size-4" /> Loading…
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          Could not load import history.
        </div>
      ) : !data?.length ? (
        <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-slate-200 text-sm text-slate-500">
          No imports yet.{" "}
          <Link to="/product/import" className="ml-1 font-semibold text-emerald-700">
            Start your first import →
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-400">
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
            <tbody className="divide-y divide-slate-50">
              {data.map((session) => (
                <tr key={session.id}>
                  <td className="max-w-52 truncate px-4 py-3 font-medium text-slate-800">
                    {session.filename}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        session.status === "completed"
                          ? "bg-emerald-50 text-emerald-700"
                          : session.status === "failed"
                            ? "bg-rose-50 text-rose-700"
                            : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {session.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 capitalize text-slate-600">{session.mode}</td>
                  <td className="px-4 py-3 text-right">{session.totals?.totalRows ?? "—"}</td>
                  <td className="px-4 py-3 text-right text-emerald-700">
                    {session.totals?.created ?? 0}
                  </td>
                  <td className="px-4 py-3 text-right">{session.totals?.updated ?? 0}</td>
                  <td className="px-4 py-3 text-right text-rose-600">
                    {session.totals?.failed ?? 0}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {new Date(session.createdAt).toLocaleString("en-BD", { dateStyle: "medium", timeStyle: "short" })}
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={`/api/products/import/${session.id}/errors`}
                      onClick={(e) => {
                        e.preventDefault();
                        window.open(`/api/products/import/${session.id}/errors`, "_blank");
                      }}
                      className="text-xs font-semibold text-emerald-700"
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
