import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Layers3, ListChecks, Trash2 } from "lucide-react";
import { productOptionActions, useProductVariantOptionsQuery } from "../hooks/useProductOptions.js";
import { useEffect, useState } from "react";
import { VariantTypeDialog } from "../components/variants/VariantTypeDialog";
import { VariantOptionDialog } from "../components/variants/VariantOptionDialog";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import type { VariantOptionGroup } from "../product.types";

type DeleteTarget =
  | { kind: "type"; variant: VariantOptionGroup }
  | {
      kind: "option";
      variant: VariantOptionGroup;
      option: VariantOptionGroup["options"][number];
    };

export function VariantManager() {
  const { deleteVariantType, deleteVariantOption } = productOptionActions;
  const productVariantOptions = useProductVariantOptionsQuery().data ?? [];
  const [activeId, setActiveId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  useEffect(() => {
    if (productVariantOptions.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (
      activeId === null ||
      !productVariantOptions.some((variant) => variant.typeId === activeId)
    ) {
      setActiveId(productVariantOptions[0].typeId);
    }
  }, [activeId, productVariantOptions]);

  const activeVariant = productVariantOptions.find(
    (variant) => variant.typeId === activeId,
  );

  return (
    <div className="p-5 space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Layers3 className="size-5 text-primary" />
            Variants
          </CardTitle>
          <CardDescription>
            Organize product variant types and option values for your catalog.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
            <Card className="border-dashed bg-muted/20">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Layers3 className="size-4 text-muted-foreground" />
                  Variant Types
                </CardTitle>
                <CardAction>
                  <VariantTypeDialog />
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-2">
                {productVariantOptions.length === 0 ? (
                  <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No variant types added yet.
                  </div>
                ) : (
                  productVariantOptions.map((variant) => {
                    const active = activeId === variant.typeId;
                    return (
                      <div
                        key={variant.typeId}
                        className={[
                          "flex items-center justify-between gap-2 rounded-xl border px-3 py-2 transition-colors",
                          active
                            ? "border-primary bg-primary/5"
                            : "hover:bg-muted/40",
                        ].join(" ")}
                      >
                        <button
                          type="button"
                          onClick={() => setActiveId(variant.typeId)}
                          className="flex flex-1 items-center justify-between text-left"
                        >
                          <span className="font-medium">{variant.typeName}</span>
                          <Badge variant="secondary">{variant.options.length}</Badge>
                        </button>
                        <div className="flex items-center gap-1">
                          <VariantTypeDialog variant={variant} />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setDeleteTarget({ kind: "type", variant })}
                            aria-label={`Delete ${variant.typeName}`}
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>

            <Card className="border-dashed bg-muted/20">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ListChecks className="size-4 text-muted-foreground" />
                  {activeVariant ? `${activeVariant.typeName} Options` : "Option Manager"}
                </CardTitle>
                <CardAction>
                  {activeVariant && (
                    <VariantOptionDialog activeVariant={activeVariant} />
                  )}
                </CardAction>
              </CardHeader>
              <CardContent>
                {!activeVariant ? (
                  <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
                    Select a variant type to manage its available options.
                  </div>
                ) : activeVariant.options.length === 0 ? (
                  <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                    No options added yet. Start with your first variant value.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {activeVariant.options.map((option) => (
                      <div
                        key={option.optionId}
                        className="flex items-center justify-between gap-3 rounded-xl border bg-background px-3 py-2"
                      >
                        <span className="font-medium">{option.value}</span>
                        <div className="flex items-center gap-1">
                          <VariantOptionDialog
                            activeVariant={activeVariant}
                            option={option}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() =>
                              setDeleteTarget({
                                kind: "option",
                                variant: activeVariant,
                                option,
                              })
                            }
                            aria-label={`Delete ${option.value}`}
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>
      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={
          deleteTarget?.kind === "type"
            ? "Delete variant type"
            : "Delete variant option"
        }
        entityName={
          deleteTarget?.kind === "type" ? "Variant type" : "Variant option"
        }
        description={
          deleteTarget?.kind === "type"
            ? `This will delete all ${deleteTarget.variant.options.length} option(s) in “${deleteTarget.variant.typeName}” first, then delete the type. Options used by products must be unassigned before deletion.`
            : `Delete “${deleteTarget?.kind === "option" ? deleteTarget.option.value : ""}” from “${deleteTarget?.variant.typeName ?? ""}”? Options used by products must be unassigned first.`
        }
        onConfirm={async () => {
          if (!deleteTarget) return;
          if (deleteTarget.kind === "type") {
            await deleteVariantType(deleteTarget.variant.typeId);
          } else {
            await deleteVariantOption(deleteTarget.option.optionId);
          }
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
