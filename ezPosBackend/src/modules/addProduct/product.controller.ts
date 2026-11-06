import type { Request, Response } from "express";
import * as productService from "./product.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { sendSafeError } from "../../utils/safeError.js";
import { publishRealtime } from "../realtime/realtime.service.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { stripCostData } from "../../rbac/sanitize.js";
import { productSchema } from "./schemas/product.schema.js";
import { addCategorySchema } from "./schemas/category.schema.js";
import { brandSchema } from "./schemas/brand.schema.js";
import { unitSchema } from "./schemas/unit.schema.js";
import {
  variantOptionSchema,
  variantOptionValueSchema,
  variantTypeSchema,
} from "./schemas/variant.schema.js";

function getEntityId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ message: "Invalid entity ID" });
    return null;
  }
  return id;
}

export async function getProductSelectOptions(req: Request, res: Response) {
  try {
    res.json(await productService.getProductSelectOptions(getBusinessId(req)));
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load product options.");
  }
}
export async function getProductVariantOptions(req: Request, res: Response) {
  try {
    res.json(await productService.getProductVariantOptions(getBusinessId(req)));
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load variant options.");
  }
}
export async function createProduct(req: Request, res: Response) {
  try {
    const result = productSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid product data",
        errors: result.error.flatten(),
      });
    }
    const product = await productService.createProduct(
      getBusinessId(req),
      getLocationId(req),
      result.data,
    );
    publishRealtime(getBusinessId(req), null, {
      kind: "product.changed",
      locationId: null,
    });
    return res.status(201).json({
      message: "Product created successfully",
      data: product,
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the product.");
  }
}
export async function getProductForEdit(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: "Invalid product ID" });
  }

  try {
    const data = await productService.getProductForEdit(getBusinessId(req), id);
    return res.json(
      callerHasPermission(req, "products.view_cost")
        ? data
        : stripCostData(data),
    );
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the product.");
  }
}
export async function updateProduct(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: "Invalid product ID" });
  }

  try {
    const result = productSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid product data",
        errors: result.error.flatten(),
      });
    }
    const product = await productService.updateProduct(
      getBusinessId(req),
      getLocationId(req),
      id,
      result.data,
    );
    // Catalog edits matter to every terminal's product cache — signal
    // business-wide (after the write committed).
    publishRealtime(getBusinessId(req), null, {
      kind: "product.changed",
      locationId: null,
    });
    return res.json({
      message: "Product updated successfully",
      data: product,
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the product.");
  }
}
export async function createCategory(req: Request, res: Response) {
  try {
    const result = addCategorySchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid category data",
        errors: result.error.flatten(),
      });
    }
    const category = await productService.createCategory(
      getBusinessId(req),
      result.data,
    );
    return res.status(201).json({
      message: "Category created successfully",
      data: category,
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the category.");
  }
}
export async function updateCategory(req: Request, res: Response) {
  const id = getEntityId(req, res);
  if (id === null) return;
  const result = addCategorySchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      message: "Invalid category data",
      errors: result.error.flatten(),
    });
  }
  try {
    const category = await productService.updateCategory(
      getBusinessId(req),
      id,
      result.data,
    );
    return res.json({ message: "Category updated successfully", data: category });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the category.");
  }
}
export async function deleteCategory(req: Request, res: Response) {
  const id = getEntityId(req, res);
  if (id === null) return;
  try {
    await productService.deleteCategory(getBusinessId(req), id);
    return res.json({ message: "Category deleted successfully" });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to delete the category.");
  }
}
export async function createBrand(req: Request, res: Response) {
  try {
    const result = brandSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid brand data",
        errors: result.error.flatten(),
      });
    }
    const brand = await productService.createBrand(getBusinessId(req), result.data);
    return res.status(201).json({
      message: "Brand created successfully",
      data: brand,
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the brand.");
  }
}
export async function updateBrand(req: Request, res: Response) {
  const id = getEntityId(req, res);
  if (id === null) return;
  const result = brandSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      message: "Invalid brand data",
      errors: result.error.flatten(),
    });
  }
  try {
    const brand = await productService.updateBrand(
      getBusinessId(req),
      id,
      result.data,
    );
    return res.json({ message: "Brand updated successfully", data: brand });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the brand.");
  }
}
export async function deleteBrand(req: Request, res: Response) {
  const id = getEntityId(req, res);
  if (id === null) return;
  try {
    await productService.deleteBrand(getBusinessId(req), id);
    return res.json({ message: "Brand deleted successfully" });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to delete the brand.");
  }
}
export async function createUnit(req: Request, res: Response) {
  try {
    const result = unitSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid unit data",
        errors: result.error.flatten(),
      });
    }
    const unit = await productService.createUnit(getBusinessId(req), result.data);
    return res.status(201).json({
      message: "Unit created successfully",
      data: unit,
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the unit.");
  }
}
export async function updateUnit(req: Request, res: Response) {
  const id = getEntityId(req, res);
  if (id === null) return;
  const result = unitSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      message: "Invalid unit data",
      errors: result.error.flatten(),
    });
  }
  try {
    const unit = await productService.updateUnit(getBusinessId(req), id, result.data);
    return res.json({ message: "Unit updated successfully", data: unit });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the unit.");
  }
}
export async function deleteUnit(req: Request, res: Response) {
  const id = getEntityId(req, res);
  if (id === null) return;
  try {
    await productService.deleteUnit(getBusinessId(req), id);
    return res.json({ message: "Unit deleted successfully" });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to delete the unit.");
  }
}
export async function createVariantType(req: Request, res: Response) {
  try {
    const result = variantTypeSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid Variant Type data",
        errors: result.error.flatten(),
      });
    }
    const variantType = await productService.createVariantType(
      getBusinessId(req),
      result.data,
    );
    return res.status(201).json({
      message: "Variant Type created successfully",
      data: variantType,
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the variant type.");
  }
}
export async function updateVariantType(req: Request, res: Response) {
  const id = getEntityId(req, res);
  if (id === null) return;
  const result = variantTypeSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      message: "Invalid variant type data",
      errors: result.error.flatten(),
    });
  }
  try {
    const variantType = await productService.updateVariantType(
      getBusinessId(req),
      id,
      result.data,
    );
    return res.json({
      message: "Variant type updated successfully",
      data: variantType,
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the variant type.");
  }
}
export async function deleteVariantType(req: Request, res: Response) {
  const id = getEntityId(req, res);
  if (id === null) return;
  try {
    await productService.deleteVariantType(getBusinessId(req), id);
    return res.json({ message: "Variant type deleted successfully" });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to delete the variant type.");
  }
}
export async function createVariantOption(req: Request, res: Response) {
  try {
    const result = variantOptionSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid Variant Option data",
        errors: result.error.flatten(),
      });
    }
    const variantOptions = await productService.createVariantOption(
      getBusinessId(req),
      result.data,
    );
    return res.status(201).json({
      message: "Variant Options created successfully",
      data: variantOptions,
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the variant options.");
  }
}

export async function updateVariantOption(req: Request, res: Response) {
  const id = getEntityId(req, res);
  if (id === null) return;
  const result = variantOptionValueSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      message: "Invalid variant option data",
      errors: result.error.flatten(),
    });
  }
  try {
    const option = await productService.updateVariantOption(
      getBusinessId(req),
      id,
      result.data,
    );
    return res.json({
      message: "Variant option updated successfully",
      data: option,
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the variant option.");
  }
}

export async function deleteVariantOption(req: Request, res: Response) {
  const id = getEntityId(req, res);
  if (id === null) return;
  try {
    await productService.deleteVariantOption(getBusinessId(req), id);
    return res.json({ message: "Variant option deleted successfully" });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to delete the variant option.");
  }
}
