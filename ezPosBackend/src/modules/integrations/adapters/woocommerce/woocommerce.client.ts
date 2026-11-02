export interface AdapterProduct {
  id: number;
  name: string;
  description: string | null;
  hasVariants: boolean;
  images: string[];
  variants: { id: number; sku: string; price: number; isDefault: boolean; availability: number }[];
}

/**
 * WooCommerce REST API v3 adapter. Injectable fetch so tests can run a
 * local mock store; production uses the global fetch with timeouts.
 * Everything WooCommerce-specific stays behind this adapter — the commerce
 * core never imports from this folder.
 */

export class WoocommerceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WoocommerceApiError";
  }
}

export interface WoocommerceCredentials {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export type FetchFn = typeof fetch;

export class WoocommerceClient {
  constructor(
    private readonly credentials: WoocommerceCredentials,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private endpoint(path: string): string {
    const base = this.credentials.storeUrl.replace(/\/+$/, "");
    return `${base}/wp-json/wc/v3${path}`;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const auth = Buffer.from(
      `${this.credentials.consumerKey}:${this.credentials.consumerSecret}`,
    ).toString("base64");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchFn(this.endpoint(path), {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        parsed = text;
      }
      if (!response.ok) {
        const message =
          (parsed as { message?: string } | null)?.message ??
          `HTTP ${response.status}`;
        throw new WoocommerceApiError(message, response.status);
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof WoocommerceApiError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new WoocommerceApiError(
          "The WooCommerce store did not respond within 15 seconds.",
          504,
        );
      }
      throw new WoocommerceApiError(
        `WooCommerce request failed: ${(err as Error).message}`,
        502,
      );
    }
  }

  /** Lightweight authenticated read used by the connect flow. */
  async validateConnection(): Promise<void> {
    await this.request<unknown>("GET", "/data");
  }

  /**
   * Upserts a customer by email (Module 12 customer sync): looks the
   * customer up by email, updates the Woo record when found, creates one
   * otherwise. Returns the Woo customer id.
   */
  async upsertCustomerByEmail(customer: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string | null;
  }): Promise<{ id: number; created: boolean }> {
    const email = customer.email.trim().toLowerCase();
    const existing = await this.request<
      { id: number }[]
    >("GET", `/customers?email=${encodeURIComponent(email)}&per_page=1`);
    const match = Array.isArray(existing) ? existing[0] : undefined;
    const body = {
      email,
      first_name: customer.firstName.slice(0, 100),
      last_name: customer.lastName.slice(0, 100),
      ...(customer.phone ? { billing: { phone: customer.phone } } : {}),
    };
    if (match?.id) {
      await this.request<{ id: number }>(
        "PUT",
        `/customers/${match.id}`,
        body,
      );
      return { id: match.id, created: false };
    }
    const created = await this.request<{ id: number }>(
      "POST",
      "/customers",
      body,
    );
    return { id: created.id, created: true };
  }

  async createWebhook(secret: string, deliveryUrl: string): Promise<{ id: number }> {
    const webhook = await this.request<{ id: number }>("POST", "/webhooks", {
      name: "ezPos order sync",
      topic: "order.updated",
      secret,
      delivery_url: deliveryUrl,
    });
    return { id: webhook.id };
  }

  async updateProductStock(
    externalProductId: string,
    stockQuantity: number,
  ): Promise<void> {
    await this.request("PUT", `/products/${externalProductId}`, {
      manage_stock: true,
      stock_quantity: stockQuantity,
      stock_status: stockQuantity > 0 ? "instock" : "outofstock",
    });
  }

  async updateVariationStock(
    externalProductId: string,
    externalVariationId: string,
    stockQuantity: number,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/products/${externalProductId}/variations/${externalVariationId}`,
      {
        manage_stock: true,
        stock_quantity: stockQuantity,
        stock_status: stockQuantity > 0 ? "instock" : "outofstock",
      },
    );
  }
}

// --- outbound payload mapping (ezPos → WooCommerce) ---

export interface WcProductPayload {
  name: string;
  type: "simple" | "variable";
  regular_price?: string | undefined;
  sku?: string | undefined;
  manage_stock: boolean;
  stock_quantity: number;
  stock_status: "instock" | "outofstock";
  description?: string | undefined;
  images?: { src: string }[] | undefined;
}

export function mapProductToWc(
  product: AdapterProduct,
  availableByVariant: Map<number, number>,
): {
  product: WcProductPayload;
  variations: { sku: string; payload: WcProductPayload }[];
} {
  const images = product.images.map((src: string) => ({ src }));
  if (!product.hasVariants || product.variants.length <= 1) {
    const variant = product.variants[0];
    return {
      product: {
        name: product.name,
        type: "simple",
        regular_price: (variant?.price ?? 0).toFixed(2),
        sku: variant?.sku || undefined,
        manage_stock: true,
        stock_quantity: variant?.availability ?? 0,
        stock_status: (variant?.availability ?? 0) > 0 ? "instock" : "outofstock",
        description: product.description ?? undefined,
        images: images.length > 0 ? images : undefined,
      },
      variations: [],
    };
  }
  return {
    product: {
      name: product.name,
      type: "variable",
      manage_stock: false,
      stock_quantity: 0,
      stock_status: "instock",
      description: product.description ?? undefined,
      images: images.length > 0 ? images : undefined,
    },
    variations: product.variants.map((variant) => ({
      sku: variant.sku,
      payload: {
        name: product.name,
        type: "simple" as const,
        regular_price: variant.price.toFixed(2),
        sku: variant.sku || undefined,
        manage_stock: true,
        stock_quantity: availableByVariant.get(variant.id) ?? 0,
        stock_status:
          (availableByVariant.get(variant.id) ?? 0) > 0
            ? ("instock" as const)
            : ("outofstock" as const),
      },
    })),
  };
}
