import { StoreShell } from "@/components/account/store-shell";
import { DomainsManager } from "@/components/account/domains-manager";

// Client-rendered behind auth — excluded from instant-nav prerender.
export const instant = false;

export default function StoreDomainsPage() {
  return (
    <StoreShell>
      <DomainsManager />
    </StoreShell>
  );
}
