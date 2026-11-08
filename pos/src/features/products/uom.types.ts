/**
 * Units & Packaging (UOM) contracts — mirrors
 * ezPosBackend/src/modules/uom/uom.admin.service.ts (UomConfigRow) and
 * uom.validation.ts (create/update payloads). The backend stays
 * authoritative; these types only shape the frontend calls.
 */

export type UomStatus = "active" | "inactive";

/** The product's own unitId — the unit stock is always tracked in. */
export interface UomBaseUnit {
  id: number;
  name: string;
  abbreviation: string | null;
}

/** One packaging-unit configuration row (GET …/uom `units[]`). */
export interface UomConfigRow {
  id: number;
  /** Null = product-level row; a number scopes the unit to one variant. */
  variantId: number | null;
  unitId: number;
  unitName: string;
  unitAbbreviation: string | null;
  /** "1 [this unit] = conversionFactor [base unit]". */
  conversionFactor: number;
  isPurchaseEnabled: boolean;
  isSaleEnabled: boolean;
  isDefaultPurchase: boolean;
  isDefaultSale: boolean;
  salePrice: number | null;
  purchasePrice: number | null;
  status: UomStatus;
  /** True when any transaction or package barcode references this row. */
  isLocked: boolean;
  /** base price × factor — shown when the row has no explicit salePrice. */
  derivedSalePrice: number | null;
}

/** GET /api/product/:productId/uom → { data: ProductUomConfig }. */
export interface ProductUomConfig {
  baseUnit: UomBaseUnit | null;
  units: UomConfigRow[];
}

/** POST /api/product/:productId/uom body. */
export interface AddPackagingUnitPayload {
  variantId?: number | null;
  unitId: number;
  conversionFactor: number;
  isPurchaseEnabled?: boolean;
  isSaleEnabled?: boolean;
  isDefaultPurchase?: boolean;
  isDefaultSale?: boolean;
  salePrice?: number | null;
  purchasePrice?: number | null;
}

/** PATCH /api/product/uom/:conversionId body. */
export interface UpdatePackagingUnitPayload {
  conversionFactor?: number;
  isPurchaseEnabled?: boolean;
  isSaleEnabled?: boolean;
  isDefaultPurchase?: boolean;
  isDefaultSale?: boolean;
  salePrice?: number | null;
  purchasePrice?: number | null;
  status?: UomStatus;
}

/** Response envelope of the mutation endpoints: { message, data }. */
export interface UomMutationResponse {
  message: string;
  data: UomConfigRow;
}

/**
 * Raw dialog values before they are coerced into an API payload — number
 * inputs and prices arrive as strings so "" (empty) can mean "unset".
 */
export interface PackagingUnitFormValues {
  unitId: number;
  /** "Contains (qty of base unit)" — factor as typed in the input. */
  contains: string;
  isPurchaseEnabled: boolean;
  isSaleEnabled: boolean;
  isDefaultPurchase: boolean;
  isDefaultSale: boolean;
  salePrice: string;
  purchasePrice: string;
}
