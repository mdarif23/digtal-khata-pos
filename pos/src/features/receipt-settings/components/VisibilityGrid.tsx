import { Switch } from "@/components/ui/switch.js";
import { Label } from "@/components/ui/label.js";

export interface VisibilityField<K extends string> {
  key: K;
  label: string;
}

interface VisibilityGridProps<K extends string> {
  fields: readonly VisibilityField<K>[];
  value: Record<K, boolean>;
  onChange: (key: K, checked: boolean) => void;
  disabled?: boolean;
}

/** Show/hide switch grid shared by the receipt and invoice design cards. */
export function VisibilityGrid<K extends string>({
  fields,
  value,
  onChange,
  disabled,
}: VisibilityGridProps<K>) {
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
      {fields.map((field) => (
        <div key={field.key} className="flex items-center justify-between gap-3">
          <Label htmlFor={`vis-${field.key}`} className="text-xs font-normal">
            {field.label}
          </Label>
          <Switch
            id={`vis-${field.key}`}
            size="sm"
            checked={value[field.key]}
            onCheckedChange={(checked) => onChange(field.key, checked === true)}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  );
}
