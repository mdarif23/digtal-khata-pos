import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { presignObjectUrl } from "../../services/objectStorage.js";

/**
 * Private storage for backup packages.
 *
 * Byte files live in the DEDICATED backup bucket (env S3_BACKUP_BUCKET,
 * default "ezpos-backups") which must have NO anonymous-access policy —
 * unlike the media bucket whose storefront prefix is deliberately public.
 * Every read/write goes through short-lived presigned URLs minted server
 * side; there is no public URL for any backup, ever.
 *
 * When object storage is not configured (no S3 credentials), the module
 * degrades to a server-local fallback directory so manual backups and
 * restores still work in development; scheduled backups are disabled in
 * that mode and the UI surfaces it. This is an explicit, documented
 * fallback — never a silent one.
 */

const LOCAL_FALLBACK_DIR = path.join(tmpdir(), "ezpos-backups");

export function backupStorageEnabled(): boolean {
  return Boolean(env.s3AccessKeyId && env.s3SecretAccessKey);
}

export function backupObjectKey(businessId: number): string {
  return `businesses/${businessId}/backups/${randomUUID()}.ezbackup`;
}

export function uploadObjectKey(businessId: number): string {
  return `businesses/${businessId}/uploads/${randomUUID()}.ezbackup`;
}

function isLocalKey(storageKey: string): boolean {
  return storageKey.startsWith("local:");
}

function localPathFor(storageKey: string): string {
  return path.join(LOCAL_FALLBACK_DIR, storageKey.slice("local:".length));
}

/** Persists a finished package file. Returns the storage key + byte size. */
export async function storePackageFile(
  businessId: number,
  filePath: string,
): Promise<{ storageKey: string; size: number }> {
  const { size } = await stat(filePath);
  if (!backupStorageEnabled()) {
    await mkdir(LOCAL_FALLBACK_DIR, { recursive: true });
    const fileName = `${randomUUID()}.ezbackup`;
    await pipeline(
      createReadStream(filePath),
      createWriteStream(path.join(LOCAL_FALLBACK_DIR, fileName)),
    );
    return { storageKey: `local:${fileName}`, size };
  }
  const storageKey = backupObjectKey(businessId);
  const url = presignObjectUrl(
    "PUT",
    storageKey,
    3600,
    env.s3BackupBucket,
  );
  const body = await stat(filePath);
  const fileStream = Readable.toWeb(
    createReadStream(filePath),
  ) as unknown as BodyInit;
  const res = await fetch(url, {
    method: "PUT",
    body: fileStream,
    headers: { "Content-Length": String(body.size) },
    // @ts-expect-error undici duplex option (Node fetch streaming request)
    duplex: "half",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Backup upload failed (HTTP ${res.status}): ${detail.slice(0, 200)}`,
    );
  }
  return { storageKey, size: body.size };
}

/** Materializes a stored package into a local temp file for processing. */
export async function fetchPackageFile(
  storageKey: string,
  destPath: string,
): Promise<void> {
  if (isLocalKey(storageKey)) {
    await pipeline(
      createReadStream(localPathFor(storageKey)),
      createWriteStream(destPath),
    );
    return;
  }
  const url = presignObjectUrl(
    "GET",
    storageKey,
    env.backupDownloadUrlTtlSeconds,
    env.s3BackupBucket,
  );
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(
      `Backup download from storage failed (HTTP ${res.status}).`,
    );
  }
  await pipeline(
    Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream),
    createWriteStream(destPath),
  );
}

/** HEAD the stored object — used by integrity verification. */
export async function headPackage(
  storageKey: string,
): Promise<{ exists: boolean; size: number | null }> {
  if (isLocalKey(storageKey)) {
    try {
      const s = await stat(localPathFor(storageKey));
      return { exists: true, size: s.size };
    } catch {
      return { exists: false, size: null };
    }
  }
  const url = presignObjectUrl(
    "HEAD",
    storageKey,
    env.backupDownloadUrlTtlSeconds,
    env.s3BackupBucket,
  );
  const res = await fetch(url, { method: "HEAD" });
  if (res.status === 404) return { exists: false, size: null };
  if (!res.ok) throw new Error(`Backup HEAD failed (HTTP ${res.status}).`);
  const len = res.headers.get("content-length");
  return { exists: true, size: len ? Number(len) : null };
}

/** Short-lived presigned GET for an authenticated user download. */
export function presignPackageDownload(storageKey: string): string {
  if (isLocalKey(storageKey)) {
    throw new Error(
      "Local-fallback backups are downloaded through the authenticated API stream, not presigned links.",
    );
  }
  return presignObjectUrl(
    "GET",
    storageKey,
    env.backupDownloadUrlTtlSeconds,
    env.s3BackupBucket,
  );
}

export function presignPackageUpload(
  businessId: number,
  contentType = "application/octet-stream",
): { storageKey: string; uploadUrl: string } {
  const storageKey = uploadObjectKey(businessId);
  const url = presignObjectUrl(
    "PUT",
    storageKey,
    env.backupDownloadUrlTtlSeconds,
    env.s3BackupBucket,
  );
  return { storageKey, uploadUrl: `${url}&Content-Type=${encodeURIComponent(contentType)}` };
}

/** Removes the stored object (retention cleanup / explicit delete). */
export async function deletePackageObject(storageKey: string): Promise<void> {
  if (isLocalKey(storageKey)) {
    await unlink(localPathFor(storageKey)).catch(() => {});
    return;
  }
  const url = presignObjectUrl(
    "DELETE",
    storageKey,
    env.backupDownloadUrlTtlSeconds,
    env.s3BackupBucket,
  );
  const res = await fetch(url, { method: "DELETE" });
  // 404 is fine — already gone; anything else is worth surfacing.
  if (!res.ok && res.status !== 404) {
    throw new Error(`Backup delete failed (HTTP ${res.status}).`);
  }
}

/** Reads an attachment object's bytes (for packaging business files). */
export async function fetchAttachmentBytes(
  objectKey: string,
): Promise<Buffer | null> {
  if (!backupStorageEnabled()) return null;
  const url = presignObjectUrl(
    "GET",
    objectKey,
    env.backupDownloadUrlTtlSeconds,
  );
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok || !res.body) {
    throw new Error(`Attachment fetch failed (HTTP ${res.status}).`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Re-uploads attachment bytes from a package (restore path). */
export async function putAttachmentBytes(
  objectKey: string,
  bytes: Buffer,
): Promise<void> {
  const url = presignObjectUrl("PUT", objectKey, 3600);
  const res = await fetch(url, {
    method: "PUT",
    body: new Uint8Array(bytes),
    headers: { "Content-Length": String(bytes.length) },
  });
  if (!res.ok) {
    throw new Error(`Attachment restore failed (HTTP ${res.status}).`);
  }
}
