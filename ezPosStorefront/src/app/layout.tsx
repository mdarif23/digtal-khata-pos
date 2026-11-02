import type { Metadata } from "next";
import "./globals.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/playfair-display/400.css";
import "@fontsource/playfair-display/600.css";
import "@fontsource/lora/400.css";
import "@fontsource/lora/600.css";

export const metadata: Metadata = {
  // Real, tenant-specific metadata is generated in the (site) layout.
  title: "Store",
  robots: { index: false, follow: false },
};

/**
 * Root shell only — every storefront page lives in the (site) route group,
 * which resolves the tenant and injects its theme. Unknown hosts are
 * rewritten to /parked by the proxy and never reach (site).
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
