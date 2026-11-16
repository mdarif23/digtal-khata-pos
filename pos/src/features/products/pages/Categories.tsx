import { useMemo, useState } from "react";
import {
  CategoryTreeNode,
  CategoryTreeTable,
} from "../components/categories/CategoryTreeTable";
import { AddCategoryDialog } from "../components/categories/AddCategoryDialog";
import { EntityListLayout } from "@/components/common/EntityListLayout";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { productOptionActions, EMPTY_SELECT_OPTIONS, useProductSelectOptionsQuery } from "../hooks/useProductOptions.js";

type CategoryRecord = {
  value: number;
  label: string;
  parentCategoryId: number | null;
  description: string | null;
  status: "active" | "inactive";
  productCount: number;
};

function buildCategoryTree(categories: CategoryRecord[]): CategoryTreeNode[] {
  const byId = new Map<number, CategoryTreeNode>();
  const rootNodes: CategoryTreeNode[] = [];

  for (const category of categories) {
    byId.set(category.value, {
      id: category.value,
      name: category.label,
      products: category.productCount,
      status: category.status,
      children: [],
    });
  }

  for (const category of categories) {
    const node = byId.get(category.value);
    if (!node) continue;
    if (category.parentCategoryId === null || !byId.has(category.parentCategoryId)) {
      rootNodes.push(node);
      continue;
    }
    const parent = byId.get(category.parentCategoryId);
    if (parent) {
      parent.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  return rootNodes;
}

export function Categories() {
  const { deleteCategory } = productOptionActions;
  const productSelectOptions = useProductSelectOptionsQuery().data ?? EMPTY_SELECT_OPTIONS;
  const [searchValue, setSearchValue] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">(
    "all",
  );
  const [editingCategory, setEditingCategory] = useState<CategoryTreeNode | null>(null);
  const [categoryToDelete, setCategoryToDelete] =
    useState<CategoryTreeNode | null>(null);

  const categoryTree = useMemo(
    () => buildCategoryTree(productSelectOptions.categories),
    [productSelectOptions.categories],
  );

  const filteredNodes = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    const filterNode = (node: CategoryTreeNode): CategoryTreeNode | null => {
      const matchesQuery =
        query.length === 0 || node.name.toLowerCase().includes(query);
      const matchesStatus =
        statusFilter === "all" || node.status === statusFilter;
      const filteredChildren = (node.children || [])
        .map(filterNode)
        .filter(Boolean) as CategoryTreeNode[];

      const isIncluded = matchesQuery && matchesStatus;
      if (isIncluded) {
        return { ...node, children: filteredChildren };
      }
      if (filteredChildren.length > 0) {
        return { ...node, children: filteredChildren };
      }
      return null;
    };

    return categoryTree
      .map(filterNode)
      .filter(Boolean) as CategoryTreeNode[];
  }, [categoryTree, searchValue, statusFilter]);

  const handleEdit = (category: CategoryTreeNode) => {
    setEditingCategory(category);
  };

  const handleDelete = (category: CategoryTreeNode) => {
    setCategoryToDelete(category);
  };

  const handleAddChild = (category: CategoryTreeNode) => {
    setEditingCategory({
      ...category,
      name: category.name,
      status: category.status,
      children: category.children,
      products: category.products,
    });
  };

  return (
    <>
      <EntityListLayout
        title="Categories"
        description="Manage your product categories and hierarchy."
        action={<AddCategoryDialog />}
        searchValue={searchValue}
        onSearchChange={setSearchValue}
        resultCount={filteredNodes.length}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
      >
        <CategoryTreeTable
          nodes={filteredNodes}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onAddChild={handleAddChild}
        />
      </EntityListLayout>
      {editingCategory && (
        <AddCategoryDialog
          existingCategory={{
            id: editingCategory.id,
            name: editingCategory.name,
            description: productSelectOptions.categories.find(
              (category) => category.value === editingCategory.id,
            )?.description ?? "",
            parentCategoryId:
              productSelectOptions.categories.find(
                (category) => category.value === editingCategory.id,
              )?.parentCategoryId ?? null,
            status: editingCategory.status,
          }}
          open={Boolean(editingCategory)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setEditingCategory(null);
          }}
        />
      )}
      <ConfirmDeleteDialog
        open={Boolean(categoryToDelete)}
        onOpenChange={(open) => !open && setCategoryToDelete(null)}
        title="Delete category"
        entityName="Category"
        description={
          categoryToDelete
            ? `Delete “${categoryToDelete.name}”? Categories with products or subcategories must be cleared before they can be deleted.`
            : "Delete this category?"
        }
        onConfirm={async () => {
          if (!categoryToDelete) return;
          await deleteCategory(categoryToDelete.id);
          setCategoryToDelete(null);
        }}
      />
    </>
  );
}
