import { createHash, createHmac, randomUUID } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Minimal S3-compatible object-storage client (SigV4 query auth).
 *
 * Dependency-free on purpose: we only need presigned PUT/HEAD/DELETE URLs —
 * bytes flow directly between the browser and MinIO (locally) or R2/S3
 * (production). Swapping providers is an env change only.
 */

export function mediaStorageEnabled(): boolean {
  return Boolean(env.s3AccessKeyId && env.s3SecretAccessKey);
}

export function publicMediaUrl(objectKey: string): string {
  return `${env.s3PublicBaseUrl}/${objectKey}`;
}

export function buildMediaObjectKey(
  businessId: number,
  contentType: string,
): string {
  const ext = MEDIA_CONTENT_TYPES[contentType]?.ext ?? "bin";
  return `businesses/${businessId}/storefront/${randomUUID()}.${ext}`;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Builds a SigV4 presigned URL for a single-object operation.
 * Only the host header is signed and the payload is unsigned (standard for
 * browser uploads).
 */
export function presignObjectUrl(
  method: "PUT" | "GET" | "HEAD" | "DELETE",
  objectKey: string,
  expiresSeconds = 600,
): string {
  const endpoint = new URL(env.s3Endpoint);
  const host = endpoint.host;
  const canonicalUri = `/${env.s3Bucket}/${objectKey
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  const amzDate = new Date()
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${env.s3Region}/s3/aws4_request`;

  const params: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${env.s3AccessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = [...params]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${env.s3SecretAccessKey}`, dateStamp), env.s3Region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  return `${endpoint.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ---------------------------------------------------------------------------
// Upload policy
// ---------------------------------------------------------------------------

export interface MediaContentType {
  ext: string;
  label: string;
}

export const MEDIA_CONTENT_TYPES: Record<string, MediaContentType> = {
  "image/jpeg": { ext: "jpg", label: "JPEG" },
  "image/png": { ext: "png", label: "PNG" },
  "image/webp": { ext: "webp", label: "WebP" },
};

export function isAllowedMediaType(contentType: string): boolean {
  return contentType in MEDIA_CONTENT_TYPES;
}
