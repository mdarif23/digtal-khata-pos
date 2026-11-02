import { getTenant } from "@/lib/tenant";
import { TrackOrderForm } from "@/components/track-order-form";


// Client-rendered per tenant — excluded from prerender.
export const instant = false;

export default async function TrackOrderPage() {
  const tenant = await getTenant();
  if (!tenant) return null;
  return (
    <TrackOrderForm storefrontId={tenant.config.storefront.id} />
  );
}
