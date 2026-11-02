import { getTenant } from "@/lib/tenant";
import { CheckoutForm } from "@/components/checkout-form";


// Client-rendered per tenant — excluded from prerender.
export const instant = false;

export default async function CheckoutPage() {
  const tenant = await getTenant();
  if (!tenant) return null;
  return (
    <div className="mx-auto px-4 py-8" style={{ maxWidth: "48rem" }}>
      <h1 className="text-2xl font-bold">Checkout</h1>
      <CheckoutForm
        storefrontId={tenant.config.storefront.id}
        returnOrigin={tenant.origin}
        zones={tenant.config.zones}
        storePickupEnabled={tenant.config.storefront.flags.storePickupEnabled}
        paymentMethods={
          tenant.config.paymentMethods?.length
            ? tenant.config.paymentMethods
            : [{ method: "cod", label: "Cash on delivery" }]
        }
      />
    </div>
  );
}
