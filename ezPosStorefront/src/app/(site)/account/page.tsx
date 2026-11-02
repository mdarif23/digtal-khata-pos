import { getTenant } from "@/lib/tenant";
import { ShopperProvider } from "@/components/shopper-context";
import { ShopperAccount } from "@/components/shopper-account";

export const instant = false;

export default async function AccountPage() {
  const tenant = await getTenant();
  if (!tenant) return null;
  const storefront = tenant.config.storefront;
  return (
    <ShopperProvider storefrontId={storefront.id}>
      <ShopperAccount enabled={storefront.flags.shopperAccountsEnabled === true} />
    </ShopperProvider>
  );
}
