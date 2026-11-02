import { CartView } from "@/components/cart-view";

// Client-rendered per tenant — excluded from prerender.
export const instant = false;

export default function CartPage() {
  return <CartView />;
}
