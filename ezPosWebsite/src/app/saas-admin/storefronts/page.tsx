import { AdminStorefronts } from "@/components/saas-admin/admin-storefronts";

// Client-rendered behind platform-admin gate — excluded from instant-nav.
export const instant = false;

export default function SaasAdminStorefrontsPage() {
  return <AdminStorefronts />;
}
