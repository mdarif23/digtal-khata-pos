# Customer Communications Setup (Phase 2C)

This guide covers enabling real WhatsApp / SMS / email sending after the
Phase 2C comms foundation. **Nothing here is required for ezPos to run** —
until a real provider is configured, every message is delivered by the
built-in `console` provider (logged server-side, marked `sent` in the
message log), so the full flow is testable with zero credentials.

---

## 1. How the system fits together

```
POS sale / due sweep / manual send
        │
        ▼
comm_messages row (status=queued)   ← persisted FIRST, consent + daily cap enforced here
        │
        ▼
provider adapter (per business + channel, chosen by is_default)
        │            ├── console         dev default — logs, no external calls
        │            ├── whatsapp_cloud  Meta WhatsApp Business Cloud API (official)
        │            ├── generic_http    any Bangladesh SMS gateway with a REST API
        │            └── resend          email
        ▼
status → sent (provider_message_id stored) or failed (error stored, retryable)
        │
        ▼
delivery webhooks (optional) update status via HMAC-signed callbacks
```

Key properties (already implemented — no code changes needed to switch):

- Provider **credentials are AES-256-GCM encrypted** at rest and never
  returned by the API (masked previews only).
- **Consent is enforced server-side:** marketing sends require the
  customer's `marketing_opt_in`; transactional sends are skipped when
  `transactional_opt_out` is set; a per-customer daily cap applies.
- Every send persists to `comm_messages` before delivery, so failures are
  visible in the message log and never silent.

---

## 2. One-time preparation (all providers)

**Step 1 — set a dedicated encryption secret.** In `.env`:

```
EZPOS_COMM_SECRET=<generate with: openssl rand -base64 48>
```

(If unset it falls back to `AUTH_JWT_SECRET` — fine for dev; set a dedicated
value in production so rotating auth keys never invalidates saved provider
configs.)

**Step 2 — restart the backend.**

**Step 3 — open `/comms-settings`** in the web app as an owner/manager:

- **Providers** → *Add provider* → pick channel (SMS / WhatsApp / email) →
  pick the provider implementation → paste credentials → save. The config
  is encrypted immediately; afterwards you only ever see a masked preview.
- **Templates** → edit the message bodies (placeholders like
  `{{customerName}}`, `{{invoiceNumber}}`, `{{due}}`, `{{total}}`).
- **Policy** → enable *Auto e-receipt after sale* and/or *Due reminders
  (daily sweep)*, and set the daily per-customer cap.
- **Delivery webhook secret** → *Reveal / regenerate* when you configure
  delivery-status callbacks (section 6).

Everything below can also be done via the API instead of the UI — curl
examples are in section 7.

---

## 3. Option A — Meta WhatsApp Business Cloud API (official)

This is the **official** WhatsApp route (no unofficial automation).

### 3.1 Get credentials

1. Create a Meta Business account and a Meta developer app at
   <https://developers.facebook.com> (product: **WhatsApp**).
2. In the WhatsApp product dashboard, note:
   - **Phone number ID** (the sender number's numeric ID — not the phone
     number itself),
   - a **permanent access token** (System User token with
     `whatsapp_business_messaging` permission — temporary tokens expire).
3. Sandbox note: Meta's test number can send to up to 5 verified recipient
   numbers — enough to test end-to-end before business verification.

### 3.2 Configure

UI: `/comms-settings` → Add provider → channel **WhatsApp** → provider
**WhatsApp Business Cloud (official)**. The add dialog notes the field
names; set them via the API (the UI dialog intentionally shows the shape):

```bash
curl -X PUT https://YOUR_HOST/api/comms/providers \
  -H "Authorization: Bearer OWNER_TOKEN" -H "X-Business-Id: 1" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "whatsapp",
    "providerKey": "whatsapp_cloud",
    "displayName": "Business WhatsApp",
    "config": { "phoneNumberId": "123456789012345", "accessToken": "EAAG..." },
    "isDefault": true,
    "isActive": true
  }'
```

### 3.3 ⚠️ Template reality check (important)

Meta requires **pre-approved templates** for business-initiated messages
(e-receipts, due reminders — anything you send first). Free-form `text`
messages only deliver **inside the 24-hour customer-service window** that
opens when the customer last messaged you.

The current adapter sends `type: "text"`, which works:

- inside the 24-hour window (e.g. a customer who just messaged the shop), or
- against Meta's test number to verified testers.

For production receipts/reminders, register message templates in **Meta
Business Manager → WhatsApp → Message templates** (category `UTILITY` for
receipts/reminders), then extend the adapter to send
`type: "template"` with the registered template name + language + body
params — a small, contained follow-up (~20 lines in
`deliverViaWhatsappCloud`). Ask for it when you have the account approved.

---

## 4. Option B — Bangladesh SMS gateway (generic HTTP adapter)

The `generic_http` provider works with **any gateway whose API accepts an
HTTP GET/POST with the number and message** — that covers the common local
gateways (SSL Wireless, Alpha Net, Bulk SMS BD, MIMS, and similar). Check
your gateway's API doc for the exact request shape, then map it.

### 4.1 What you need from the gateway

- API endpoint URL and method (GET or POST),
- your API key / token (usually a header or a query parameter),
- the parameter names the gateway expects for the **number** and the
  **message body**,
- whether the response contains a message id (nice for delivery tracking,
  not required).

### 4.2 Configure

The adapter substitutes into your templates:

- `{{recipient}}` — the phone number, URL-encoded in the URL,
- `{{body}}` — the rendered message (URL-encoded in the URL, escaped in the
  body template).

```bash
curl -X PUT https://YOUR_HOST/api/comms/providers \
  -H "Authorization: Bearer OWNER_TOKEN" -H "X-Business-Id: 1" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "sms",
    "providerKey": "generic_http",
    "displayName": "My SMS gateway",
    "config": {
      "url": "https://api.my-gateway.com/send?token=MY_KEY&to={{recipient}}&text={{body}}",
      "method": "POST",
      "headers": { "Authorization": "Bearer MY_KEY" },
      "body": "{\"to\": \"{{recipient}}\", \"message\": \"{{body}}\"}"
    },
    "isDefault": true,
    "isActive": true
  }'
```

- For **GET-style gateways**: put everything in `url`, set
  `"method": "GET"`, and omit `body`.
- For **POST-JSON gateways**: use `body` with the gateway's JSON shape.
- The UI at `/comms-settings` exposes the URL + API key fields for the
  common case.

### 4.3 Test

```bash
curl -X POST https://YOUR_HOST/api/comms/send \
  -H "Authorization: Bearer OWNER_TOKEN" -H "X-Business-Id: 1" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "sms",
    "customerId": 123,
    "recipient": "01712345678",
    "templateKey": "custom",
    "messageClass": "transactional",
    "variables": { "body": "ezPos SMS test" }
  }'
```

Then check **/comms-settings → Message log**: `sent` with the gateway's
message id, or `failed` with the gateway's error text.

---

## 5. Option C — Resend (email)

1. Create an account at <https://resend.com>, create an **API key**, and
   verify your sending domain (or use the onboarding sender for testing).
2. Configure:

```bash
curl -X PUT https://YOUR_HOST/api/comms/providers \
  -H "Authorization: Bearer OWNER_TOKEN" -H "X-Business-Id: 1" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "email",
    "providerKey": "resend",
    "displayName": "Resend",
    "config": { "apiKey": "re_...", "from": "ezPos <receipts@yourdomain.com>" },
    "isDefault": true,
    "isActive": true
  }'
```

Email sends use the customer's `email` field when the phone is absent.

---

## 6. Delivery-status webhooks (optional, per provider)

If the provider supports delivery callbacks:

1. `POST /api/comms/webhook-secret` (as owner) → returns the signing secret.
2. Point the provider's webhook at
   `POST /api/comms/webhook/<businessId>` with header
   `X-EZPOS-Signature: HMAC-SHA256(secret, rawBody)`.
3. Payload shape:

```json
{
  "providerKey": "whatsapp_cloud",
  "providerMessageId": "<id from the send response>",
  "status": "sent",
  "error": null
}
```

Replies are **idempotent** (a repeated callback is a no-op) and the
signature is verified over the exact raw bytes — failures return 401.

---

## 7. Switching it on

1. Configure a default provider per channel (section 3/4/5).
2. `/comms-settings` → enable **Auto e-receipt after sale** and/or
   **Due reminders (daily sweep)**.
3. Set customer consent: the customer form's communication-consent toggles
   (`marketing_opt_in` / `transactional_opt_out`).
4. Send a test (section 4.3) and confirm the message log shows `sent`.
5. The due-reminder sweep runs with the scheduler and is **per-customer
   once per day**; receipts fire right after each sale.

## 8. Troubleshooting

| Symptom | Where to look |
|---|---|
| Entry `skipped` / reason `marketing_not_opted_in` | Customer's consent toggles |
| `daily_cap_reached` | Policy → daily cap, or messages sent today |
| `failed` with gateway text | Message log error column; verify key/URL shape |
| `Unable to load...` after provider save | `EZPOS_COMM_SECRET` changed since the config was saved — re-save the provider |
| WhatsApp fails outside the 24h window | Expected for business-initiated text — register templates (section 3.3) |
