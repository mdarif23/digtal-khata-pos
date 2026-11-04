import { randomUUID } from "node:crypto";
import { expenseAttachments } from "../../db/schema/expenseAttachments.js";
import { expenses } from "../../db/schema/expenses.js";
import { db } from "../../db/schema/index.js";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import { recordAudit } from "../../services/audit.js";
import { env } from "../../config/env.js";
import {
  mediaStorageEnabled,
  presignObjectUrl,
} from "../../services/objectStorage.js";
import type {
  AttachmentRegisterInput,
  AttachmentPresignInput,
} from "./expenses.schema.js";

/**
 * Expense attachments (receipts/invoices) — metadata + presigned-URL flow.
 * Mirrors the storefront media pattern (browser PUTs straight to MinIO/R2/S3)
 * with two differences: PDFs are allowed alongside images, and documents are
 * PRIVATE — downloads only via short-lived presigned GETs after an ownership
 * check, never a public CDN URL.
 */

const ATTACHMENT_CONTENT_TYPES: Record<string, { ext: string; label: string }> =
  {
    "application/pdf": { ext: "pdf", label: "PDF" },
    "image/jpeg": { ext: "jpg", label: "JPEG" },
    "image/png": { ext: "png", label: "PNG" },
    "image/webp": { ext: "webp", label: "WebP" },
  };

const PRESIGN_EXPIRES_SECONDS = 600;

export function attachmentAllowedLabel(): string {
  return "PDF, JPEG, PNG and WebP files";
}

function assertSupportedContentType(contentType: string) {
  if (!(contentType in ATTACHMENT_CONTENT_TYPES)) {
    throw new BadRequestError(
      `Only ${attachmentAllowedLabel()} are supported.`,
    );
  }
}

function assertWithinSizeLimit(sizeBytes: number) {
  const maxBytes = env.mediaMaxUploadMb * 1024 * 1024;
  if (sizeBytes > maxBytes) {
    throw new BadRequestError(
      `Attachments can be up to ${env.mediaMaxUploadMb} MB.`,
    );
  }
}

/** The expense must exist, belong to the business, and not be voided. */
async function assertActiveExpense(businessId: number, expenseId: number) {
  const [expense] = await db
    .select({ id: expenses.id, title: expenses.title })
    .from(expenses)
    .where(
      and(
        eq(expenses.id, expenseId),
        eq(expenses.businessId, businessId),
        isNull(expenses.deletedAt),
      ),
    )
    .limit(1);
  if (!expense) {
    throw new NotFoundError("Expense not found");
  }
  return expense;
}

export async function presignExpenseAttachment(
  businessId: number,
  expenseId: number,
  input: AttachmentPresignInput,
) {
  await assertActiveExpense(businessId, expenseId);
  if (!mediaStorageEnabled()) {
    throw new BadRequestError(
      "File storage is not configured yet. Please contact ezPos support.",
    );
  }
  assertSupportedContentType(input.contentType);
  assertWithinSizeLimit(input.sizeBytes);
  const ext = ATTACHMENT_CONTENT_TYPES[input.contentType]?.ext;
  if (!ext) {
    throw new BadRequestError(
      `Only ${attachmentAllowedLabel()} are supported.`,
    );
  }
  const objectKey = `businesses/${businessId}/expenses/${randomUUID()}.${ext}`;
  return {
    objectKey,
    uploadUrl: presignObjectUrl("PUT", objectKey),
    expiresIn: PRESIGN_EXPIRES_SECONDS,
  };
}

export async function registerExpenseAttachment(
  businessId: number,
  expenseId: number,
  uploadedBy: number,
  input: AttachmentRegisterInput,
) {
  await assertActiveExpense(businessId, expenseId);
  if (!mediaStorageEnabled()) {
    throw new BadRequestError(
      "File storage is not configured yet. Please contact ezPos support.",
    );
  }
  assertSupportedContentType(input.contentType);
  assertWithinSizeLimit(input.bytes);
  // Storage-isolation boundary: the key must name THIS business's expense
  // prefix — a client cannot register an object from another tenant's prefix.
  if (!input.objectKey.startsWith(`businesses/${businessId}/expenses/`)) {
    throw new BadRequestError("Invalid object key.");
  }

  // Confirm the bytes actually landed in storage before keeping metadata.
  try {
    const head = await fetch(presignObjectUrl("HEAD", input.objectKey));
    if (!head.ok) {
      throw new Error("not-found");
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(
      "Upload not found — finish uploading the file first, then attach it.",
    );
  }

  const insertedAttachments = await db
    .insert(expenseAttachments)
    .values({
      businessId,
      expenseId,
      objectKey: input.objectKey,
      fileName: input.fileName,
      contentType: input.contentType,
      bytes: input.bytes,
      uploadedBy,
    })
    .returning();
  const attachment = insertedAttachments[0];
  if (!attachment) {
    throw new NotFoundError("Attachment could not be registered.");
  }
  await recordAudit({
    businessId,
    actorUserId: uploadedBy,
    action: "expense.attachment.create",
    entityType: "expense",
    entityId: expenseId,
    metadata: {
      attachmentId: attachment.id,
      fileName: attachment.fileName,
      bytes: attachment.bytes,
    },
  });
  return attachment;
}

export async function listExpenseAttachments(
  businessId: number,
  expenseId: number,
) {
  return db
    .select({
      id: expenseAttachments.id,
      fileName: expenseAttachments.fileName,
      contentType: expenseAttachments.contentType,
      bytes: expenseAttachments.bytes,
      uploadedBy: expenseAttachments.uploadedBy,
      createdAt: expenseAttachments.createdAt,
    })
    .from(expenseAttachments)
    .where(
      and(
        eq(expenseAttachments.expenseId, expenseId),
        eq(expenseAttachments.businessId, businessId),
        isNull(expenseAttachments.deletedAt),
      ),
    )
    .orderBy(asc(expenseAttachments.id));
}

export async function getAttachmentDownloadUrl(
  businessId: number,
  attachmentId: number,
) {
  const [attachment] = await db
    .select({
      id: expenseAttachments.id,
      fileName: expenseAttachments.fileName,
      objectKey: expenseAttachments.objectKey,
    })
    .from(expenseAttachments)
    .where(
      and(
        eq(expenseAttachments.id, attachmentId),
        eq(expenseAttachments.businessId, businessId),
        isNull(expenseAttachments.deletedAt),
      ),
    )
    .limit(1);
  if (!attachment) {
    throw new NotFoundError("Attachment not found");
  }
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    downloadUrl: presignObjectUrl("GET", attachment.objectKey),
    expiresIn: PRESIGN_EXPIRES_SECONDS,
  };
}

/** Soft delete — storage object is retained; access is revoked by the row. */
export async function deleteExpenseAttachment(
  businessId: number,
  attachmentId: number,
  deletedBy: number,
) {
  const [deleted] = await db
    .update(expenseAttachments)
    .set({ deletedAt: sql`CURRENT_TIMESTAMP`, deletedBy })
    .where(
      and(
        eq(expenseAttachments.id, attachmentId),
        eq(expenseAttachments.businessId, businessId),
        isNull(expenseAttachments.deletedAt),
      ),
    )
    .returning({
      id: expenseAttachments.id,
      expenseId: expenseAttachments.expenseId,
      fileName: expenseAttachments.fileName,
    });
  if (!deleted) {
    throw new NotFoundError("Attachment not found");
  }
  await recordAudit({
    businessId,
    actorUserId: deletedBy,
    action: "expense.attachment.delete",
    entityType: "expense",
    entityId: deleted.expenseId,
    metadata: {
      attachmentId: deleted.id,
      fileName: deleted.fileName,
    },
  });
  return deleted;
}
