import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import axios from "../../../../api/axios.js";

export function SerialPickerDialog({
  variantId,
  selected,
  onConfirm,
  serialDialogOpen,
  setSerialDialogOpen,
}: {
  variantId: number | undefined;
  selected: string[];
  onConfirm: (serials: string[]) => boolean | void;
  serialDialogOpen:boolean,
  setSerialDialogOpen: (open: boolean) => void
}) {
  const [available, setAvailable] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>(selected);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  // load fresh data every time the dialog opens
  useEffect(() => {
    if (!serialDialogOpen) return;
    setPicked(selected);
    setSearch("");
    setError("");
    axios
      .get(`variants/${variantId}/serials`)
      .then((res) => setAvailable(res.data))
      .catch(() => setError("Could not load serial numbers"));
  }, [serialDialogOpen, variantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (serial: string) =>
    setPicked((prev) =>
      prev.includes(serial)
        ? prev.filter((s) => s !== serial)
        : [...prev, serial],
    );

  const handleScan = (code: string) => {
    const value = code.trim();
    if (!value) return;
    if (!available.includes(value)) {
      setError(`"${value}" is not in stock for this product`);
    } else if (picked.includes(value)) {
      setError(`"${value}" is already selected`);
    } else {
      setPicked((prev) => [...prev, value]);
      setError("");
    }
    setSearch("");
  };

  const visible = available.filter((s) =>
    s.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Dialog open={serialDialogOpen} onOpenChange={setSerialDialogOpen}>
      <DialogContent className="sm:max-w-md z-100">
        <DialogHeader>
          <DialogTitle>Select serial numbers</DialogTitle>
          <DialogDescription>
            Selected: {picked.length} · In stock: {available.length}
          </DialogDescription>
        </DialogHeader>

        <Input
          autoFocus
          value={search}
          placeholder="Scan or search serial, press Enter"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault(); // must not submit the cart form
              handleScan(search);
            }
          }}
        />
        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="max-h-64 space-y-1 overflow-y-auto">
          {visible.map((serial) => (
            <label
              key={serial}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={picked.includes(serial)}
                onChange={() => toggle(serial)}
              />
              <span>{serial}</span>
            </label>
          ))}
          {visible.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No serial numbers found
            </p>
          )}
        </div>

        <DialogFooter>
          <DialogClose
            render={
              <Button type="button" variant="outline">
                Cancel
              </Button>
            }
          />
          <Button
            type="button"
            disabled={picked.length === 0}
            onClick={() => {
              if (onConfirm(picked) === false) return;
              setSerialDialogOpen(false);
            }}
          >
            Confirm ({picked.length})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
