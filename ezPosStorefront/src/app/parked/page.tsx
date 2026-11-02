import Link from "next/link";

/**
 * Branded landing for unknown/dangling hosts and offline stores. No tenant
 * content is ever rendered here — this page is the security boundary for
 * host-header attacks and expired domains.
 */
export default function ParkedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-3xl font-bold text-slate-900">
          This domain isn&apos;t set up yet
        </p>
        <p className="mt-3 text-sm text-slate-600">
          No storefront is connected to this address. If you own this domain,
          check its DNS settings or contact ezPos support.
        </p>
        <Link
          href="https://ezpos.com"
          className="mt-6 inline-flex rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          Powered by ezPos
        </Link>
      </div>
    </main>
  );
}
