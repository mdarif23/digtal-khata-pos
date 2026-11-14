import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { suppliers } from "../../db/schema/suppliers.js";
import { recordAudit } from "../../services/audit.js";
import { NotFoundError } from "../../utils/handleError.js";
import type { SupplierSchemaTypeOutput } from "./schemas/supplier.schema.js";

// Every function takes the caller's server-verified businessId (from
// requireBusinessContext) and scopes all reads and writes to it.
export async function getSuppliers(businessId: number) {
  return db
    .select()
    .from(suppliers)
    .where(eq(suppliers.businessId, businessId))
    .orderBy(asc(suppliers.name));
}

export async function createSupplier(
  businessId: number,
  data: SupplierSchemaTypeOutput,
) {
  const [supplier] = await db
    .insert(suppliers)
    .values({
      businessId,
      name: data.supplierName,
      phone: data.phone,
      email: data.email,
      address: data.address,
      status: data.status,
    })
    .returning({ supplierId: suppliers.id });
  return supplier;
}

/** D1-05: supplier contact details were permanently uncorrectable. */
export async function updateSupplier(
  businessId: number,
  supplierId: number,
  data: SupplierSchemaTypeOutput,
  actorUserId: number | null,
) {
  const [updated] = await db
    .update(suppliers)
    .set({
      name: data.supplierName,
      phone: data.phone,
      email: data.email,
      address: data.address,
      status: data.status,
    })
    .where(
      and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)),
    )
    .returning();
  if (!updated) {
    throw new NotFoundError("Supplier not found");
  }
  void recordAudit({
    businessId,
    actorUserId,
    action: "supplier.update",
    entityType: "supplier",
    entityId: supplierId,
    metadata: { name: updated.name, status: updated.status },
  });
  return updated;
}
