import { AdminBusinessDetailPage } from "@/components/saas-admin/admin-business-detail";

// Client-rendered behind admin auth — excluded from instant-nav prerender.
export const instant = false;

export default function SaasAdminBusinessDetailPage() {
  return <AdminBusinessDetailPage />;
}
