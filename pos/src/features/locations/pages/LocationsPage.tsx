import { useCallback, useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import { refreshLocationContext } from "@/api/axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import {
  createLocationApi,
  deleteLocationApi,
  getLocationsApi,
  updateLocationApi,
  type LocationSummary,
} from "../locations.api";

const LOCATION_TYPES = [
  { value: "store", label: "Store" },
  { value: "warehouse", label: "Warehouse" },
  { value: "outlet", label: "Outlet" },
  { value: "head_office", label: "Head Office" },
];

interface LocationForm {
  name: string;
  locationCode: string;
  locationType: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  isDefault: boolean;
  status: "active" | "inactive";
}

const EMPTY_FORM: LocationForm = {
  name: "",
  locationCode: "",
  locationType: "store",
  phone: "",
  email: "",
  address: "",
  city: "",
  isDefault: false,
  status: "active",
};

export function LocationsPage() {
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<LocationForm>(EMPTY_FORM);
  const [editing, setEditing] = useState<LocationSummary | null>(null);
  const [editForm, setEditForm] = useState<LocationForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LocationSummary | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getLocationsApi();
      setLocations(data);
    } catch {
      toast.add({ title: "Unable to load locations", type: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function extractError(error: unknown, fallback: string): string {
    if (
      typeof error === "object" &&
      error !== null &&
      "response" in error &&
      typeof (error as { response?: { data?: { message?: string } } }).response
        ?.data?.message === "string"
    ) {
      return (error as { response: { data: { message: string } } }).response.data
        .message;
    }
    return fallback;
  }

  function field(label: keyof LocationForm, label2: string) {
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={`loc-${label}`}>{label2}</Label>
        <Input
          id={`loc-${label}`}
          value={String(form[label] ?? "")}
          onChange={(event) =>
            setForm((prev) => ({ ...prev, [label]: event.target.value }))
          }
        />
      </div>
    );
  }

  function editField(label: keyof LocationForm, label2: string) {
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={`edit-loc-${label}`}>{label2}</Label>
        <Input
          id={`edit-loc-${label}`}
          value={String(editForm[label] ?? "")}
          onChange={(event) =>
            setEditForm((prev) => ({ ...prev, [label]: event.target.value }))
          }
        />
      </div>
    );
  }

  async function handleCreate() {
    setFormError(null);
    if (form.name.trim() === "") {
      setFormError("Location name is required.");
      return;
    }
    setSaving(true);
    try {
      const created = await createLocationApi({
        name: form.name.trim(),
        locationCode: form.locationCode.trim() || undefined,
        locationType: form.locationType,
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        address: form.address.trim() || undefined,
        city: form.city.trim() || undefined,
        isDefault: form.isDefault,
      });
      setLocations((prev) => [...prev, created]);
      toast.add({ title: `Location "${created.name}" created`, type: "success" });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      void refreshLocationContext();
    } catch (error) {
      setFormError(extractError(error, "Unable to create the location."));
    } finally {
      setSaving(false);
    }
  }

  function openEdit(location: LocationSummary) {
    setEditing(location);
    setEditError(null);
    setEditForm({
      name: location.name,
      locationCode: location.locationCode ?? "",
      locationType: location.locationType,
      phone: location.phone ?? "",
      email: location.email ?? "",
      address: location.address ?? "",
      city: location.city ?? "",
      isDefault: location.isDefault,
      status: location.status === "inactive" ? "inactive" : "active",
    });
  }

  async function handleUpdate() {
    if (!editing) return;
    setEditError(null);
    if (editForm.name.trim() === "") {
      setEditError("Location name is required.");
      return;
    }
    setSaving(true);
    try {
      const updated = await updateLocationApi(editing.id, {
        name: editForm.name.trim(),
        locationCode: editForm.locationCode.trim() || null,
        locationType: editForm.locationType,
        phone: editForm.phone.trim() || null,
        email: editForm.email.trim() || null,
        address: editForm.address.trim() || null,
        city: editForm.city.trim() || null,
        isDefault: editForm.isDefault,
        status: editForm.status,
      });
      setLocations((prev) =>
        prev.map((l) => (l.id === updated.id ? updated : l)),
      );
      toast.add({ title: `Location "${updated.name}" updated`, type: "success" });
      setEditing(null);
      void refreshLocationContext();
    } catch (error) {
      setEditError(extractError(error, "Unable to update the location."));
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(location: LocationSummary) {
    try {
      const updated = await updateLocationApi(location.id, {
        status: location.status === "active" ? "inactive" : "active",
      });
      setLocations((prev) =>
        prev.map((l) => (l.id === updated.id ? updated : l)),
      );
      void refreshLocationContext();
    } catch (error) {
      toast.add({
        title: extractError(error, "Unable to update the location."),
        type: "error",
      });
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteLocationApi(deleteTarget.id);
      setLocations((prev) => prev.filter((l) => l.id !== deleteTarget.id));
      toast.add({
        title: `Location "${deleteTarget.name}" deleted`,
        type: "success",
      });
      setDeleteTarget(null);
      void refreshLocationContext();
    } catch (error) {
      toast.add({
        title: extractError(error, "Unable to delete the location."),
        type: "error",
      });
      setDeleteTarget(null);
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Locations</h1>
          <p className="text-sm text-muted-foreground">
            Stores, warehouses and outlets. One product catalog, independent
            stock per location.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Add location</Button>
      </div>

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>City</TableHead>
              <TableHead>Default</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  Loading locations…
                </TableCell>
              </TableRow>
            ) : locations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No locations yet. Create your first location to start
                  recording inventory and sales.
                </TableCell>
              </TableRow>
            ) : (
              locations.map((location) => (
                <TableRow key={location.id}>
                  <TableCell className="font-medium">{location.name}</TableCell>
                  <TableCell>{location.locationCode ?? "—"}</TableCell>
                  <TableCell>
                    {LOCATION_TYPES.find((t) => t.value === location.locationType)
                      ?.label ?? location.locationType}
                  </TableCell>
                  <TableCell>{location.city ?? "—"}</TableCell>
                  <TableCell>
                    {location.isDefault ? <Badge>Default</Badge> : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={location.status === "active"}
                        onCheckedChange={() => void toggleStatus(location)}
                        disabled={location.isDefault && location.status === "active"}
                      />
                      <span className="text-sm text-muted-foreground">
                        {location.status === "active" ? "Active" : "Inactive"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(location)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(location)}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add location</DialogTitle>
            <DialogDescription>
              The first location automatically becomes the default.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {field("name", "Name")}
            <div className="grid grid-cols-2 gap-3">
              {field("locationCode", "Code (optional)")}
              <div className="grid gap-1.5">
                <Label htmlFor="loc-type">Type</Label>
                <Select
                  value={form.locationType}
                  onValueChange={(value) =>
                    setForm((prev) => ({
                      ...prev,
                      locationType: value ?? "store",
                    }))
                  }
                  items={LOCATION_TYPES.map((option) => ({
                    value: String(option.value),
                    label: option.label,
                  }))}
                >
                  <SelectTrigger id="loc-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCATION_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {field("phone", "Phone")}
              {field("city", "City")}
            </div>
            {field("address", "Address")}
            {formError ? (
              <p className="text-sm text-destructive">{formError}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreate()} disabled={saving}>
              {saving ? "Creating…" : "Create location"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editing?.name}</DialogTitle>
            <DialogDescription>
              {editForm.isDefault
                ? "This is the default location — it cannot be deactivated while it is the only default."
                : "Set as default to make new transactions target this location when none is selected."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {editField("name", "Name")}
            <div className="grid grid-cols-2 gap-3">
              {editField("locationCode", "Code")}
              <div className="grid gap-1.5">
                <Label htmlFor="edit-loc-type">Type</Label>
                <Select
                  value={editForm.locationType}
                  onValueChange={(value) =>
                    setEditForm((prev) => ({
                      ...prev,
                      locationType: value ?? "store",
                    }))
                  }
                  items={LOCATION_TYPES.map((option) => ({
                    value: String(option.value),
                    label: option.label,
                  }))}
                >
                  <SelectTrigger id="edit-loc-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCATION_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {editField("phone", "Phone")}
              {editField("city", "City")}
            </div>
            {editField("address", "Address")}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="edit-loc-default"
                  checked={editForm.isDefault}
                  onCheckedChange={(checked) =>
                    setEditForm((prev) => ({ ...prev, isDefault: checked }))
                  }
                />
                <Label htmlFor="edit-loc-default">Default location</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="edit-loc-active"
                  checked={editForm.status === "active"}
                  onCheckedChange={(checked) =>
                    setEditForm((prev) => ({
                      ...prev,
                      status: checked ? "active" : "inactive",
                    }))
                  }
                />
                <Label htmlFor="edit-loc-active">Active</Label>
              </div>
            </div>
            {editError ? (
              <p className="text-sm text-destructive">{editError}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={() => void handleUpdate()} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete "${deleteTarget?.name ?? ""}"?`}
        entityName="location"
        description={
          deleteTarget && deleteTarget.isDefault
            ? "The default location cannot be deleted. Set another location as default first."
            : "Locations holding historical transactions or stock cannot be deleted — deactivate them instead."
        }
        onConfirm={async () => {
          await handleDelete();
        }}
      />
    </div>
  );
}
