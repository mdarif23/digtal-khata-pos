import { ProductTypeInput, ProductVariantType } from "../product.schema";
import { GeneratedVariant } from "../product.types";


export const defaultValues: ProductTypeInput = {
  name: "",
  categoryId: null,
  brandId: null,
  unitId: null,
  description: "",
  productType: "physical",
  hasVariants: false,
  trackingType: null,
  status: "active",
  imageUrl: null,
  imageFile: null,
  supplierId: null,
  source: "purchase",
  shippingWeightKg: null,
  shippingLengthCm: null,
  shippingWidthCm: null,
  shippingHeightCm: null,
  packagingInstructions: "",
  handlingInstructions: "",
  isFragile: false,
  variants: [
    {
      sku: "",
      barcode: "",
      sellingPrice: 0,
      alertQuantity: 0,
      isDefault: true,
      status: "active",
      imageUrl: null,
      imageFile: null,
      purchasePrice: 0,
      quantity: 0,
      weight: null,
      weightUnit: null,
      expiryDate: null,
      batchNumber: "",
      serialNumbers: [],
    },
  ],
};

/**
 * Edit mode: backend payloads omit optional keys (shipping dims, handling
 * instructions, isFragile). Filling them from `defaultValues` keeps form
 * values deep-equal to defaults so the dirty guard doesn't fire on mount.
 */
export const withFormDefaults = (values: ProductTypeInput): ProductTypeInput => ({
  ...defaultValues,
  ...values,
});

export const createVariant = (variant: GeneratedVariant): ProductVariantType => ({
  sku: "",
  barcode: "",
  sellingPrice: 0,
  alertQuantity: 0,
  isDefault: false,
  status: "active",
  imageUrl: null,
  imageFile: null,
  weight: null,
  weightUnit: null,
  batchNumber: "",
  purchasePrice: 0,
  quantity: 0,
  expiryDate: null,
  serialNumbers: [],
  options: variant.options,
});
export const emptyVariant: ProductVariantType = {
  sku: "",
  barcode: "",
  sellingPrice: 0,
  alertQuantity: 0,
  isDefault: true,
  status: "active",
  imageUrl: null,
  imageFile: null,
  weight: null,
  weightUnit: null,
  batchNumber: "",
  purchasePrice: 0,
  quantity: 0,
  expiryDate: null,
  serialNumbers: [],
};
