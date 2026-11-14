import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Grid } from "lucide-react";
import { InputFile } from "./InputFile";
import {
  inventorySources,
  productStatus,
  trackingType,
} from "../../constants/form-status";
import { SelectOptions } from "./SelectOptions";
import { InventorySourceSelector } from "./InventorySourceSelector";
import { UseFormReturn } from "react-hook-form";
import { ProductTypeInput } from "../../product.schema";
import useProductStore from "../../useProductStore";

export function RightColumnInfoCard({
  form,
  isEditing = false,
}: {
  form: UseFormReturn<ProductTypeInput>;
  isEditing?: boolean;
}) {
  const { productSelectOptions } = useProductStore();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Grid className="text-primary" />
          More Information
        </CardTitle>
        <CardDescription> Additional product details</CardDescription>
      </CardHeader>
      <CardContent>
        {/* image */}
        {!isEditing && (
          <InputFile
            urlName="imageUrl"
            fileName="imageFile"
            form={form}
            label="Default Image"
          />
        )}
        {/* Tracking Type */}
        {!isEditing && (
          <SelectOptions
            options={trackingType}
            label="Tracking Type"
            form={form}
            name="trackingType"
          />
        )}
        {/* status */}
        <SelectOptions
          options={productStatus}
          label="Status"
          form={form}
          name="status"
        />
        {/* inventoryOptions */}
        {!isEditing && (
          <InventorySourceSelector
            form={form}
            inventoryOptions={inventorySources}
          />
        )}
        {/* Supplier */}
        {!isEditing && (
          <SelectOptions
            options={productSelectOptions.suppliers}
            label="Select a supplier"
            form={form}
            name="supplierId"
          />
        )}
        {/* Brand */}
        <SelectOptions
          options={productSelectOptions.brands}
          label="Brand"
          form={form}
          name="brandId"
        />
        {/* Categories */}
        <SelectOptions
          options={productSelectOptions.categories}
          label="Categories"
          form={form}
          name="categoryId"
        />
        {/* Tags */}
        {/* <InputField
              placeholder="Add tags separated by commas"
              label="Tags"
              type="text"
              name="tags"
              form={form}
            /> */}
      </CardContent>
    </Card>
  );
}
