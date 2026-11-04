import { expect, test } from "@playwright/test";
import { injectSession, seedBusiness, seedProduct } from "./helpers";

// Workflow 3 (core): login → open POS → add product → cart reflects it.
// The full payment step is asserted at the API contract level in the backend
// suites; here we verify the register UI end-to-end against a real backend.

test("POS boots the session and adds a seeded product to the cart", async ({
  page,
  request,
}) => {
  const biz = await seedBusiness(request);
  const name = `E2E Widget ${Date.now()}`;
  await seedProduct(request, biz, name);

  await injectSession(page.context(), biz);
  await page.goto("/");

  // The POS catalog shows the seeded product (catalog fetch on bootstrap).
  const card = page.getByText(name).first();
  await expect(card).toBeVisible({ timeout: 20_000 });

  await card.click();
  await expect(page.getByText(/added to cart/i)).toBeVisible();
});

test("session bootstrap rejects a missing refresh cookie (guarded route)", async ({
  page,
  request,
}) => {
  const biz = await seedBusiness(request);
  await seedProduct(request, biz, `E2E NoCookie ${Date.now()}`);
  // No cookie injected: the app cannot bootstrap and must not render the POS.
  await page.goto("/");
  await expect(page.getByText(/E2E NoCookie/)).not.toBeVisible({ timeout: 10_000 });
});
