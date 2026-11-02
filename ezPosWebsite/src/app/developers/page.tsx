import { Container } from "@/components/ui/container";
import { publicMetadata } from "@/lib/seo";

export const metadata = publicMetadata(
  "/developers",
  "Developer documentation",
  "Build a custom storefront on the ezPos Storefront API: authentication, products, inventory, orders, and webhooks.",
);

function Code({ children }: { children: string }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-900 p-4 text-xs leading-5 text-slate-100">
      <code>{children}</code>
    </pre>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <div className="mt-3 space-y-4 text-sm leading-6 text-slate-600">
        {children}
      </div>
    </section>
  );
}

export default function DevelopersPage() {
  return (
    <section className="py-16 sm:py-24">
      <Container className="max-w-3xl">
        <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">
          Developers
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          Storefront API
        </h1>
        <p className="mt-4 text-base leading-7 text-slate-600">
          Build a custom storefront on top of ezPos. The API exposes your
          product catalog and online-available stock, and accepts orders that
          flow through the same inventory, refund, and accounting rules as
          your physical counter — ezPos is always the source of truth.
        </p>

        <Section title="1. Get your API keys">
          <p>
            In your ezPos account, open{" "}
            <strong>Account → Integrations</strong> and switch your business
            mode to <code>online_only</code> or <code>omnichannel</code>.
            Then create an API key. You get two credentials:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <code>ezpos_pk_…</code> — <strong>publishable</strong>: safe in
              browser code, catalog and availability reads only. Optionally
              domain-restricted.
            </li>
            <li>
              <code>ezpos_sk_…</code> — <strong>secret</strong>: server-to-server
              only (never in browser JavaScript). Required to create orders.
              Shown once at creation.
            </li>
          </ul>
        </Section>

        <Section title="2. Authentication">
          <p>
            Send the key as a Bearer token. All endpoints are scoped to the
            business that owns the key.
          </p>
          <Code>{`curl https://api.ezpos.com/api/v1/storefront/products \\
  -H "Authorization: Bearer ezpos_pk_…"`}</Code>
          <p>
            Rate limit: 600 requests per minute per key. Exceeding it returns
            <code> 429</code>.
          </p>
        </Section>

        <Section title="3. Products and availability">
          <Code>{`GET /api/v1/storefront/products?search=coffee&page=1
GET /api/v1/storefront/products/:productId
GET /api/v1/storefront/categories
GET /api/v1/storefront/brands
GET /api/v1/storefront/inventory?variantIds=12,13`}</Code>
          <p>
            Every variant carries an <code>availability</code> number: the
            stock your storefront may sell right now (shared stock, or your
            per-variant allocation). Availability changes the moment your
            counter sells — always re-check before checkout; never trust a
            cached quantity.
          </p>
          <p>
            Product responses contain selling prices and images only — never
            purchase costs or supplier data.
          </p>
        </Section>

        <Section title="4. Creating orders">
          <p>
            Order submission requires the <strong>secret key</strong>, the
            <code> orders:write</code> scope, and an{" "}
            <code>Idempotency-Key</code> header: replaying the same key always
            returns the same order instead of creating a duplicate. Prices and
            totals are computed server-side from the ezPos catalog — anything
            you send besides product IDs and quantities is advisory.
          </p>
          <Code>{`POST /api/v1/storefront/orders
Authorization: Bearer ezpos_sk_…
Idempotency-Key: checkout-2026-10-31-000123

{
  "lines": [{ "variantId": 12, "quantity": 2 }],
  "customer": { "name": "Web buyer", "phone": "+8801700111222" },
  "paymentMethod": "cod",
  "externalOrderId": "your-order-42"
}`}</Code>
          <p>
            Response <code>201</code> with the order id, invoice number, and
            status (<code>pending</code>). Insufficient online stock returns
            <code> 409</code> with the shortfall. A pending order holds stock
            for 30 minutes; confirm payment through your ezPos portal, or let
            the hold expire and the order cancel automatically.
          </p>
        </Section>

        <Section title="5. Next.js checkout example">
          <p>
            A route handler that validates the cart against ezPos and creates
            the order server-side (full starter in the repository under{" "}
            <code>examples/nextjs-storefront/</code>):
          </p>
          <Code>{`// app/api/checkout/route.ts  (your server, not the browser)
export async function POST(request: Request) {
  const cart = await request.json();
  const res = await fetch(
    process.env.EZPOS_API_URL! + "/api/v1/storefront/orders",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Bearer \${process.env.EZPOS_SECRET_KEY!}\`,
        "Idempotency-Key": cart.idempotencyKey, // from your checkout session
      },
      body: JSON.stringify({
        lines: cart.lines, // [{ variantId, quantity }]
        customer: cart.customer,
      }),
    },
  );
  if (res.status === 409) {
    const { message } = await res.json(); // stock changed — refresh cart
    return Response.json({ error: message }, { status: 409 });
  }
  const order = await res.json();
  return Response.json(order);
}`}</Code>
          <p>
            PHP stores follow the same shape: a server-side
            <code> file_get_contents</code>/<code>curl</code> call with the
            secret key in the Authorization header.
          </p>
        </Section>

        <Section title="6. Webhooks">
          <p>
            Register an endpoint under <strong>Account → Webhooks</strong> to
            receive <code>order.created</code>,{" "}
            <code>order.paid</code>, and <code>order.cancelled</code> events.
            Deliveries are signed with your endpoint secret:
          </p>
          <Code>{`import { createHmac, timingSafeEqual } from "node:crypto";

const expected =
  "sha256=" +
  createHmac("sha256", process.env.EZPOS_WEBHOOK_SECRET!)
    .update(rawBody) // the exact bytes received
    .digest("hex");

const ok = timingSafeEqual(
  Buffer.from(expected),
  Buffer.from(signatureHeader),
);`}</Code>
          <p>
            Respond <code>2xx</code> quickly; failed deliveries retry with
            exponential backoff (up to 5 attempts) and are visible in your
            portal delivery history.
          </p>
        </Section>

        <Section title="7. Errors">
          <Code>{`401 — missing/invalid/revoked API key
403 — scope missing, origin not allowed, or business mode not online-capable
409 — insufficient online stock for one or more lines
429 — rate limit exceeded (600 req/min per key)`}</Code>
        </Section>
      </Container>
    </section>
  );
}
