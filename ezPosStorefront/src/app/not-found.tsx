import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <p className="text-5xl font-bold opacity-20">404</p>
      <h1 className="mt-2 text-xl font-bold">Page not found</h1>
      <p className="mt-2 text-sm opacity-70">
        The page you are looking for doesn&apos;t exist or is no longer available.
      </p>
      <Link href="/" className="sf-btn mt-6">
        Back to the store
      </Link>
    </div>
  );
}
