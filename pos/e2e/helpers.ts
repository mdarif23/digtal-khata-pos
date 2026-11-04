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
): Promise<number> {
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
  return body.data.productId;
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
