import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "@/components/ui/toast";
import axios from "@/api/axios";
import { extractApiError, RuleDialog } from "../components/RuleDialog";
import {
  useDeleteRule,
  usePricingRules,
  useUpdateRule,
} from "../hooks/usePricing";
import type { PricingRule } from "../pricing.types";

interface CategoryOption {
  value: number;
  label: string;
}

interface ProductsListItem {
  id: number;
  name: string;
  variants: { id: number; sku: string; sellingPrice: number }[];
}

/**
 * Pricing rule management (global + category + product + variant scopes).
 * Rules are configuration only — applying a rule's recommendation to the
 * effective selling price happens on the Product Pricing page.
 */
export function PricingRulesPage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("pricing.manage");
  const rulesQuery = usePricingRules();
  const updateRule = useUpdateRule();
  const deleteRule = useDeleteRule();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<PricingRule | null>(null);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [products, setProducts] = useState<
    { productId: number; label: string; variants: { variantId: number; label: string }[] }[]
  >([]);

  async function openCreate() {
    await loadPickers();
    setEditingRule(null);
    setDialogOpen(true);
  }

  async function openEdit(rule: PricingRule) {
    await loadPickers();
    setEditingRule(rule);
    setDialogOpen(true);
  }

  async function loadPickers() {
    try {
      const [optionsRes, productsRes] = await Promise.all([
        axios.get<{ categories: CategoryOption[] }>("/product/select-options"),
        axios.get<ProductsListItem[]>("/products"),
      ]);
      setCategories(optionsRes.data.categories ?? []);
      setProducts(
        (Array.isArray(productsRes.data) ? productsRes.data : []).map((p) => ({
          productId: p.id,
          label: p.name,
          variants: (p.variants ?? []).map((v) => ({
            variantId: v.id,
            label: `${p.name}${v.sku ? ` — ${v.sku}` : ""} (৳${v.sellingPrice})`,
          })),
        })),
      );
    } catch {
      toast.add({
        type: "error",
        description: "Could not load categories/products for the picker.",
        priority: "high",
      });
    }
  }

  async function toggleActive(rule: PricingRule) {
    try {
      await updateRule.mutateAsync({
        id: rule.id,
        payload: { isActive: !rule.isActive },
      });
      toast.add({
        type: "success",
        description: rule.isActive ? "Rule deactivated." : "Rule activated.",
      });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not update the rule."),
        priority: "high",
      });
    }
  }

  async function remove(rule: PricingRule) {
    if (!window.confirm(`Delete the ${rule.scope.toLowerCase()} rule "${rule.scopeLabel}"?`)) {
      return;
    }
    try {
      await deleteRule.mutateAsync(rule.id);
      toast.add({ type: "success", description: "Rule deleted. Price history keeps its references." });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not delete the rule."),
        priority: "high",
      });
    }
  }

  const rows = rulesQuery.data ?? [];
  const sorted = useMemo(
    () => [...rows].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.id - b.id),
    [rows],
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Pricing rules</CardTitle>
            <CardDescription>
              Precedence: variant rule › product rule › nearest category rule ›
              global rule › business default. At most one ACTIVE rule per
              scope — duplicates are rejected. Rules describe how to calculate;
              nothing here changes a price until you apply it on the Product
              Pricing page.
            </CardDescription>
          </div>
          {canManage && (
            <Button onClick={() => void openCreate()}>New rule</Button>
          )}
        </CardHeader>
        <CardContent>
          {rulesQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No pricing rules yet — every product falls back to the business
              default in Pricing Settings.
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Scope</th>
                    <th className="p-2 font-medium">Rule</th>
                    <th className="p-2 font-medium">Status</th>
                    {canManage && <th className="p-2" />}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((rule) => (
                    <tr key={rule.id} className="border-t">
                      <td className="p-2">
                        <Badge variant="outline">{rule.scope}</Badge>
                        <span className="ml-2 text-muted-foreground">
                          {rule.scopeLabel}
                        </span>
                      </td>
                      <td className="p-2 font-mono">
                        {rule.method === "fixed"
                          ? `Fixed ৳${rule.fixedPrice}`
                          : `${rule.method === "markup" ? "Markup" : "Margin"} ${rule.percentage}%`}
                      </td>
                      <td className="p-2">
                        {rule.isActive ? (
                          <Badge>Active</Badge>
                        ) : (
                          <Badge variant="secondary">Inactive</Badge>
                        )}
                      </td>
                      {canManage && (
                        <td className="p-2 text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button variant="outline" size="sm" onClick={() => void openEdit(rule)}>
                              Edit
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={updateRule.isPending}
                              onClick={() => void toggleActive(rule)}
                            >
                              {rule.isActive ? "Deactivate" : "Activate"}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={deleteRule.isPending}
                              onClick={() => void remove(rule)}
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <RuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rule={editingRule}
        categories={categories}
        products={products}
      />
    </div>
  );
}
