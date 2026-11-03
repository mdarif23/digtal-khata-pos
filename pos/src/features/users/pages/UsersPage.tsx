import { useCallback, useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@/auth/sessionStore";
import { refreshSessionContext, refreshLocationContext } from "@/api/axios";
import { getLocationsApi, type LocationSummary } from "@/features/locations/locations.api";
import { toast } from "@/components/ui/toast";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { PermissionButton } from "@/components/common/PermissionGuard";
import {
  createStaffUserApi,
  getUsersApi,
  resetStaffPasswordApi,
  updateStaffUserApi,
  type Member,
  type MemberRole,
} from "../users.api";
import { getRolesApi, type RoleSummary } from "@/features/roles/roles.api";

const STAFF_PASSWORD_MIN = 8;

interface FormState {
  fullName: string;
  email: string;
  password: string;
  roleIds: number[];
  locationIds: number[];
}

const EMPTY_FORM: FormState = {
  fullName: "",
  email: "",
  password: "",
  roleIds: [],
  locationIds: [],
};

export function UsersPage() {
  const version = useSessionStore((state) => state.version);
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [editing, setEditing] = useState<Member | null>(null);
  const [editRoleIds, setEditRoleIds] = useState<number[]>([]);
  const [editLocationIds, setEditLocationIds] = useState<number[]>([]);
  const [resetTarget, setResetTarget] = useState<Member | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const canEdit = useSessionStore((state) =>
    state.permissions.includes("*") || state.permissions.includes("users.edit"),
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [memberData, roleData, locationData] = await Promise.all([
        getUsersApi(),
        getRolesApi().catch(() => [] as RoleSummary[]),
        getLocationsApi().catch(() => [] as LocationSummary[]),
      ]);
      setMembers(memberData);
      setRoles(roleData);
      setLocations(locationData);
    } catch {
      toast.add({
        title: "Unable to load users",
        type: "error",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return members.filter((member) => {
      const matchesQuery =
        query === "" ||
        member.fullName.toLowerCase().includes(query) ||
        member.email.toLowerCase().includes(query);
      const matchesRole =
        roleFilter === "all" ||
        member.roles.some((role) => String(role.id) === roleFilter);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" ? member.isActive : !member.isActive);
      return matchesQuery && matchesRole && matchesStatus;
    });
  }, [members, search, roleFilter, statusFilter]);

  const selectableRoles = roles.filter((role) => role.slug !== "owner");

  async function handleCreate() {
    setFormError(null);
    if (form.fullName.trim() === "") {
      setFormError("Name is required.");
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) {
      setFormError("A valid email is required.");
      return;
    }
    if (form.password.length < STAFF_PASSWORD_MIN) {
      setFormError(`Password must be at least ${STAFF_PASSWORD_MIN} characters.`);
      return;
    }
    if (form.roleIds.length === 0) {
      setFormError("Assign at least one role.");
      return;
    }
    setSaving(true);
    try {
      const created = await createEntityPromiseToast({
        data: {
          fullName: form.fullName.trim(),
          email: form.email.trim().toLowerCase(),
          password: form.password,
          roleIds: form.roleIds,
          locationIds: form.locationIds,
        },
        apiCall: createStaffUserApi,
        entityName: "user",
        displayName: form.fullName,
      });
      setMembers((prev) => [...prev, created]);
      setCreateOpen(false);
      setForm(EMPTY_FORM);
    } catch {
      // toast already reported the failure
    } finally {
      setSaving(false);
    }
  }

  function openEdit(member: Member) {
    setEditing(member);
    setEditRoleIds(member.roles.map((role) => role.id));
    setEditLocationIds(member.locations);
  }

  async function handleSaveRoles() {
    if (!editing) return;
    if (editRoleIds.length === 0) {
      toast.add({ title: "Assign at least one role.", type: "error" });
      return;
    }
    setSaving(true);
    try {
      const updated = await updateStaffUserApi(editing.userId, {
        roleIds: editRoleIds,
        locationIds: editLocationIds,
      });
      setMembers((prev) =>
        prev.map((m) => (m.userId === updated.userId ? updated : m)),
      );
      toast.add({
        title: `${updated.fullName} updated`,
        type: "success",
      });
      setEditing(null);
      // Pick up the new effective permissions for the signed-in user too.
      void refreshSessionContext();
    } catch {
      toast.add({ title: "Unable to update the user.", type: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(member: Member) {
    try {
      const updated = await updateStaffUserApi(member.userId, {
        isActive: !member.isActive,
      });
      setMembers((prev) =>
        prev.map((m) => (m.userId === updated.userId ? updated : m)),
      );
      if (member.userId === updated.userId) {
        void refreshSessionContext();
      }
    } catch {
      toast.add({ title: "Unable to update the user.", type: "error" });
    }
  }

  async function handleResetPassword() {
    if (!resetTarget) return;
    if (resetPassword.length < STAFF_PASSWORD_MIN) {
      toast.add({
        title: `Password must be at least ${STAFF_PASSWORD_MIN} characters.`,
        type: "error",
      });
      return;
    }
    setSaving(true);
    try {
      await resetStaffPasswordApi(resetTarget.userId, resetPassword);
      toast.add({
        title: `Password updated for ${resetTarget.fullName}`,
        type: "success",
      });
      setResetTarget(null);
      setResetPassword("");
    } catch {
      toast.add({ title: "Unable to reset the password.", type: "error" });
    } finally {
      setSaving(false);
    }
  }

  function toggleRole(list: number[], roleId: number): number[] {
    return list.includes(roleId)
      ? list.filter((id) => id !== roleId)
      : [...list, roleId];
  }

  function toggleLocation(list: number[], locationId: number): number[] {
    return list.includes(locationId)
      ? list.filter((id) => id !== locationId)
      : [...list, locationId];
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">
            Manage who can sign in to this business and what they can do.
          </p>
        </div>
        <PermissionButton permission="users.create" onClick={() => setCreateOpen(true)}>
          Add user
        </PermissionButton>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search by name or email…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
        />
        <Select
          value={roleFilter}
          onValueChange={(value) => setRoleFilter(value ?? "all")}
          // Base UI renders Select.Value as the RAW selected value unless the
          // root knows the value->label mapping (role id -> role name).
          items={[
            { value: "all", label: "All roles" },
            ...roles.map((role) => ({
              value: String(role.id),
              label: role.name,
            })),
          ]}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All roles" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            {roles.map((role) => (
              <SelectItem key={role.id} value={String(role.id)}>
                {role.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value ?? "all")}
          items={[
            { value: "all", label: "All statuses" },
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ]}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  Loading users…
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No users match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((member) => (
                <TableRow key={member.userId}>
                  <TableCell className="font-medium">{member.fullName}</TableCell>
                  <TableCell>{member.email}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {member.roles.map((role: MemberRole) => (
                        <Badge key={role.id} variant="secondary">
                          {role.name}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={member.isActive ? "default" : "outline"}>
                      {member.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {member.createdAt
                      ? new Date(member.createdAt).toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {canEdit ? (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(member)}>
                          Roles
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void toggleActive(member)}
                        >
                          {member.isActive ? "Deactivate" : "Activate"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setResetTarget(member)}
                        >
                          Reset password
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">View only</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create user */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>
              Creates a sign-in account for this business. Share the password
              securely — the user can change it later.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="new-user-name">Full name</Label>
              <Input
                id="new-user-name"
                value={form.fullName}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, fullName: event.target.value }))
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-user-email">Email</Label>
              <Input
                id="new-user-email"
                type="email"
                value={form.email}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, email: event.target.value }))
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-user-password">Password</Label>
              <Input
                id="new-user-password"
                type="password"
                value={form.password}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, password: event.target.value }))
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Roles</Label>
              <div className="grid gap-2 rounded-md border p-3">
                {selectableRoles.length === 0 ? (
                  <span className="text-sm text-muted-foreground">
                    No assignable roles yet.
                  </span>
                ) : (
                  selectableRoles.map((role) => (
                    <label
                      key={role.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={form.roleIds.includes(role.id)}
                        onCheckedChange={() =>
                          setForm((prev) => ({
                            ...prev,
                            roleIds: toggleRole(prev.roleIds, role.id),
                          }))
                        }
                      />
                      {role.name}
                    </label>
                  ))
                )}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Location access</Label>
              <div className="grid gap-2 rounded-md border p-3">
                {locations.length === 0 ? (
                  <span className="text-sm text-muted-foreground">
                    No locations yet — create one under Locations.
                  </span>
                ) : (
                  locations.map((location) => (
                    <label
                      key={location.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={form.locationIds.includes(location.id)}
                        onCheckedChange={() =>
                          setForm((prev) => ({
                            ...prev,
                            locationIds: toggleLocation(
                              prev.locationIds,
                              location.id,
                            ),
                          }))
                        }
                      />
                      {location.name}
                    </label>
                  ))
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Without at least one location the user cannot record sales or
                inventory.
              </p>
            </div>
            {formError ? (
              <p className="text-sm text-destructive">{formError}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreate()} disabled={saving}>
              {saving ? "Creating…" : "Create user"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit roles */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editing?.fullName}</DialogTitle>
            <DialogDescription>
              Effective permissions are the union of all assigned roles; the
              user can only operate in their assigned locations.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 rounded-md border p-3">
            {selectableRoles.map((role) => (
              <label key={role.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={editRoleIds.includes(role.id)}
                  onCheckedChange={() =>
                    setEditRoleIds((prev) => toggleRole(prev, role.id))
                  }
                />
                {role.name}
              </label>
            ))}
          </div>
          <div className="grid gap-1.5">
            <Label>Location access</Label>
            <div className="grid gap-2 rounded-md border p-3">
              {locations.map((location) => (
                <label
                  key={location.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox
                    checked={editLocationIds.includes(location.id)}
                    onCheckedChange={() =>
                      setEditLocationIds((prev) =>
                        toggleLocation(prev, location.id),
                      )
                    }
                  />
                  {location.name}
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={() => void handleSaveRoles()} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset password */}
      <Dialog
        open={resetTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setResetTarget(null);
            setResetPassword("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset password for {resetTarget?.fullName}</DialogTitle>
            <DialogDescription>
              They will need the new password at their next sign-in.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="reset-password-input">New password</Label>
            <Input
              id="reset-password-input"
              type="password"
              value={resetPassword}
              onChange={(event) => setResetPassword(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setResetTarget(null);
                setResetPassword("");
              }}
            >
              Cancel
            </Button>
            <Button onClick={() => void handleResetPassword()} disabled={saving}>
              {saving ? "Updating…" : "Reset password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
