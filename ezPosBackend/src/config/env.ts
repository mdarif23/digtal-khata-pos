import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for setup.`,
    );
  }
  return value.trim();
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Environment variable ${name} must be a positive integer, got "${raw}".`,
    );
  }
  return parsed;
}

/**
 * Server-side policy and configuration. Validated at startup so the server
 * fails fast with a clear message instead of misbehaving later.
 */
export const env = {
  /** HS256 signing secret for access tokens. */
  jwtSecret: (() => {
    const secret = required("AUTH_JWT_SECRET");
    if (secret.length < 32) {
      throw new Error(
        "AUTH_JWT_SECRET is too short — use at least 32 characters (e.g. openssl rand -base64 48).",
      );
    }
    return secret;
  })(),
  isProduction: process.env.NODE_ENV === "production",
  /** Single source of truth for the free-trial duration (days). */
  trialDays: optionalInt("TRIAL_DAYS", 14),
  /** Slug of the plan record trials are attached to (must be seeded). */
  trialPlanSlug: process.env.TRIAL_PLAN_SLUG?.trim() || "free-trial",
  accessTokenTtlMinutes: optionalInt("ACCESS_TOKEN_TTL_MINUTES", 15),
  refreshTokenTtlDays: optionalInt("REFRESH_TOKEN_TTL_DAYS", 7),
  /** Ops-tunable rate-limit ceilings (requests per 15-minute window). */
  authRateLimitMax: optionalInt("AUTH_RATE_LIMIT_MAX", 20),
  refreshRateLimitMax: optionalInt("REFRESH_RATE_LIMIT_MAX", 60),
  /**
   * Email delivery. "console" (default) logs messages instead of pretending
   * to send; "resend" posts to the Resend HTTP API; "none" discards.
   */
  emailProvider: ((): "console" | "resend" | "none" => {
    const raw = process.env.EMAIL_PROVIDER?.trim() || "console";
    if (raw !== "console" && raw !== "resend" && raw !== "none") {
      throw new Error(
        `EMAIL_PROVIDER must be "console", "resend", or "none", got "${raw}".`,
      );
    }
    return raw;
  })(),
  resendApiKey: process.env.RESEND_API_KEY?.trim() || "",
  emailFrom: process.env.EMAIL_FROM?.trim() || "",
  /** Public website origin used for links inside emails. */
  appUrl: process.env.APP_URL?.trim() || "http://localhost:3001",
  passwordResetTokenTtlHours: optionalInt("PASSWORD_RESET_TOKEN_TTL_HOURS", 2),
  /**
   * Payment gateway. "mock" issues deterministic dev/test sessions and is
   * REFUSED in production; "sslcommerz" is the real gateway.
   */
  paymentProvider: ((): "mock" | "sslcommerz" => {
    const raw = process.env.PAYMENT_PROVIDER?.trim() || "mock";
    if (raw !== "mock" && raw !== "sslcommerz") {
      throw new Error(
        `PAYMENT_PROVIDER must be "mock" or "sslcommerz", got "${raw}".`,
      );
    }
    if (raw === "mock" && process.env.NODE_ENV === "production") {
      throw new Error(
        'PAYMENT_PROVIDER=mock is not allowed in production — simulated payments must never be treated as real ones. Set PAYMENT_PROVIDER=sslcommerz.',
      );
    }
    return raw;
  })(),
  sslcommerzStoreId: process.env.SSLCOMMERZ_STORE_ID?.trim() || "",
  sslcommerzStorePassword: process.env.SSLCOMMERZ_STORE_PASSWORD?.trim() || "",
  sslcommerzSandbox: process.env.SSLCOMMERZ_SANDBOX?.trim() !== "false",
  /** Public backend origin, used as the IPN callback target. */
  backendUrl: process.env.BACKEND_URL?.trim() || "http://localhost:3000",
  /** Background sweeps (trial expiry, reminders, grace suspension). */
  jobsEnabled: process.env.JOBS_ENABLED?.trim() !== "false",
  jobsIntervalMinutes: optionalInt("JOBS_INTERVAL_MINUTES", 60),
  /**
   * AES-256-GCM master key for integration credentials. Required outside
   * development; a deterministic dev fallback keeps local testing frictionless.
   */
  integrationEncryptionKey:
    process.env.INTEGRATION_ENCRYPTION_KEY?.trim() ||
    (process.env.NODE_ENV === "production"
      ? ""
      : "ezpos-local-development-integration-encryption-key"),
  /** Storefront API per-key request ceiling per minute. */
  storefrontRateLimitPerMinute: optionalInt("STOREFRONT_RATE_LIMIT_PER_MINUTE", 600),
  emailVerificationTokenTtlHours: optionalInt(
    "EMAIL_VERIFICATION_TOKEN_TTL_HOURS",
    24,
  ),
  /**
   * Browser origins allowed to call this API with credentials (the website
   * and the POS frontend in local development). Comma-separated; no wildcard
   * when credentials are involved.
   */
  corsOrigins: (
    process.env.CORS_ORIGINS?.trim() ||
    "http://localhost:3001,http://localhost:5173"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  // ---------------------------------------------------------------------------
  // Hosted storefront platform (website platform stage 1)
  // ---------------------------------------------------------------------------
  /** Base domain tenant subdomains live under (storefronts.<this>). */
  storefrontBaseDomain: (
    process.env.STOREFRONT_BASE_DOMAIN?.trim() || "ezpos.store"
  ).toLowerCase(),
  /**
   * Shared secret for internal renderer/edge endpoints
   * (/api/internal/*). Required in production; deterministic dev fallback.
   */
  internalApiToken: (() => {
    const token = process.env.STOREFRONT_RENDERER_TOKEN?.trim();
    if (token) return token;
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Missing required environment variable STOREFRONT_RENDERER_TOKEN. Generate one with: openssl rand -base64 48",
      );
    }
    return "ezpos-local-development-internal-token";
  })(),
  /** S3-compatible object storage (MinIO locally, R2/S3 in production). */
  s3Endpoint: process.env.S3_ENDPOINT?.trim() || "http://localhost:9000",
  s3Region: process.env.S3_REGION?.trim() || "us-east-1",
  s3Bucket: process.env.S3_BUCKET?.trim() || "ezpos-media",
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID?.trim() || "",
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim() || "",
  /** Public base URL media is served from (CDN host in production). */
  s3PublicBaseUrl:
    process.env.S3_PUBLIC_BASE_URL?.trim() ||
    `${process.env.S3_ENDPOINT?.trim() || "http://localhost:9000"}/${
      process.env.S3_BUCKET?.trim() || "ezpos-media"
    }`,
  /** Per-file upload cap in megabytes. */
  mediaMaxUploadMb: optionalInt("MEDIA_MAX_UPLOAD_MB", 10),
} as const;
