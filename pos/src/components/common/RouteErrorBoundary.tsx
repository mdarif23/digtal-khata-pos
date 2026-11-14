import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router";
import { Button } from "@/components/ui/button";

/**
 * Router-level error boundary (P1-1): before this existed, ANY render error
 * on ANY page unmounted the whole React tree — including the POS mid-sale.
 * The router renders this instead of a white screen, the cashier keeps the
 * app chrome, and the error is logged for diagnosis.
 *
 * Handles both thrown responses (router navigation errors → 404) and raw
 * runtime exceptions from page components.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();

  // Rendered in two contexts: as the router's errorElement (error present)
  // and as the AppLayout catch-all for unknown URLs (no error at all).
  const isNotFound =
    error == null || (isRouteErrorResponse(error) && error.status === 404);
  const heading = isNotFound ? "Page not found" : "Something went wrong";
  const detail = isNotFound
    ? "The link you followed does not match any page in ezPos."
    : "An unexpected error occurred on this page. Your data is safe — the cart persists and nothing was submitted.";

  // eslint-disable-next-line no-console -- the last trace before the UI swallows it
  if (!isNotFound) console.error("[route-error]", error);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="text-5xl">{isNotFound ? "🧭" : "⚠️"}</div>
      <h1 className="text-xl font-semibold">{heading}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{detail}</p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <Button onClick={() => navigate("/")}>Back to POS</Button>
      </div>
    </div>
  );
}
