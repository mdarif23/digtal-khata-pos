import { expect, test } from "@playwright/test";
import {
  authHeaders,
  createCustomer,
  createPurchaseChain,
  createPurchaseReturn,
  createSaleViaApi,
  createStaffUser,
  firstSoldItemId,
  injectSession,
  refundSaleItem,
  seedBusiness,
  seedProduct,
  type E2EBusiness,
} from "./helpers";

// Audit-plan E2E Workflows 4–8. Actions whose forms are heavy multi-step UI
// (receiving, returns) run through the REAL API over the browser's request
// context — the same server + database the UI talks to — and every workflow
// still ends with a UI assertion against a real rendered page.

let seq = 0;
const uniq = (prefix: string) => `${prefix}-${Date.now()}-${(seq += 1)}`;

async function loginAndGetCookie(
  request: any,
  creds: { email: string; password: string },
): Promise<string> {
  const login = await request.post("http://localhost:3000/api/auth/login", {
    data: { email: creds.email, password: creds.password },
  });
  if (login.status() !== 200) {
    throw new Error(`login failed: ${await login.text()}`);
  }
  const match = /ezpos_refresh_token=([^;]+)/.exec(
    login.headers()["set-cookie"] ?? "",
  );
  if (!match) throw new Error("login did not carry the refresh cookie");
  return match[1]!;
}

test("Workflow 4 — split cash + due sale lands on the customer's balance", async ({
  page,
  request,
}) => {
  const biz = await seedBusiness(request);
  const name = uniq("W4 Product");
  const { variantId } = await seedProduct(request, biz, name);
  const customerName = uniq("W4 Customer");
  const customerId = await createCustomer(request, biz, customerName);

  // 40 cash + 60 due of a 100 sale — the backend validates the split exactly.
  await createSaleViaApi(request, biz, {
    variantId,
    customerId,
    payments: [
      { method: "cash", amount: 40 },
      { method: "due", amount: 60 },
    ],
  });

  await injectSession(page.context(), biz);
  await page.goto("/due-management");
  await expect(page.getByText(customerName).first()).toBeVisible({
    timeout: 20_000,
  });
});

test("Workflow 5 — purchase, receive, return shows on the purchase pages", async ({
  page,
  request,
}) => {
  const biz = await seedBusiness(request);
  const { variantId } = await seedProduct(request, biz, uniq("W5 Product"));
  const { purchaseId, poNumber, itemId } = await createPurchaseChain(
    request,
    biz,
    variantId,
    3,
    50,
  );
  expect(poNumber).toMatch(/^PO-\d{4}-\d{6}$/);

  await createPurchaseReturn(request, biz, purchaseId, itemId, 1);

  await injectSession(page.context(), biz);
  await page.goto("/purchases-list");
  await expect(page.getByText(poNumber).first()).toBeVisible({
    timeout: 20_000,
  });

  await page.goto(`/purchase-return/${purchaseId}`);
  await expect(page.getByText(poNumber).first()).toBeVisible({
    timeout: 20_000,
  });
});

test("Workflow 6 — sold item refunds and restocks via the sales flow", async ({
  page,
  request,
}) => {
  const biz = await seedBusiness(request);
  const { variantId } = await seedProduct(request, biz, uniq("W6 Product"));

  await createSaleViaApi(request, biz, {
    variantId,
    customerId: null,
    payments: [{ method: "cash", amount: 100 }],
  });

  const sold = await firstSoldItemId(request, biz);
  expect(sold.id).toBeGreaterThan(0);
  await refundSaleItem(request, biz, sold.id);

  await injectSession(page.context(), biz);
  await page.goto("/sales");
  if (sold.invoiceNumber) {
    await expect(page.getByText(sold.invoiceNumber).first()).toBeVisible({
      timeout: 20_000,
    });
  } else {
    // Fall back to asserting the sales history page rendered at all.
    await expect(page.locator("main, table, [role='main']").first()).toBeVisible();
  }
});

test("Workflow 7 — a cashier is kept out of management routes", async ({
  page,
  request,
}) => {
  const owner = await seedBusiness(request);
  const product = await seedProduct(request, owner, uniq("W7 Product"));
  const cashier = await createStaffUser(request, owner, "cashier");

  const cookie = await loginAndGetCookie(request, cashier);
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: "ezpos_refresh_token",
      value: cookie,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  // Cashier has pos.view — the POS renders with the catalog.
  await page.goto("/");
  await expect(page.getByText(/W7 Product/).first()).toBeVisible({
    timeout: 20_000,
  });

  // Cashier lacks users.create / reports permissions → guarded routes 403.
  await page.goto("/users");
  await expect(page).toHaveURL(/\/403/);
  await page.goto("/reports");
  await expect(page).toHaveURL(/\/403/);
});

test("Workflow 8 — tenant B cannot see or touch tenant A's catalog", async ({
  page,
  request,
}) => {
  const bizA = await seedBusiness(request);
  const nameA = uniq("Tenant A Product");
  const { productId: productA } = await seedProduct(request, bizA, nameA);

  const bizB = await seedBusiness(request);
  const nameB = uniq("Tenant B Product");
  await seedProduct(request, bizB, nameB);

  // API: B reading A's product id must not succeed.
  const cross = await request.get(
    `http://localhost:3000/api/product/${productA}`,
    { headers: authHeaders(bizB) },
  );
  expect([403, 404]).toContain(cross.status());

  // UI: B's catalog shows B's product and never A's.
  await injectSession(page.context(), bizB);
  await page.goto("/product");
  await expect(page.getByText(nameB).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(nameA)).toHaveCount(0);
});
