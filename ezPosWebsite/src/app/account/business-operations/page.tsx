import { BusinessOperationsCenter } from "@/components/account/business-operations-center";

// Client-rendered behind auth — excluded from instant-nav prerender.
export const instant = false;

export default function AccountBusinessOperationsPage() {
  return <BusinessOperationsCenter />;
}
