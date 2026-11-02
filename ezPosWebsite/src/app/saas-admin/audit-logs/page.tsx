import { AdminAuditLogs } from "@/components/saas-admin/admin-audit-logs";

// Client-rendered behind admin auth — excluded from instant-nav prerender.
export const instant = false;

export default function SaasAdminAuditLogsPage() {
  return <AdminAuditLogs />;
}
