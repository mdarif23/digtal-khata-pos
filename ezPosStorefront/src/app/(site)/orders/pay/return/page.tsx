import { getTenant } from "@/lib/tenant";
import { PaymentReturn } from "@/components/payment-return";

export const instant = false;

/**
 * Gateway return landing. The redirect itself NEVER marks an order paid —
 * this page triggers the backend's server-side verification (gateway
 * validation + amount match), which is idempotent and shared with the IPN.
 */
export default async function PayReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tenant = await getTenant();
  if (!tenant) return null;
  const params = await searchParams;
  const sale = Number(Array.isArray(params.sale) ? params.sale[0] : params.sale);
  const valId = Array.isArray(params.val_id) ? params.val_id[0] : params.val_id;
  const outcome = Array.isArray(params.outcome) ? params.outcome[0] : params.outcome;

  return (
    <PaymentReturn
      storefrontId={tenant.config.storefront.id}
      saleId={Number.isInteger(sale) && sale > 0 ? sale : null}
      valId={typeof valId === "string" ? valId : null}
      outcome={typeof outcome === "string" ? outcome : null}
    />
  );
}
