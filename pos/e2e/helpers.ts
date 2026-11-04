import type { APIRequestContext, BrowserContext } from "@playwright/test";

const BACKEND = "http://localhost:3000";
const PASSWORD = "strong-password-123";

export interface E2EBusiness {
  email: string;
  password: string;
  token: string;
  businessId: number;
  locationId: number | null;
  refreshToken: string;
}

export function authHeaders(ctx: E2EBusiness): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ctx.token}`,
    "X-Business-Id": String(ctx.businessId),
  };
}

async function assertOk(res: Awaited<ReturnType<APIRequestContext["post"]>>, what: string) {
  if (res.status() !== 201) {
    throw new Error(`${what} failed ${res.status()}: ${await res.text()}`);
  }
}

/** Registers an owner, creates a business + default location, logs in. */
export async function seedBusiness(
  request: APIRequestContext,
): Promise<E2EBusiness> {
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.test`;
  await assertOk(
    await request.post(`${BACKEND}/api/auth/register`, {
      data: { fullName: "E2E Owner", email, password: PASSWORD },
    }),
    "register",
  );
  const login = await request.post(`${BACKEND}/api/auth/login`, {
    data: { email, password: PASSWORD },
  });
  if (login.status() !== 200) {
    throw new Error(`login failed ${login.status()}: ${await login.text()}`);
  }
  const body = (await login.json()) as {
    accessToken: string;
    user: { id: number };
  };
  const ctx: E2EBusiness = {
    email,
    password: PASSWORD,
    token: body.accessToken,
    businessId: 0,
    locationId: null,
    refreshToken: "",
  };

  const bizRes = await request.post(`${BACKEND}/api/businesses`, {
    headers: authHeaders(ctx),
    data: { name: `E2E Biz ${Date.now()}` },
  });
  await assertOk(bizRes, "business create");
  const bizBody = (await bizRes.json()) as { business: { id: number } };
  ctx.businessId = bizBody.business.id;

  const loc = await request.post(`${BACKEND}/api/locations`, {
    headers: authHeaders(ctx),
    data: { name: "Main Store" },
  });
  await assertOk(loc, "location create");
  const locBody = (await loc.json()) as any;
  const data = locBody?.data;
  ctx.locationId = Number(data?.id ?? data?.location?.id ?? data?.[0]?.id ?? 0) || null;

  // The refresh token lives ONLY in the login Set-Cookie header.
  const setCookie = login.headers()["set-cookie"] ?? "";
  const match = /ezpos_refresh_token=([^;]+)/.exec(setCookie);
  if (!match) {
    throw new Error("login response did not carry the refresh cookie");
  }
  ctx.refreshToken = match[1]!;
  return ctx;
}

/** Creates a physical product with opening stock via the real API. */
export async function seedProduct(
  request: APIRequestContext,
  ctx: E2EBusiness,
  name: string,
  quantity = 10,
): Promise<{ productId: number; variantId: number; sellingPrice: number }> {
  const unit = await request.post(`${BACKEND}/api/product/unit`, {
    headers: authHeaders(ctx),
    data: {
      unitName: `Unit ${Date.now()}`,
      abbreviation: `u${Date.now() % 100000}`,
    },
  });
  if (unit.status() !== 201) {
    throw new Error(`unit create failed: ${await unit.text()}`);
  }
  const unitBody = (await unit.json()) as any;
  const unitId = Number(
    unitBody?.data?.value ?? unitBody?.data?.id ?? unitBody?.id,
  );

  const product = await request.post(`${BACKEND}/api/product`, {
    headers: authHeaders(ctx),
    data: {
      name,
      categoryId: null,
      brandId: null,
      unitId,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "none",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "opening",
      variants: [
        {
          sku: "",
          barcode: "",
          sellingPrice: 100,
          alertQuantity: 2,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 40,
          quantity,
          expiryDate: null,
          serialNumbers: [],
          options: [],
        },
      ],
    },
  });
  if (product.status() !== 201) {
    throw new Error(`product create failed: ${await product.text()}`);
  }
  const body = (await product.json()) as { data: { productId: number } };
  const productId = Number(body.data.productId);

  const detail = (await (
    await request.get(`${BACKEND}/api/product/${productId}`, {
      headers: authHeaders(ctx),
    })
  ).json()) as any;
  const variant = (detail?.data ?? detail)?.variants?.[0];
  if (!variant?.id) {
    throw new Error(`variant missing from product detail: ${JSON.stringify(detail)}`);
  }
  return {
    productId,
    variantId: Number(variant.id),
    sellingPrice: Number(variant.sellingPrice ?? 100),
  };
}

export async function createCustomer(
  request: APIRequestContext,
  ctx: E2EBusiness,
  name: string,
): Promise<number> {
  const res = await request.post(`${BACKEND}/api/customers`, {
    headers: authHeaders(ctx),
    data: { name, phone: `+88017${Date.now() % 100000000}`.slice(0, 14) },
  });
  if (res.status() !== 201) {
    throw new Error(`customer create failed: ${await res.text()}`);
  }
  const body = (await res.json()) as any;
  return Number(body?.id ?? body?.data?.id ?? body?.customer?.id);
}

/** Creates a sale through POST /api/sales — the same payload the POS sends. */
export async function createSaleViaApi(
  request: APIRequestContext,
  ctx: E2EBusiness,
  opts: {
    variantId: number;
    customerId: number | null;
    payments: { method: string; amount: number }[];
  },
): Promise<any> {
  const res = await request.post(`${BACKEND}/api/sales`, {
    headers: authHeaders(ctx),
    data: {
      saleDate: new Date().toISOString(),
      customerId: opts.customerId,
      payments: opts.payments,
      discount: null,
      vatPercent: 0,
      idempotencyKey: `e2e-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      items: [
        { variantId: opts.variantId, quantity: 1, unitPrice: 100, discount: null },
      ],
    },
  });
  if (res.status() !== 201) {
    throw new Error(`sale create failed: ${await res.text()}`);
  }
  return (await res.json()) as any;
}

/** Purchase → full receive, returning ids needed for returns/verification. */
export async function createPurchaseChain(
  request: APIRequestContext,
  ctx: E2EBusiness,
  variantId: number,
  qty = 3,
  unitCost = 50,
): Promise<{ purchaseId: number; poNumber: string; itemId: number }> {
  const supplier = await request.post(`${BACKEND}/api/contacts/supplier`, {
    headers: authHeaders(ctx),
    data: {
      supplierName: `E2E Supplier ${Date.now()}`,
      phone: "+8801711000000",
      email: `e2e-supplier-${Date.now()}@example.test`,
      address: "E2E",
    },
  });
  if (supplier.status() !== 201) {
    throw new Error(`supplier create failed: ${await supplier.text()}`);
  }
  const supplierBody = (await supplier.json()) as any;
  const supplierId = Number(
    supplierBody?.data?.supplierId ?? supplierBody?.data?.id ?? supplierBody?.id,
  );

  const purchase = await request.post(`${BACKEND}/api/purchases`, {
    headers: authHeaders(ctx),
    data: {
      items: [{ variantId, quantity: qty, purchasePrice: unitCost }],
      supplierId,
      purchaseDate: new Date().toISOString(),
    },
  });
  if (purchase.status() !== 201) {
    throw new Error(`purchase create failed: ${await purchase.text()}`);
  }
  const purchaseBody = (await purchase.json()) as any;
  const purchaseId = Number(purchaseBody?.data?.id);
  const poNumber = String(purchaseBody?.data?.purchaseOrderNumber ?? "");

  const itemsRes = await request.get(`${BACKEND}/api/purchases/items`, {
    headers: authHeaders(ctx),
  });
  const itemsBody: any = await itemsRes.json();
  const rows: any[] = itemsBody?.data ?? itemsBody ?? [];
  const mine = rows.find(
    (r) => Number(r?.purchaseId ?? r?.purchase_id) === purchaseId,
  );
  if (!mine?.id) {
    throw new Error(
      `purchase item not found for purchase ${purchaseId}: ${JSON.stringify(itemsBody).slice(0, 400)}`,
    );
  }
  const itemId = Number(mine.id);

  const receive = await request.post(`${BACKEND}/api/purchases/receive`, {
    headers: authHeaders(ctx),
    data: {
      purchaseId,
      items: [
        {
          itemId,
          trackingType: "none",
          receiveNow: qty,
          unitCost,
          sellingPrice: 100,
          batches: [],
          serialNumbers: [],
        },
      ],
      paymentAmount: 0,
      paymentMethod: "cash",
    },
  });
  if (receive.status() !== 201) {
    throw new Error(`receive failed: ${await receive.text()}`);
  }
  return { purchaseId, poNumber, itemId };
}

export async function createPurchaseReturn(
  request: APIRequestContext,
  ctx: E2EBusiness,
  purchaseId: number,
  itemId: number,
  quantity: number,
): Promise<void> {
  const res = await request.post(`${BACKEND}/api/purchase-return`, {
    headers: authHeaders(ctx),
    data: {
      orderId: purchaseId,
      reason: "damaged in transit",
      changedItems: [{ purchaseItemId: itemId, quantity }],
    },
  });
  if (res.status() !== 201) {
    throw new Error(`purchase return failed: ${await res.text()}`);
  }
}

/** Refunds one sold item (restock). `saleItemId` comes from the sales list. */
export async function refundSaleItem(
  request: APIRequestContext,
  ctx: E2EBusiness,
  saleItemId: number,
): Promise<any> {
  const res = await request.post(
    `${BACKEND}/api/sold_products/refund/${saleItemId}`,
    {
      headers: authHeaders(ctx),
      data: { reason: "customer_request", disposition: "restock" },
    },
  );
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(`refund failed: ${await res.text()}`);
  }
  return (await res.json()) as any;
}

/** First row id from the sales list — the sale-item id used for refunds. */
export async function firstSoldItemId(
  request: APIRequestContext,
  ctx: E2EBusiness,
): Promise<{ id: number; invoiceNumber: string | null }> {
  const res = await request.get(`${BACKEND}/api/sold_products`, {
    headers: authHeaders(ctx),
  });
  const body: any = await res.json();
  const rows: any[] = body?.data ?? body ?? [];
  const row = rows[0];
  if (!row) {
    throw new Error(`sales list empty: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return {
    // The refund endpoint wants the SALE ITEM id — exactly what the UI sends
    // (sales.api.ts: `item.saleItemsId`).
    id: Number(row.saleItemsId ?? row.sale_items_id ?? row.id),
    invoiceNumber:
      row.invoiceNumber ?? row.invoice_number ?? row.sale?.invoiceNumber ?? null,
  };
}

/** Creates a staff user with the given role slug and returns its login. */
export async function createStaffUser(
  request: APIRequestContext,
  ctx: E2EBusiness,
  roleSlug: string,
): Promise<{ email: string; password: string }> {
  const rolesRes = await request.get(`${BACKEND}/api/roles`, {
    headers: authHeaders(ctx),
  });
  const rolesBody: any = await rolesRes.json();
  const roles: any[] = rolesBody?.data ?? rolesBody ?? [];
  const role = roles.find(
    (r) => r?.slug === roleSlug || r?.name?.toLowerCase() === roleSlug,
  );
  if (!role?.id) {
    throw new Error(
      `role "${roleSlug}" not found: ${JSON.stringify(rolesBody).slice(0, 400)}`,
    );
  }

  const email = `staff-${Date.now()}@example.test`;
  const password = "strong-password-123";
  const res = await request.post(`${BACKEND}/api/users`, {
    headers: authHeaders(ctx),
    data: {
      fullName: "E2E Staff",
      email,
      password,
      roleIds: [Number(role.id)],
      locationIds: ctx.locationId ? [ctx.locationId] : undefined,
    },
  });
  if (res.status() !== 201) {
    throw new Error(`staff user create failed: ${await res.text()}`);
  }
  return { email, password };
}

/**
 * Seeds the refresh-token cookie so the SPA's bootstrapSession() rotates it
 * into an in-memory access token on first load — same flow as production.
 */
export async function injectSession(
  context: BrowserContext,
  ctx: E2EBusiness,
): Promise<void> {
  await context.addCookies([
    {
      name: "ezpos_refresh_token",
      value: ctx.refreshToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
