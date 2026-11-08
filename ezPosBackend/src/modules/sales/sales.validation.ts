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
import { assertNoDuplicateVariantUnitLines } from "./sales.uom.js";

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
  /** ENTERED quantity — in the selected selling unit (base when no UOM). */
  quantity: number;
  unitPrice: number;
  discount: {
    type: "fixed" | "percentage";
    value: number;
  } | null;
  uomConversionId?: number | null | undefined;
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
  // UOM-aware duplicate guard: the same variant may appear once per
  // DISTINCT packaging unit (Box + Piece in one cart is the point); two
  // lines in the SAME unit remain a client bug.
  assertNoDuplicateVariantUnitLines(items);
  // The same variant CAN legitimately repeat across units — query the
  // distinct set so the existence check stays length-exact.
  const uniqueVariantIds = [...new Set(variantIds)];
  const existingVariants = await tx
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      sellingPrice: productVariants.sellingPrice,
      minSellingPrice: productVariants.minSellingPrice,
      trackingType: products.trackingType,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        inArray(productVariants.id, uniqueVariantIds),
        eq(productVariants.businessId, businessId),
      ),
    )
    .for("update");
  if (existingVariants.length !== uniqueVariantIds.length) {
    const foundIds = new Set(existingVariants.map((v) => v.id));
    const missingIds = uniqueVariantIds.filter((id) => !foundIds.has(id));
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
  opts: { allowNegative?: boolean } = {},
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
  // UOM: a variant may span several cart lines (Box + Piece) — validate the
  // AGGREGATED base quantity per variant against available stock.
  const demandByVariant = new Map<number, number>();
  for (const item of items) {
    demandByVariant.set(
      item.variantId,
      (demandByVariant.get(item.variantId) ?? 0) + item.quantity,
    );
  }
  for (const [variantId, quantity] of demandByVariant) {
    const available = stockMap.get(variantId);
    if (available === undefined) {
      // Offline-originated sales may reference variants never stocked at
      // this location — the atomic upsert-decrement creates the row.
      if (opts.allowNegative) continue;
      throw new NotFoundError(
        `No inventory record exists for variant ${variantId}`,
      );
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new NotFoundError(`Invalid quantity for variant ${variantId}`);
    }
    if (quantity > available && !opts.allowNegative) {
      throw new NotFoundError(
        `Insufficient stock for variant ${variantId}. Available: ${available}`,
      );
    }
  }
  return stockMap;
}
type Payments = {
  method:
    | "cash"
    | "bangla_qr"
    | "card"
    | "due"
    | "store_credit"
    | "loyalty_points"
    | "gift_card";
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

    if (
      payment.method === "gift_card" &&
      (payment.reference ?? "").trim().length < 8
    ) {
      throw new BadRequestError(
        "Gift card payments require the full card code as the reference.",
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
    throw new BadRequestError("Due payment requires a customer.");
  }

  // Store credit and loyalty points are per-customer money — the spend
  // must land on an account.
  if (
    (methods.includes("store_credit") || methods.includes("loyalty_points")) &&
    customerId === null
  ) {
    throw new BadRequestError(
      "Store credit and loyalty payments require a customer on the sale.",
    );
  }

  if (paidPoisha + duePoisha !== toPoisha(finalTotal)) {
    throw new BadRequestError(
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
