import { TableCell, TableRow } from "@/components/ui/table";
import { CategoryTreeNode } from "./CategoryTreeTable";
import { Button } from "@/components/ui/button";
import { ChevronRight, Folder, FolderOpen, MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type CategoryRowProps = {
  node: CategoryTreeNode;

  level: number;

  hasChildren: boolean;

  isExpanded: boolean;

  onToggle: (id: number) => void;

  onEdit: (category: CategoryTreeNode) => void;

  onDelete: (category: CategoryTreeNode) => void;

  onAddChild: (category: CategoryTreeNode) => void;
};

export function CategoryRow({
  node,
  level,
  hasChildren,
  isExpanded,
  onToggle,
  onEdit,
  onDelete,
  onAddChild,
}: CategoryRowProps) {
  return (
    <TableRow>
      <TableCell>
        <div
          className="flex items-center gap-2"
          style={{
            paddingLeft: `${level * 24}px`,
          }}
        >
          {hasChildren ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={() => onToggle(node.id)}
              aria-label={
                isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`
              }
            >
              <ChevronRight
                className={`size-4 transition-transform duration-200 ${
                  isExpanded ? "rotate-90" : ""
                }`}
              />
            </Button>
          ) : (
            <span className="size-7 shrink-0" />
          )}
          {hasChildren ? (
            isExpanded ? (
              <FolderOpen className="size-4 shrink-0" />
            ) : (
              <Folder className="size-4 shrink-0" />
            )
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <span className="truncate font-medium">{node.name}</span>
        </div>
      </TableCell>

      {/* ================================================== */}
      {/* DESCRIPTION */}
      {/* ================================================== */}

      <TableCell className="text-muted-foreground">
        {node.products || "0"}
      </TableCell>

      {/* ================================================== */}
      {/* STATUS */}
      {/* ================================================== */}

      <TableCell>
        <span
          className={
            node.status === "active"
              ? "text-sm text-success"
              : "text-sm text-muted-foreground"
          }
        >
          {node.status === "active" ? "Active" : "Inactive"}
        </span>
      </TableCell>

      {/* ================================================== */}
      {/* ACTIONS */}
      {/* ================================================== */}

      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="icon"
              className="size-8" />}>
              <MoreHorizontal className="size-4" />

              <span className="sr-only">Actions for {node.name}</span>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end">
            {/* Add child */}

            {onAddChild && (
              <DropdownMenuItem onClick={() => onAddChild(node)}>
                Add subcategory
              </DropdownMenuItem>
            )}

            {/* Edit */}

            {onEdit && (
              <DropdownMenuItem onClick={() => onEdit(node)}>
                Edit
              </DropdownMenuItem>
            )}

            {/* Delete */}

            {onDelete && (
              <>
                <DropdownMenuSeparator />

                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onDelete(node)}
                >
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
