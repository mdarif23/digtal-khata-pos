import { StoreShell } from "@/components/account/store-shell";
import { StoreDashboard } from "@/components/account/store-dashboard";

// Client-rendered behind auth — excluded from instant-nav prerender.
export const instant = false;

export default function StoreDashboardPage() {
  return (
    <StoreShell>
      <StoreDashboard />
    </StoreShell>
  );
}
