import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
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
import {
  createRoleApi,
  deleteRoleApi,
  getPermissionCatalogApi,
  getRoleUsersApi,
  getRolesApi,
  updateRoleApi,
  type PermissionCatalogEntry,
  type RoleSummary,
} from "../roles.api";
import { PERMISSION_CATALOG } from "@/lib/rbac";
import { refreshSessionContext } from "@/api/axios";

const MODULE_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  pos: "POS",
  sales: "Sales",
  products: "Products",
  purchases: "Purchases",
  inventory: "Inventory",
  customers: "Customers",
  suppliers: "Suppliers",
  expenses: "Expenses",
  reports: "Reports",
  users: "Users & Roles",
  settings: "Settings",
};

interface RoleFormState {
  id: number | null;
  name: string;
  slug: string;
  isSystem: boolean;
  /** The Owner role is displayed read-only: it always keeps full access. */
  readOnly: boolean;
  originalKeys: string[];
  selectedKeys: string[];
}

const EMPTY_FORM: RoleFormState = {
  id: null,
  name: "",
  slug: "",
  isSystem: false,
  readOnly: false,
  originalKeys: [],
  selectedKeys: [],
};

export function RolesPage() {
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<RoleFormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RoleSummary | null>(null);
  const [usersTarget, setUsersTarget] = useState<RoleSummary | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);
  const [roleUsers, setRoleUsers] = useState<
    { userId: number; fullName: string; email: string; isActive: boolean }[]
  >([]);
  const [confirmingSave, setConfirmingSave] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getRolesApi();
      setRoles(data);
    } catch {
      toast.add({ title: "Unable to load roles", type: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Server catalog only (R1-3): a partial client-side fallback would render
  // an incomplete matrix and a save could strip keys the admin thinks they
  // granted. On fetch failure, block editing with an explicit error state.
  const [catalog, setCatalog] = useState<PermissionCatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  useEffect(() => {
    getPermissionCatalogApi()
      .then((entries) => {
        setCatalog(entries);
        setCatalogError(false);
      })
      .catch(() => setCatalogError(true));
  }, []);

  const grouped = useMemo(() => {
    const source: { module: string; entries: PermissionCatalogEntry[] }[] = [];
    if (catalog) {
      const byModule = new Map<string, PermissionCatalogEntry[]>();
      for (const entry of catalog) {
        const mod = entry.module ?? "general";
        (byModule.get(mod) ?? byModule.set(mod, []).get(mod)!).push(entry);
      }
      for (const [mod, entries] of byModule) {
        source.push({ module: mod, entries });
      }
    }
    return source;
  }, [catalog]);

  function openCreate() {
    setFormError(null);
    setForm({ ...EMPTY_FORM, selectedKeys: [] });
  }

  function openEdit(role: RoleSummary) {
    setFormError(null);
    setForm({
      id: role.id,
      name: role.name,
      slug: role.slug,
      isSystem: role.isSystem,
      readOnly: role.slug === "owner",
      originalKeys: role.permissionKeys,
      selectedKeys: role.permissionKeys,
    });
  }

  const removedKeys = form
    ? form.originalKeys.filter((key) => !form.selectedKeys.includes(key))
    : [];

  function toggleKey(key: string) {
    setForm((prev) => {
      if (!prev) return prev;
      const selected = prev.selectedKeys.includes(key)
        ? prev.selectedKeys.filter((k) => k !== key)
        : [...prev.selectedKeys, key];
      return { ...prev, selectedKeys: selected };
    });
  }

  function setModule(moduleKey: string, selected: boolean) {
    setForm((prev) => {
      if (!prev) return prev;
      // Keys come from the SERVER catalog grouping — a client mirror that
      // lags the backend would select-all only a subset of the module.
      const moduleKeys =
        grouped
          .find((group) => group.module === moduleKey)
          ?.entries.map((entry) => entry.key) ?? [];
      const next = selected
        ? [...new Set([...prev.selectedKeys, ...moduleKeys])]
        : prev.selectedKeys.filter((key) => !moduleKeys.includes(key));
      return { ...prev, selectedKeys: next };
    });
  }

  function requestSave() {
    if (!form) return;
    if (form.name.trim() === "") {
      setFormError("Role name is required.");
      return;
    }
    if (catalogError && !catalog) {
      setFormError(
        "The permission catalog is unavailable — editing is disabled until it loads.",
      );
      return;
    }
    if (removedKeys.length > 0) {
      setConfirmingSave(true);
      return;
    }
    void save();
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setFormError(null);
    try {
      if (form.id === null) {
        const created = await createRoleApi({
          name: form.name.trim(),
          permissionKeys: form.selectedKeys,
        });
        setRoles((prev) => [...prev, created]);
        toast.add({ title: `Role "${created.name}" created`, type: "success" });
      } else {
        const updated = await updateRoleApi(form.id, {
          ...(form.isSystem ? {} : { name: form.name.trim() }),
          permissionKeys: form.selectedKeys,
        });
        setRoles((prev) =>
          prev.map((role) => (role.id === updated.id ? updated : role)),
        );
        toast.add({ title: `Role "${updated.name}" updated`, type: "success" });
      }
      setForm(null);
      // Permission changes can affect the signed-in user's own roles —
      // refresh the snapshot so guards and menus reflect them immediately.
      void refreshSessionContext();
    } catch (error) {
      const message =
        typeof error === "object" &&
        error !== null &&
        "response" in error &&
        typeof (error as { response?: { data?: { message?: string } } }).response
          ?.data?.message === "string"
          ? (error as { response: { data: { message: string } } }).response.data
              .message
          : "Unable to save the role.";
      setFormError(message);
    } finally {
      setSaving(false);
      setConfirmingSave(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteRoleApi(deleteTarget.id);
      setRoles((prev) => prev.filter((role) => role.id !== deleteTarget.id));
      toast.add({ title: `Role "${deleteTarget.name}" deleted`, type: "success" });
      setDeleteTarget(null);
    } catch (error) {
      const message =
        typeof error === "object" &&
        error !== null &&
        "response" in error &&
        typeof (error as { response?: { data?: { message?: string } } }).response
          ?.data?.message === "string"
          ? (error as { response: { data: { message: string } } }).response.data
              .message
          : "Unable to delete the role.";
      toast.add({ title: message, type: "error" });
      setDeleteTarget(null);
    }
  }

  async function openUsers(role: RoleSummary) {
    setUsersTarget(role);
    setUsersLoading(true);
    setRoleUsers([]);
    try {
      const data = await getRoleUsersApi(role.id);
      setRoleUsers(data);
    } catch {
      toast.add({ title: "Unable to load the role's users.", type: "error" });
    } finally {
      setUsersLoading(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Roles &amp; Permissions</h1>
          <p className="text-sm text-muted-foreground">
            Roles group permissions. A user's effective access is the union of
            all their roles.
          </p>
        </div>
        <Button onClick={openCreate}>Create role</Button>
      </div>

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Role</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Permissions</TableHead>
              <TableHead>Users</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  Loading roles…
                </TableCell>
              </TableRow>
            ) : (
              roles.map((role) => (
                <TableRow key={role.id}>
                  <TableCell className="font-medium">{role.name}</TableCell>
                  <TableCell>
                    <Badge variant={role.isSystem ? "secondary" : "outline"}>
                      {role.isSystem ? "Default" : "Custom"}
                    </Badge>
                  </TableCell>
                  <TableCell>{role.permissionKeys.length}</TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="underline-offset-4 hover:underline"
                      onClick={() => void openUsers(role)}
                    >
                      {role.userCount} user{role.userCount === 1 ? "" : "s"}
                    </button>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(role)}>
                        {role.slug === "owner" ? "View" : "Edit"}
                      </Button>
                      {!role.isSystem ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(role)}
                        >
                          Delete
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create / edit role with the permission matrix */}
      <Dialog
        open={form !== null}
        onOpenChange={(open) => !open && setForm(null)}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {form ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {form.id === null ? "Create role" : `Edit ${form.name}`}
                </DialogTitle>
                <DialogDescription>
                  {form.readOnly
                    ? "The Owner role always keeps full access and cannot be modified."
                    : form.isSystem && form.id !== null
                      ? "Default roles can be tuned but not renamed. Pick the permissions this role grants."
                      : "Pick the permissions this role grants."}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-1.5">
                <Label htmlFor="role-name">Role name</Label>
                <Input
                  id="role-name"
                  value={form.name}
                  disabled={form.readOnly || (form.isSystem && form.id !== null)}
                  onChange={(event) =>
                    setForm((prev) =>
                      prev ? { ...prev, name: event.target.value } : prev,
                    )
                  }
                />
              </div>

              {catalogError && !catalog ? (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  Could not load the permission catalog — the matrix below
                  would be incomplete and a save could strip permissions.
                  Close this dialog and retry once the server responds.
                </div>
              ) : (
                <div className="grid gap-3">
                  {grouped.map(({ module: moduleKey, entries }) => {
                  const selectedCount = entries.filter((entry) =>
                    form.selectedKeys.includes(entry.key),
                  ).length;
                  const allSelected = selectedCount === entries.length;
                  return (
                    <div key={moduleKey} className="rounded-md border p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">
                          {MODULE_LABELS[moduleKey] ?? moduleKey}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {selectedCount}/{entries.length}
                          </span>
                        </span>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => setModule(moduleKey, true)}
                            disabled={allSelected || form.readOnly}
                          >
                            Select all
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => setModule(moduleKey, false)}
                            disabled={selectedCount === 0 || form.readOnly}
                          >
                            Clear
                          </Button>
                        </div>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {entries.map((entry) => {
                          const description =
                            PERMISSION_CATALOG.find(
                              (candidate) => candidate.key === entry.key,
                            )?.description ?? entry.description;
                          return (
                            <label
                              key={entry.key}
                              className="flex items-center gap-2 text-sm"
                              title={description ?? entry.key}
                            >
                              <Checkbox
                                checked={form.selectedKeys.includes(entry.key)}
                                onCheckedChange={() => toggleKey(entry.key)}
                                disabled={form.readOnly}
                              />
                              {description ?? entry.key}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                </div>
              )}

              <p className="text-sm text-muted-foreground">
                {form.selectedKeys.length} permission
                {form.selectedKeys.length === 1 ? "" : "s"} selected
              </p>
              {formError ? (
                <p className="text-sm text-destructive">{formError}</p>
              ) : null}

              <DialogFooter>
                <Button variant="outline" onClick={() => setForm(null)}>
                  Cancel
                </Button>
                <Button onClick={requestSave} disabled={saving || form.readOnly}>
                  {saving ? (
                    <>
                      <Spinner className="size-4" /> Saving…
                    </>
                  ) : (
                    "Save changes"
                  )}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Confirmation before removing permissions */}
      <Dialog
        open={confirmingSave}
        onOpenChange={(open) => !open && setConfirmingSave(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove permissions?</DialogTitle>
            <DialogDescription>
              You are removing {removedKeys.length} permission
              {removedKeys.length === 1 ? "" : "s"} from this role. Users who
              rely on them lose access immediately.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-40 overflow-y-auto rounded-md border p-3 text-sm text-muted-foreground">
            {removedKeys.map((key) => (
              <li key={key}>{key}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingSave(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void save()}>
              Remove and save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete role confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{deleteTarget?.name}"?</DialogTitle>
            <DialogDescription>
              {deleteTarget && deleteTarget.userCount > 0
                ? `This role is currently assigned to ${deleteTarget.userCount} user${deleteTarget.userCount === 1 ? "" : "s"} and cannot be deleted until it is unassigned.`
                : "The role will be removed from the permission matrix. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()}>
              Delete role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Users holding a role */}
      <Dialog
        open={usersTarget !== null}
        onOpenChange={(open) => !open && setUsersTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Users with "{usersTarget?.name}"</DialogTitle>
            <DialogDescription>
              Effective permissions come from every role a user holds.
            </DialogDescription>
          </DialogHeader>
          {usersLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
              <Spinner className="size-4" /> Loading…
            </div>
          ) : roleUsers.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No users hold this role yet.
            </p>
          ) : (
            <ul className="grid gap-2">
              {roleUsers.map((user) => (
                <li
                  key={user.userId}
                  className="flex items-center justify-between rounded-md border p-2 text-sm"
                >
                  <div>
                    <div className="font-medium">{user.fullName}</div>
                    <div className="text-muted-foreground">{user.email}</div>
                  </div>
                  <Badge variant={user.isActive ? "default" : "outline"}>
                    {user.isActive ? "Active" : "Inactive"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
