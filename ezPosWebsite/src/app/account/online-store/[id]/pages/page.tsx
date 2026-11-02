import { StoreShell } from "@/components/account/store-shell";
import { PagesEditor } from "@/components/account/pages-editor";

// Client-rendered behind auth — excluded from instant-nav prerender.
export const instant = false;

export default function StorePagesPage() {
  return (
    <StoreShell>
      <PagesEditor />
    </StoreShell>
  );
}
