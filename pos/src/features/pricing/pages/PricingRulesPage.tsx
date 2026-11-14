import { useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { StatusBadge } from "@/components/common/StatusBadge";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { formatCurrency } from "@/lib/format";
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
  const [deleteTarget, setDeleteTarget] = useState<PricingRule | null>(null);
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
            label: `${p.name}${v.sku ? ` — ${v.sku}` : ""} (${formatCurrency(v.sellingPrice)})`,
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

  const rows = rulesQuery.data ?? [];
  const sorted = useMemo(
    () => [...rows].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.id - b.id),
    [rows],
  );

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Pricing rules"
        description="Precedence: variant rule › product rule › nearest category rule › global rule › business default. At most one ACTIVE rule per scope — duplicates are rejected. Rules describe how to calculate; nothing here changes a price until you apply it on the Product Pricing page."
        actions={
          canManage ? (
            <Button onClick={() => void openCreate()}>New rule</Button>
          ) : undefined
        }
      />
      <Card>
        <CardContent>
          {rulesQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Scope</TableHead>
                    <TableHead>Rule</TableHead>
                    <TableHead>Status</TableHead>
                    {canManage && <TableHead className="text-right" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={canManage ? 4 : 3}>
                        <EmptyState
                          icon={ScrollText}
                          title="No pricing rules yet"
                          description="Every product falls back to the business default in Pricing Settings."
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    sorted.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell>
                          <Badge variant="outline">{rule.scope}</Badge>
                          <span className="ml-2 text-muted-foreground">
                            {rule.scopeLabel}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono tabular-nums">
                          {rule.method === "fixed"
                            ? `Fixed ${formatCurrency(rule.fixedPrice ?? 0)}`
                            : `${rule.method === "markup" ? "Markup" : "Margin"} ${rule.percentage}%`}
                        </TableCell>
                        <TableCell>
                          {rule.isActive ? (
                            <StatusBadge tone="success">Active</StatusBadge>
                          ) : (
                            <StatusBadge tone="neutral">Inactive</StatusBadge>
                          )}
                        </TableCell>
                        {canManage && (
                          <TableCell className="text-right">
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
                                onClick={() => setDeleteTarget(rule)}
                              >
                                Delete
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
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

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Delete the ${deleteTarget?.scope.toLowerCase() ?? ""} rule "${deleteTarget?.scopeLabel ?? ""}"?`}
        description="The rule stops applying immediately; price history keeps its references."
        entityName="pricing rule"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteRule.mutateAsync(deleteTarget.id);
        }}
      />
    </PageContainer>
  );
}
