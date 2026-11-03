import { Link } from "react-router";
import { MapPin, Plus } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSessionStore } from "@/auth/sessionStore";
import { switchLocation } from "@/api/axios";
import { hasPermission } from "@/auth/sessionStore";

/**
 * Global location switcher. Lists only the server-verified accessible
 * locations; the selection is re-validated by the backend on every request.
 * Switching reloads the app so all location-scoped data refetches.
 */
export function LocationSwitcher() {
  const locations = useSessionStore((state) => state.locations);
  const activeLocationId = useSessionStore((state) => state.activeLocationId);

  if (locations.length === 0) {
    if (!hasPermission("locations.manage")) return null;
    return (
      <Link
        to="/locations"
        className="mx-2 mb-2 flex items-center justify-center gap-2 rounded-md border border-dashed p-2 text-xs text-muted-foreground hover:bg-muted"
      >
        <Plus className="size-3.5" />
        Create your first location
      </Link>
    );
  }

  return (
    <div className="mx-2 mb-2 flex items-center gap-1.5">
      <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
      <Select
        value={activeLocationId !== null ? String(activeLocationId) : undefined}
        onValueChange={(value) => {
          if (value !== null) switchLocation(Number(value));
        }}
        // Base UI renders Select.Value as the RAW selected value unless the
        // root knows the value->label mapping — without this the trigger
        // shows the location id instead of its name.
        items={locations.map((location) => ({
          value: String(location.id),
          label:
            location.name + (location.status !== "active" ? " (inactive)" : ""),
        }))}
      >
        <SelectTrigger
          size="sm"
          className="h-8 flex-1 border-sidebar-border bg-sidebar-accent/50"
          aria-label="Active location"
        >
          <SelectValue placeholder="Select location" />
        </SelectTrigger>
        <SelectContent>
          {locations.map((location) => (
            <SelectItem key={location.id} value={String(location.id)}>
              {location.name}
              {location.status !== "active" ? " (inactive)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
