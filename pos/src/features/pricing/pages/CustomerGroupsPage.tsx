import { useState } from "react";
import { Users } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { StatusBadge } from "@/components/common/StatusBadge";
import { EmptyState } from "@/components/common/EmptyState";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { formatCurrency } from "@/lib/format";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "@/components/ui/toast";
import { extractApiError } from "../components/RuleDialog";
import {
  useCreateCustomerGroup,
  useCreateGroupPricing,
  useCustomerGroups,
  useDeleteCustomerGroup,
  useDeleteGroupPricing,
  useGroupPricing,
  useUpdateCustomerGroup,
} from "../hooks/usePricing";
import type { CustomerGroup } from "../pricing.types";

/**
 * Customer groups + group pricing (Phase 4 endpoints, Phase 5/6 UI): groups
 * hold members; pricing rows are whole-cart or scoped automatic discounts
 * applied server-side at checkout before promotions and manual discounts.
 */
export function CustomerGroupsPage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("pricing.customer_groups.manage");
  const groupsQuery = useCustomerGroups();

  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<CustomerGroup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomerGroup | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [isActive, setIsActive] = useState(true);

  const [pricingGroupId, setPricingGroupId] = useState<number | null>(null);

  const createGroup = useCreateCustomerGroup();
  const updateGroup = useUpdateCustomerGroup();
  const deleteGroup = useDeleteCustomerGroup();

  function openCreate() {
    setEditingGroup(null);
    setName("");
    setDescription("");
    setIsDefault(false);
    setIsActive(true);
    setGroupDialogOpen(true);
  }

  function openEdit(group: CustomerGroup) {
    setEditingGroup(group);
    setName(group.name);
    setDescription(group.description ?? "");
    setIsDefault(group.isDefault);
    setIsActive(group.isActive);
    setGroupDialogOpen(true);
  }

  async function saveGroup() {
    if (!name.trim()) {
      toast.add({ type: "error", description: "Name is required.", priority: "high" });
      return;
    }
    try {
      if (editingGroup) {
        await updateGroup.mutateAsync({
          id: editingGroup.id,
          payload: { name: name.trim(), description: description || null, isDefault, isActive },
        });
        toast.add({ type: "success", description: "Group updated." });
      } else {
        await createGroup.mutateAsync({
          name: name.trim(),
          description: description || null,
          isDefault,
        });
        toast.add({ type: "success", description: "Group created." });
      }
      setGroupDialogOpen(false);
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not save the group."),
        priority: "high",
      });
    }
  }

  const rows = groupsQuery.data ?? [];

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Customer groups"
        description="Members of a group get its pricing automatically at checkout — walk-ins and group-less customers always pay list prices."
        actions={
          canManage ? (
            <Button onClick={openCreate}>New group</Button>
          ) : undefined
        }
      />
      <Card>
        <CardContent>
          {groupsQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Group</TableHead>
                    <TableHead className="text-right">Members</TableHead>
                    <TableHead className="text-right">Pricing rows</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <EmptyState
                          icon={Users}
                          title="No groups yet"
                          description="Create a group to give its members automatic pricing at checkout."
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((group) => (
                      <TableRow key={group.id}>
                        <TableCell>
                          <span className="font-medium">{group.name}</span>
                          {group.isDefault && <Badge className="ml-2">Default</Badge>}
                          {group.description && (
                            <div className="text-xs text-muted-foreground">{group.description}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{group.memberCount}</TableCell>
                        <TableCell className="text-right tabular-nums">{group.pricingCount}</TableCell>
                        <TableCell>
                          {group.isActive ? (
                            <StatusBadge tone="success">Active</StatusBadge>
                          ) : (
                            <StatusBadge tone="neutral">Inactive</StatusBadge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button variant="outline" size="sm" onClick={() => setPricingGroupId(group.id)}>
                              Pricing
                            </Button>
                            {canManage && (
                              <>
                                <Button variant="outline" size="sm" onClick={() => openEdit(group)}>
                                  Edit
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={deleteGroup.isPending}
                                  onClick={() => setDeleteTarget(group)}
                                >
                                  Delete
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingGroup ? "Edit group" : "New group"}</DialogTitle>
            <DialogDescription>
              Group names are unique per business; one group can be the default.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cg-name">Name</Label>
              <Input id="cg-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cg-desc">Description</Label>
              <Input id="cg-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-2">
              <span className="text-sm">Default group</span>
              <Switch checked={isDefault} onCheckedChange={setIsDefault} />
            </div>
            {editingGroup && (
              <div className="flex items-center justify-between rounded-md border p-2">
                <span className="text-sm">Active</span>
                <Switch checked={isActive} onCheckedChange={setIsActive} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGroupDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void saveGroup()} disabled={createGroup.isPending || updateGroup.isPending}>
              {editingGroup ? "Save changes" : "Create group"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pricingGroupId != null && (
        <GroupPricingDialog
          groupId={pricingGroupId}
          groupName={rows.find((g) => g.id === pricingGroupId)?.name ?? ""}
          canManage={canManage}
          onClose={() => setPricingGroupId(null)}
        />
      )}

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Delete the group "${deleteTarget?.name ?? ""}"?`}
        description="Members lose the group; sale history keeps its snapshots."
        entityName="customer group"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteGroup.mutateAsync(deleteTarget.id);
        }}
      />
    </PageContainer>
  );
}

function GroupPricingDialog({
  groupId,
  groupName,
  canManage,
  onClose,
}: {
  groupId: number;
  groupName: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const pricingQuery = useGroupPricing(groupId);
  const createPricing = useCreateGroupPricing();
  const deletePricing = useDeleteGroupPricing();

  const [type, setType] = useState<"percentage" | "fixed">("percentage");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<"whole" | "category" | "product" | "variant">("whole");
  const [scopeId, setScopeId] = useState("");
  const [minPurchase, setMinPurchase] = useState("");
  const [minQuantity, setMinQuantity] = useState("");
  const [maxDiscount, setMaxDiscount] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [stacksPromotions, setStacksPromotions] = useState(true);

  async function add() {
    if (value === "") {
      toast.add({ type: "error", description: "Discount value is required.", priority: "high" });
      return;
    }
    const scopeIdNum = scopeId === "" ? null : Number(scopeId);
    try {
      await createPricing.mutateAsync({
        groupId,
        payload: {
          categoryId: scope === "category" ? scopeIdNum : null,
          productId: scope === "product" ? scopeIdNum : null,
          variantId: scope === "variant" ? scopeIdNum : null,
          discountType: type,
          discountValue: Number(value),
          minPurchaseAmount: minPurchase === "" ? 0 : Number(minPurchase),
          minQuantity: minQuantity === "" ? null : Number(minQuantity),
          maxDiscountAmount: maxDiscount === "" ? null : Number(maxDiscount),
          validFrom: validFrom || null,
          validTo: validTo || null,
          stacksWithPromotions: stacksPromotions,
        },
      });
      setValue("");
      setScopeId("");
      toast.add({ type: "success", description: "Pricing row added." });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not add the pricing row."),
        priority: "high",
      });
    }
  }

  async function remove(pricingId: number) {
    try {
      await deletePricing.mutateAsync({ groupId, pricingId });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not delete the pricing row."),
        priority: "high",
      });
    }
  }

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Group pricing — {groupName}</DialogTitle>
          <DialogDescription>
            Whole-cart rows discount the entire basket; scoped rows discount the
            matching lines. Applied automatically to this group's members at
            checkout.
          </DialogDescription>
        </DialogHeader>
        {canManage && (
          <div className="grid gap-2 rounded-md border p-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label htmlFor="gp-type">Type</Label>
                <select
                  id="gp-type"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={type}
                  onChange={(e) => setType(e.target.value as typeof type)}
                >
                  <option value="percentage">Percentage</option>
                  <option value="fixed">Fixed amount</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="gp-value">Value {type === "percentage" ? "(%)" : "(৳)"}</Label>
                <Input id="gp-value" type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gp-scope">Scope</Label>
                <select
                  id="gp-scope"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value as typeof scope);
                    setScopeId("");
                  }}
                >
                  <option value="whole">Whole cart</option>
                  <option value="category">Category</option>
                  <option value="product">Product</option>
                  <option value="variant">Variant</option>
                </select>
              </div>
            </div>
            {scope !== "whole" && (
              <div className="space-y-1">
                <Label htmlFor="gp-scope-id">{scope} id</Label>
                <Input id="gp-scope-id" type="number" min="1" value={scopeId} onChange={(e) => setScopeId(e.target.value)} />
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label htmlFor="gp-min-purchase">Min purchase (৳)</Label>
                <Input id="gp-min-purchase" type="number" min="0" value={minPurchase} onChange={(e) => setMinPurchase(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gp-min-qty">Min quantity</Label>
                <Input id="gp-min-qty" type="number" min="1" value={minQuantity} onChange={(e) => setMinQuantity(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gp-max">Max discount (৳)</Label>
                <Input id="gp-max" type="number" min="0" value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-3 items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="gp-from">Valid from</Label>
                <Input id="gp-from" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gp-to">Valid to</Label>
                <Input id="gp-to" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
              </div>
              <Button onClick={() => void add()} disabled={createPricing.isPending}>
                Add row
              </Button>
            </div>
            <div className="flex items-center justify-between rounded-md border p-2">
              <span className="text-sm">Allow promotions to stack with this row</span>
              <Switch checked={stacksPromotions} onCheckedChange={setStacksPromotions} />
            </div>
          </div>
        )}
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                <TableHead>Conditions</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="text-right" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pricingQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={canManage ? 5 : 4}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ) : (pricingQuery.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={canManage ? 5 : 4}>
                    <EmptyState
                      icon={Users}
                      title="No pricing rows for this group yet"
                      description="Add a row above to discount this group's baskets."
                    />
                  </TableCell>
                </TableRow>
              ) : (
                (pricingQuery.data ?? []).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground">{row.scopeLabel}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.discountType === "percentage"
                        ? `${row.discountValue}%`
                        : formatCurrency(row.discountValue)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {row.minPurchaseAmount > 0 && `min ${formatCurrency(row.minPurchaseAmount)}`}
                      {row.minQuantity != null && ` · min qty ${row.minQuantity}`}
                      {row.maxDiscountAmount != null && ` · cap ${formatCurrency(row.maxDiscountAmount)}`}
                      {(row.validFrom || row.validTo) &&
                        ` · ${row.validFrom ?? "…"} → ${row.validTo ?? "…"}`}
                      {row.stacksWithPromotions ? " · stacks with promotions" : " · no promotions"}
                    </TableCell>
                    <TableCell>
                      {row.isActive ? (
                        <StatusBadge tone="success">Active</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">Inactive</StatusBadge>
                      )}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" disabled={deletePricing.isPending} onClick={() => void remove(row.id)}>
                          Delete
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
