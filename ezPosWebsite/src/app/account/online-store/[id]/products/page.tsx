import { StoreShell } from "@/components/account/store-shell";
import { ProductsPublisher } from "@/components/account/products-publisher";

// Client-rendered behind auth — excluded from instant-nav prerender.
export const instant = false;

export default function StoreProductsPage() {
  return (
    <StoreShell>
      <ProductsPublisher />
    </StoreShell>
  );
}
