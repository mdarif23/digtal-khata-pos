import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InputField } from "./InputField";
import { Package } from "lucide-react";
import { SelectOptions } from "./SelectOptions";
import { productTypes } from "../../constants/form-status";
import { UseFormReturn } from "react-hook-form";
import { ProductTypeInput } from "../../product.schema";
import { EMPTY_SELECT_OPTIONS, useProductSelectOptionsQuery } from "../../hooks/useProductOptions.js";

export function GeneralInfoCard({
  form,
}: {
  form: UseFormReturn<ProductTypeInput>;
}) {
  const productSelectOptions = useProductSelectOptionsQuery().data ?? EMPTY_SELECT_OPTIONS;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package className="text-blue-500" />
          General Information
        </CardTitle>
        <CardDescription>Basic product details</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {/* Product Name */}
        <InputField
          placeholder="Enter Product Name"
          label="Product Name"
          type="text"
          name="name"
          form={form}
        />
        {/* Product Unit */}
        <SelectOptions
          options={productSelectOptions.units}
          label="Product Unit"
          form={form}
          name="unitId"
        />
        {/* Product Type */}
        <SelectOptions
          options={productTypes}
          label="Product Type"
          form={form}
          name="productType"
        />

        {/* Product Description */}
        <div className="col-span-1 md:col-span-2 lg:col-span-3">
          <InputField
            placeholder="Enter your message"
            label="Product Description"
            type="textArea"
            name="description"
            form={form}
          />
        </div>
      </CardContent>
    </Card>
  );
}
