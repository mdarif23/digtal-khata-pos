import { StoreShell } from "@/components/account/store-shell";
import { StoreSettings } from "@/components/account/store-settings";

// Client-rendered behind auth — excluded from instant-nav prerender.
export const instant = false;

export default function StoreSettingsPage() {
  return (
    <StoreShell>
      <StoreSettings />
    </StoreShell>
  );
}
