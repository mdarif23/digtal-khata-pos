import { OnlineStoreCenter } from "@/components/account/online-store-center";

// Client-rendered behind auth — excluded from instant-nav prerender.
export const instant = false;

export default function AccountOnlineStorePage() {
  return <OnlineStoreCenter />;
}
