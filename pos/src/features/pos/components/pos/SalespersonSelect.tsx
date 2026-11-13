import { useEffect, useState } from "react";
import { UserCheck } from "lucide-react";
import api from "@/api/axios.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface UserOption {
  id: number;
  fullName: string;
  isActive: boolean;
}

/**
 * Salesperson selector (Phase 5 — Feature 13): attributes new sales to a
 * business member. Persisted per register in localStorage; the payload
 * carries it server-side where membership is validated.
 */
export function SalespersonSelect(props: {
  value: number | null;
  onChange: (userId: number | null) => void;
}) {
  const [options, setOptions] = useState<UserOption[]>([]);

  useEffect(() => {
    api
      .get<{ success: boolean; data: UserOption[] }>("/users")
      .then((res) => {
        setOptions((res.data.data ?? []).filter((u) => u.isActive));
      })
      .catch(() => setOptions([]));
  }, []);

  return (
    <div className="flex items-center gap-1.5">
      <UserCheck className="size-4 shrink-0 text-muted-foreground" />
      <Select
        value={props.value !== null ? String(props.value) : undefined}
        onValueChange={(value) =>
          props.onChange(value === "unassigned" || value === "" ? null : Number(value))
        }
        items={[
          { value: "unassigned", label: "No salesperson" },
          ...options.map((option) => ({
            value: String(option.id),
            label: option.fullName,
          })),
        ]}
      >
        <SelectTrigger className="h-8 w-40 text-xs">
          <SelectValue placeholder="Salesperson" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unassigned">No salesperson</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.id} value={String(option.id)}>
              {option.fullName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
