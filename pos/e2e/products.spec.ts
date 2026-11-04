import { expect, test } from "@playwright/test";
import { injectSession, seedBusiness, seedProduct } from "./helpers";

// Workflow 1: product management — a product created through the real API
// surfaces in the products list and on its edit page.

test("a created product appears in the products list and on its edit page", async ({
  page,
  request,
}) => {
  const biz = await seedBusiness(request);
  const name = `E2E Product ${Date.now()}`;
  const { productId } = await seedProduct(request, biz, name);

  await injectSession(page.context(), biz);

  await page.goto("/product");
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });

  await page.goto(`/product/${productId}/edit`);
  // The name is loaded into the form field, not rendered as a text node.
  await expect(
    page.getByRole("textbox", { name: "Product Name" }),
  ).toHaveValue(name, { timeout: 20_000 });
});
