import { StoreShell } from "@/components/account/store-shell";
import { CustomizeEditor } from "@/components/account/customize-editor";

// Client-rendered behind auth — excluded from instant-nav prerender.
export const instant = false;

export default function StoreCustomizePage() {
  return (
    <StoreShell>
      <CustomizeEditor />
    </StoreShell>
  );
}
