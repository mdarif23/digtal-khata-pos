import { StoreShell } from "@/components/account/store-shell";
import { StoreAnalytics } from "@/components/account/store-analytics";

// Client-rendered behind auth — excluded from instant-nav prerender.
export const instant = false;

export default function StoreAnalyticsPage() {
  return (
    <StoreShell>
      <StoreAnalytics />
    </StoreShell>
  );
}
