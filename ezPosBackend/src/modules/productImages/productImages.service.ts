import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { productImages as productImagesTable } from "../../db/schema/productImages.js";
import { products as productsTable } from "../../db/schema/products.js";
import {
  BadRequestError,
  NotFoundError,
} from "../../utils/handleError.js";
import { recordAudit } from "../../services/audit.js";
import {
  MEDIA_CONTENT_TYPES,
  mediaStorageEnabled,
  presignObjectUrl,
} from "../../services/objectStorage.js";

/**
 * Product images (Phase 5 of the product-module refactor): completes the
 * previously dead image flow using the SAME presigned-direct-upload
 * architecture as expense attachments — browser PUTs bytes straight to
 * S3/MinIO, Express never handles the file, and only the final reference is
 * persisted into the (previously unwritten) `product_images` table.
 *
 * Ownership: the product must belong to the caller's business, and the
 * object key must live under `businesses/{id}/products/` — a client cannot
 * register an object from another tenant's prefix.
 */

const PRESIGN_EXPIRES_SECONDS = 600;

function assertImageStorageReady() {
  if (!mediaStorageEnabled()) {
    throw new BadRequestError(
      "File storage is not configured yet. Please contact ezPos support.",
    );
  }
}

async function assertProductInBusiness(businessId: number, productId: number) {
  const [product] = await db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(
      and(eq(productsTable.id, productId), eq(productsTable.businessId, businessId)),
    )
    .limit(1);
  if (!product) throw new NotFoundError("Product not found.");
}

export async function presignProductImage(input: {
  businessId: number;
  productId: number;
  contentType: string;
  sizeBytes: number;
  maxMb: number;
}) {
  await assertProductInBusiness(input.businessId, input.productId);
  assertImageStorageReady();
  const mediaType = MEDIA_CONTENT_TYPES[input.contentType];
  if (!mediaType) {
    throw new BadRequestError("Only JPEG, PNG or WebP images are supported.");
  }
  if (input.sizeBytes <= 0 || input.sizeBytes > input.maxMb * 1024 * 1024) {
    throw new BadRequestError(
      `Image exceeds the ${input.maxMb} MB upload limit.`,
    );
  }
  const objectKey = `businesses/${input.businessId}/products/${randomUUID()}.${mediaType.ext}`;
  return {
    objectKey,
    uploadUrl: presignObjectUrl("PUT", objectKey),
    expiresIn: PRESIGN_EXPIRES_SECONDS,
  };
}

export async function registerProductImage(input: {
  businessId: number;
  productId: number;
  actorUserId: number;
  objectKey: string;
  contentType: string;
}) {
  await assertProductInBusiness(input.businessId, input.productId);
  const prefix = `businesses/${input.businessId}/products/`;
  if (!input.objectKey.startsWith(prefix)) {
    throw new BadRequestError("Invalid object key.");
  }
  if (!Object.values(MEDIA_CONTENT_TYPES).some((m) => input.objectKey.endsWith(`.${m.ext}`))) {
    throw new BadRequestError("Invalid image object key.");
  }
  const existing = await db
    .select({ id: productImagesTable.id })
    .from(productImagesTable)
    .where(
      and(
        eq(productImagesTable.productId, input.productId),
        eq(productImagesTable.businessId, input.businessId),
      ),
    );
  const [row] = await db
    .insert(productImagesTable)
    .values({
      businessId: input.businessId,
      productId: input.productId,
      imageUrl: input.objectKey,
      is_primary: existing.length === 0,
      sortOrder: existing.length,
    })
    .returning();
  await recordAudit({
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    action: "product.image.assigned",
    entityType: "product",
    entityId: input.productId,
    metadata: { imageId: row!.id },
  });
  return row!;
}

export async function listProductImages(businessId: number, productId: number) {
  await assertProductInBusiness(businessId, productId);
  return db
    .select()
    .from(productImagesTable)
    .where(
      and(
        eq(productImagesTable.productId, productId),
        eq(productImagesTable.businessId, businessId),
      ),
    )
    .orderBy(asc(productImagesTable.sortOrder));
}

export async function deleteProductImage(input: {
  businessId: number;
  productId: number;
  imageId: number;
  actorUserId: number;
}) {
  const [row] = await db
    .select()
    .from(productImagesTable)
    .where(
      and(
        eq(productImagesTable.id, input.imageId),
        eq(productImagesTable.productId, input.productId),
        eq(productImagesTable.businessId, input.businessId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Product image not found.");
  await db
    .delete(productImagesTable)
    .where(eq(productImagesTable.id, input.imageId));
  await recordAudit({
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    action: "product.image.removed",
    entityType: "product",
    entityId: input.productId,
    metadata: { imageId: input.imageId },
  });
  return { imageId: input.imageId };
}
