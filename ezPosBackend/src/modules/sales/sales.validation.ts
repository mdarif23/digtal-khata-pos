import { and, eq, inArray, type ExtractTablesWithRelations } from "drizzle-orm";
import { customers } from "../../db/schema/customers.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { DbTransaction } from "../../config/db.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { products } from "../../db/schema/products.js";

export async function customerValidation(
  tx: DbTransaction,
  businessId: number,
  customerId: number | null,
) {
  if (customerId === null) return;
  const [customer] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(eq(customers.id, customerId), eq(customers.businessId, businessId)),
    )
    .limit(1);
  if (!customer) {
    throw new NotFoundError(`Customer with ID ${customerId} not found.`);
  }
}
export type Items = {
  variantId: number;
  quantity: number;
  unitPrice: number;
  discount: {
    type: "fixed" | "percentage";
    value: number;
  } | null;
};
export async function validateVariants(
  tx: DbTransaction,
  businessId: number,
  items: Items[],
) {
  if (items.length === 0) {
    throw new NotFoundError("A sale must contain at least one item.");
  }
  const variantIds = items.map((item) => item.variantId);
  if (new Set(variantIds).size !== variantIds.length) {
    throw new NotFoundError(
      "Duplicate product variants are not allowed. Combine their quantities first.",
    );
  }
  const existingVariants = await tx
    .select({
      id: productVariants.id,
      sellingPrice: productVariants.sellingPrice,
      trackingType: products.trackingType,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        inArray(productVariants.id, variantIds),
        eq(productVariants.businessId, businessId),
      ),
    )
    .for("update");
  if (existingVariants.length !== variantIds.length) {
    const foundIds = new Set(existingVariants.map((v) => v.id));
    const missingIds = variantIds.filter((id) => !foundIds.has(id));
    throw new NotFoundError(
      `These variants do not exist: ${missingIds.join(", ")}`,
    );
  }
  return { variantIds, existingVariants };
}
export async function validateStock(
  tx: DbTransaction,
  businessId: number,
  locationId: number,
  variantIds: number[],
  items: Items[],
) {
  const stockRows = await tx
    .select({
      variantId: inventoryStock.variantId,
      quantity: inventoryStock.quantity,
    })
    .from(inventoryStock)
    .where(
      and(
        inArray(inventoryStock.variantId, variantIds),
        eq(inventoryStock.businessId, businessId),
        eq(inventoryStock.locationId, locationId),
      ),
    )
    .for("update");
  const stockMap = new Map(
    stockRows.map((row) => [row.variantId, Number(row.quantity)]),
  );
  for (const item of items) {
    const available = stockMap.get(item.variantId);
    if (available === undefined) {
      throw new NotFoundError(
        `No inventory record exists for variant ${item.variantId}`,
      );
    }
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw new NotFoundError(`Invalid quantity for variant ${item.variantId}`);
    }
    if (item.quantity > available) {
      throw new NotFoundError(
        `Insufficient stock for variant ${item.variantId}. Available: ${available}`,
      );
    }
  }
  return stockMap;
}
type Payments = {
  method: "cash" | "bangla_qr" | "card" | "due";
  amount?: number | undefined;
  tendered?: number | undefined;
  reference?: string | undefined;
};

function toPoisha(amount: number) {
  return Math.round(amount * 100);
}

export function validatePayments(
  payments: Payments[],
  finalTotal: number,
  customerId: number | null,
) {
  if (payments.length === 0) {
    throw new NotFoundError("At least one payment row is required.");
  }

  const methods = payments.map((p) => p.method);

  if (new Set(methods).size !== methods.length) {
    throw new ConflictError("Duplicate payment methods are not allowed.");
  }
  for (const payment of payments) {
    if (payment.method === "due") {
      continue;
    }
    if (!Number.isFinite(payment.amount) || (payment.amount ?? 0) < 0) {
      throw new BadRequestError("Invalid payment amount.");
    }

    if (
      (payment.method === "card" || payment.method === "bangla_qr") &&
      (payment.amount ?? 0) > 0 &&
      (payment.reference ?? "").trim().length < 6
    ) {
      throw new BadRequestError(
        "Card and QR payments require a transaction reference of at least 6 characters.",
      );
    }
  }

  const paidPoisha = payments.reduce(
    (sum, payment) =>
      sum + (payment.method === "due" ? 0 : toPoisha(payment.amount ?? 0)),
    0,
  );

  const duePoisha = payments.reduce(
    (sum, payment) =>
      sum + (payment.method === "due" ? toPoisha(payment.amount ?? 0) : 0),
    0,
  );

  if (duePoisha > 0 && customerId === null) {
    throw new NotFoundError("Due payment requires a customer.");
  }

  if (paidPoisha + duePoisha !== toPoisha(finalTotal)) {
    throw new NotFoundError(
      "Received payments plus due must equal the final total.",
    );
  }

  const cash = payments.find((p) => p.method === "cash");

  if (
    cash?.tendered !== undefined &&
    toPoisha(cash.tendered) < toPoisha(cash.amount ?? 0)
  ) {
    throw new NotFoundError(
      "Cash tendered is less than the cash payment amount.",
    );
  }

  const change =
    cash?.tendered === undefined
      ? 0
      : roundMoney(cash.tendered - (cash.amount ?? 0));

  return {
    change: Math.max(0, change),
    dueAmount: duePoisha / 100,
    paidAmount: paidPoisha / 100,
  };
}
