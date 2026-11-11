import { useCallback, useEffect, useRef, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { ArrowLeft, PackagePlus } from "lucide-react";
import { Link, useBlocker, useLocation, useNavigate, useParams } from "react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Spinner } from "@/components/ui/spinner.js";
import {
  ProductTypeInput,
  ProductTypeOutput,
  productSchema,
} from "@/features/products/product.schema.js";
import { defaultValues, withFormDefaults } from "../constants/form-defaults.js";
import { VariantsInfoCard } from "../components/addProductPage/VariantsInfoCard.js";
import { GeneralInfoCard } from "../components/addProductPage/GeneralInfoCard.js";
import { ShippingInfoCard } from "../components/addProductPage/ShippingInfoCard.js";
import { UnitsPackagingCard } from "../components/addProductPage/UnitsPackagingCard.js";
import { RightColumnInfoCard } from "../components/addProductPage/RightColumnInfoCard.js";
import { SaveAndUpdateActionsCard } from "../components/addProductPage/SaveAndUpdateActionsCard.js";
import useProductStore from "@/features/products/useProductStore.js";
import {
  createProductPromiseToast,
  updateProductPromiseToast,
} from "../utils/productPromiseToast.js";
import { getProductForEditApi,
  attachProductImageIfAny,
} from "../product.api.js";
import { getErrorMessage } from "@/utils/getErrorMessage.js";

const ProductStockForm = () => {
  const { id: productId } = useParams();
  const isEditing = productId !== undefined;
  const navigate = useNavigate();
  const location = useLocation();
  const form = useForm<ProductTypeInput, unknown, ProductTypeOutput>({
    defaultValues,
    resolver: zodResolver(productSchema),
    mode: "onBlur",
  });
  const createProduct = useProductStore((state) => state.createProduct);
  const updateProduct = useProductStore((state) => state.updateProduct);
  const [isLoadingProduct, setIsLoadingProduct] = useState(isEditing);
  const [editInventory, setEditInventory] = useState<Record<number, { totalStock: number; batches: { batchNumber: string; expiryDate: string | null; quantityRemaining: number }[]; serialCount: number }>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const isDirty = form.formState.isDirty;
  const isSubmitting = form.formState.isSubmitting;
  const skipNextNavigationBlock = useRef(false);

  // Barcode scan-through (Products page scan → open edit): scroll to and
  // flash the scanned variant row when navigation carried one.
  useEffect(() => {
    const highlightVariantId = (
      location.state as { highlightVariantId?: number } | null
    )?.highlightVariantId;
    if (highlightVariantId === undefined) return;
    window.history.replaceState({}, "");
    const timer = window.setTimeout(() => {
      const row = document.querySelector(
        `[data-variant-id="${highlightVariantId}"]`,
      );
      if (!row) return;
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.add("ring-2", "ring-primary", "ring-offset-2");
      window.setTimeout(
        () =>
          row.classList.remove("ring-2", "ring-primary", "ring-offset-2"),
        2500,
      );
    }, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => {
      if (skipNextNavigationBlock.current) {
        skipNextNavigationBlock.current = false;
        return false;
      }
      return isDirty && currentLocation.pathname !== nextLocation.pathname;
    },
  );

  const loadProduct = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!productId) {
      if (!isCancelled()) setIsLoadingProduct(false);
      return;
    }

    const id = Number(productId);
    if (!Number.isInteger(id) || id < 1) {
      if (!isCancelled()) {
        setLoadError("This product link is invalid. Check the URL and try again.");
        setIsLoadingProduct(false);
      }
      return;
    }

    if (!isCancelled()) {
      setLoadError(null);
      setIsLoadingProduct(true);
    }
    try {
      const product = await getProductForEditApi(id);
      if (isCancelled()) return;
      form.reset(withFormDefaults(product));
      // Phase 7: read-only inventory summary for the edit view (batches,
      // expiry, serial counts — never editable from the form).
      const inventory = Object.fromEntries(
        product.variants.map((variant) => [
          variant.id,
          (variant as { inventory?: unknown }).inventory ?? {
            totalStock: 0,
            batches: [],
            serialCount: 0,
          },
        ]),
      );
      setEditInventory(
        inventory as Record<
          number,
          { totalStock: number; batches: { batchNumber: string; expiryDate: string | null; quantityRemaining: number }[]; serialCount: number }
        >,
      );
    } catch (error: unknown) {
      if (!isCancelled()) setLoadError(getErrorMessage(error));
    } finally {
      if (!isCancelled()) setIsLoadingProduct(false);
    }
  }, [form, productId]);

  useEffect(() => {
    let cancelled = false;
    void loadProduct(() => cancelled);

    return () => {
      cancelled = true;
    };
  }, [loadProduct]);

  useEffect(() => {
    if (!isDirty || isSubmitting) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty, isSubmitting]);

  async function onSubmit(data: ProductTypeOutput) {
    setSubmitError(null);
    try {
      if (productId) {
        const id = Number(productId);
        await updateProductPromiseToast(data, () => updateProduct(id, data));
        // Phase 5: complete the previously dead image flow — a picked File
        // goes through the presign upload now that the product id exists.
        if (data.imageFile) {
          await attachProductImageIfAny(id, data.imageFile);
        }
        form.reset(data);
        skipNextNavigationBlock.current = true;
        navigate("/product");
        return;
      }

      const created = await createProductPromiseToast(data, createProduct);
      // POST /api/product body shape: { data: { productId } }
      const newProductId =
        (created as { data?: { productId?: number } } | undefined)?.data
          ?.productId ?? null;
      if (newProductId !== null && data.imageFile) {
        await attachProductImageIfAny(newProductId, data.imageFile);
      }
      form.reset(defaultValues);
    } catch (error: unknown) {
      setSubmitError(getErrorMessage(error));
    }
  }

  function focusFirstInvalidField() {
    window.requestAnimationFrame(() => {
      const firstInvalidField = document.querySelector<HTMLElement>(
        '[aria-invalid="true"]',
      );
      firstInvalidField?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      firstInvalidField?.focus({ preventScroll: true });
    });
  }

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "variants",
  });

  if (isEditing && (isLoadingProduct || loadError)) {
    return (
      <div className="min-h-screen bg-muted/20 p-4 md:p-8">
        <Card className="mx-auto max-w-3xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PackagePlus className="size-5 text-primary" aria-hidden="true" />
              Edit product
            </CardTitle>
            <CardDescription>
              {loadError
                ? "The product details could not be loaded."
                : "Loading product details…"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-4">
            {isLoadingProduct ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Spinner />
                Loading product details
              </div>
            ) : (
              <>
                <p className="text-sm text-destructive" role="alert">
                  {loadError}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => void loadProduct()}>
                    Try again
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    nativeButton={false}
                    render={<Link to="/product" />}
                  >
                    <ArrowLeft aria-hidden="true" />
                    Back to products
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/20 p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="mt-1 rounded-xl bg-primary/10 p-2.5 text-primary">
              <PackagePlus className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm text-muted-foreground">
                <Link
                  to="/product"
                  className="transition-colors hover:text-foreground"
                >
                  Products
                </Link>
                <span aria-hidden="true"> / </span>
                {isEditing ? "Edit product" : "New product"}
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                {isEditing ? "Edit product" : "Add a product"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {isEditing
                  ? "Update product details and pricing. Use stock adjustment to change on-hand quantities."
                  : "Set up product details, variants, and inventory in one place."}
              </p>
            </div>
          </div>
          {isDirty && (
            <span className="w-fit rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
              Unsaved changes
            </span>
          )}
        </header>

        <form
          onSubmit={form.handleSubmit(onSubmit, focusFirstInvalidField)}
          noValidate
        >
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <GeneralInfoCard form={form} />
              <ShippingInfoCard form={form} />
              <VariantsInfoCard
                fields={fields}
                form={form}
                append={append}
                replace={replace}
                remove={remove}
                isEditing={isEditing}
                inventorySummary={
                  isEditing && productId !== undefined
                    ? editInventory[Number(productId)]
                    : undefined
                }
              />
              {/* Units & Packaging is a post-create step: the backend needs a
                  productId, so create mode shows an informational empty state. */}
              <UnitsPackagingCard
                productId={
                  isEditing && productId !== undefined ? Number(productId) : null
                }
              />
            </div>
            <aside className="space-y-6 lg:sticky lg:top-6">
              <RightColumnInfoCard form={form} isEditing={isEditing} />
              {submitError && (
                <p
                  className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                  role="alert"
                >
                  {submitError}
                </p>
              )}
              <SaveAndUpdateActionsCard
                form={form}
                isEditing={isEditing}
                onCancel={() => navigate("/product")}
              />
            </aside>
          </div>
        </form>
      </div>

      <Dialog
        open={blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.state === "blocked") {
            blocker.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Your product changes haven’t been saved. Leave this page and lose
              those changes?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (blocker.state === "blocked") blocker.reset();
              }}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (blocker.state === "blocked") blocker.proceed();
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ProductStockForm;
