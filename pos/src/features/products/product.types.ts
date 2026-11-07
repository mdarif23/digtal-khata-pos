import {
  ProductType,
  ProductTypeInput,
  ProductTypeOutput,
} from "@/features/products/product.schema";
import {
  FieldPath,
  FieldArrayWithId,
  UseFieldArrayAppend,
  UseFieldArrayRemove,
  UseFieldArrayReplace,
  UseFormReturn,
} from "react-hook-form";
import { AddCategorySchemaType } from "./addCategory.schema";
import { BrandSchemaType } from "./brand.schema";
import { UnitSchemaType } from "./schemas/unit.schema";
import {
  VariantOptionSchemaType,
  VariantTypeSchemaType,
} from "./schemas/variant.schema";
export type CreateProductResponse = {
  success: boolean;
  message: string;
  data: {
    productId: number;
  };
};
export type CreateEntityResponse = {
  success: boolean;
  message: string;
  data: {
    value: number;
    label: string;
  };
};
export type BrandOption = {
  value: number;
  label: string;
  status: "active" | "inactive";
  productCount: number;
};
export type UnitOption = {
  value: number;
  label: string;
  abbreviation: string;
  productCount: number;
};
export type CategoryOption = {
  value: number;
  label: string;
  parentCategoryId: number | null;
  description: string | null;
  status: "active" | "inactive";
  productCount: number;
};
export type VariantTypeData = {
  id: number;
  name: string;
};
export type VariantOptionData = {
  id: number;
  variantTypeId: number;
  value: string;
};
export type ApiResponse<T> = {
  success: boolean;
  message: string;
  data: T;
};
export type StockAdjustmentInput = {
  newQuantity: number;
  reason: "count_correction" | "damaged" | "expired" | "lost" | "found";
  batchNumber?: string;
  unitCost?: number;
  serialNumbers?: string[];
};
export type StockAdjustmentResult = {
  variantId: number;
  previousQuantity: number;
  quantity: number;
  change: number;
};
export type { ProductType };

export interface ProductStoreType {
  products: ProductType[];
  productSelectOptions: {
    brands: BrandOption[];
    units: UnitOption[];
    categories: CategoryOption[];
    suppliers: {
      value: number;
      label: string;
    }[];
  };
  productVariantOptions: VariantOptionGroup[];
  loading: boolean;
  error: string | null;
  getProducts: () => void;
  returnVariantStock: (variantId: number, quantity: number) => void;
  takeVariantStock: (variantId: number, quantity: number) => void;
  adjustVariantStock: (
    variantId: number,
    data: StockAdjustmentInput,
  ) => Promise<StockAdjustmentResult>;
  getProductSelectOptions: () => void;
  getProductVariantOptions: () => void;
  createProduct: (data: ProductTypeOutput) => Promise<CreateProductResponse>;
  updateProduct: (id: number, data: ProductTypeOutput) => Promise<void>;
  createCategory: (
    data: AddCategorySchemaType,
  ) => Promise<CreateEntityResponse>;
  updateCategory: (
    id: number,
    data: AddCategorySchemaType,
  ) => Promise<CreateEntityResponse>;
  deleteCategory: (id: number) => Promise<void>;
  createBrand: (data: BrandSchemaType) => Promise<CreateEntityResponse>;
  updateBrand: (
    id: number,
    data: BrandSchemaType,
  ) => Promise<CreateEntityResponse>;
  deleteBrand: (id: number) => Promise<void>;
  createUnit: (data: UnitSchemaType) => Promise<CreateEntityResponse>;
  updateUnit: (
    id: number,
    data: UnitSchemaType,
  ) => Promise<CreateEntityResponse>;
  deleteUnit: (id: number) => Promise<void>;
  createVariantType: (
    data: VariantTypeSchemaType,
  ) => Promise<ApiResponse<VariantTypeData>>;
  updateVariantType: (
    id: number,
    data: VariantTypeSchemaType,
  ) => Promise<ApiResponse<VariantTypeData>>;
  deleteVariantType: (id: number) => Promise<void>;
  createVariantOption: (
    data: VariantOptionSchemaType,
  ) => Promise<ApiResponse<VariantOptionData>>;
  updateVariantOption: (
    id: number,
    value: string,
  ) => Promise<ApiResponse<VariantOptionData>>;
  deleteVariantOption: (id: number) => Promise<void>;
}
export interface SelectOptionsProps {
  options: {
    value: number | string;
    label: string;
    title?: string;
  }[];
  label: string;
  form: UseFormReturn<ProductTypeInput>;
  name: FieldPath<ProductTypeInput>;
}
export interface InputFieldProps {
  placeholder: string;
  label?: string;
  name: FieldPath<ProductTypeInput>;
  type: "text" | "number" | "textArea";
  form: UseFormReturn<ProductTypeInput>;
  disabled?: boolean;
  numberFormat?: "currency" | "quantity";
}
export interface ExpiryDatePickerProps {
  form: UseFormReturn<ProductTypeInput>;
  index: number;
}
export interface AllVariantsType {
  color: string;
  size: string;
}
export interface ProductInfoInputProps {
  form: UseFormReturn<ProductTypeInput>;
  variantIndex: number;
  remove?: UseFieldArrayRemove;
  canRemoveVariant?: boolean;
  canEditImages?: boolean;
  canEditStock?: boolean;
  inventorySummary?: {
    totalStock: number;
    batches: { batchNumber: string; expiryDate: string | null; quantityRemaining: number }[];
    serialCount: number;
  } | null;
}
export interface AccordionCardProps {
  form: UseFormReturn<ProductTypeInput>;
  append: UseFieldArrayAppend<ProductTypeInput, "variants">;
  replace: UseFieldArrayReplace<ProductTypeInput, "variants">;
  remove: UseFieldArrayRemove;
  fields: FieldArrayWithId<ProductTypeInput, "variants">[];
  isEditing?: boolean;
  inventorySummary?: ProductInfoInputProps["inventorySummary"];
}
export interface VariantRowProps {
  form: UseFormReturn<ProductTypeInput>;
  append: UseFieldArrayAppend<ProductTypeInput, "variants">;
  remove: UseFieldArrayRemove;
  replace: UseFieldArrayReplace<ProductTypeInput, "variants">;
  allVariants: GeneratedVariant[];
  onForgetVariant: (variant: ProductTypeInput["variants"][number]) => void;
  isEditing?: boolean;
  inventorySummary?: ProductInfoInputProps["inventorySummary"];
}
export interface InputFileProps {
  urlName: FieldPath<ProductTypeInput>;
  fileName: FieldPath<ProductTypeInput>;
  form: UseFormReturn<ProductTypeInput>;
  label: string;
}
export interface InventorySourceSelectorProps {
  form: UseFormReturn<ProductTypeInput>;
  inventoryOptions: {
    value: string;
    title: string;
    label: string;
  }[];
}
export type VariantOption = {
  typeId: number;
  typeName: string;
  optionId: number;
  value: string;
};
export type VariantOptionGroup = {
  typeId: number;
  typeName: string;
  options: {
    optionId: number;
    value: string;
  }[];
};
export type GeneratedVariant = {
  options: VariantOption[];
};
export type HasVariantOptions = {
  options?: VariantOption[] | undefined;
};
export type VariantTableRowProps = {
  variant: GeneratedVariant;
  form: UseFormReturn<ProductTypeInput>;
  remove: UseFieldArrayRemove;
  expanded: string | null;
  setExpanded: React.Dispatch<React.SetStateAction<string | null>>;
  onAddVariant: (variant: GeneratedVariant) => void;
  onRemoveVariant: (variantIndex: number) => void;
  isEditing?: boolean;
  inventorySummary?: ProductInfoInputProps["inventorySummary"];
};