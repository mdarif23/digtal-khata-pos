import { useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { toast } from "@/components/ui/toast";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { useRemoveBusinessLogo, useUploadBusinessLogo } from "../hooks/useDocumentSettings.js";

const LOGO_MAX_BYTES = 300 * 1024;
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

interface LogoUploaderProps {
  logoUrl: string | null;
  disabled?: boolean;
}

/**
 * Business logo upload for document branding. Client-side validation gives
 * fast feedback; the backend remains the authority (magic bytes + size cap).
 */
export function LogoUploader({ logoUrl, disabled }: LogoUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingDataUrl, setPendingDataUrl] = useState<string | null>(null);
  const upload = useUploadBusinessLogo();
  const remove = useRemoveBusinessLogo();
  const busy = upload.isPending || remove.isPending;

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    if (!ACCEPTED_TYPES.has(file.type)) {
      toast.add({ title: "Logo must be a PNG, JPEG or WebP image.", type: "error" });
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      toast.add({
        title: `Logo is too large (${Math.round(file.size / 1024)} KB) — keep it under 300 KB.`,
        type: "error",
      });
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      toast.add({ title: "Could not read the image file.", type: "error" });
    };
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) {
        toast.add({ title: "Could not read the image file.", type: "error" });
        return;
      }
      setPendingDataUrl(dataUrl);
      upload.mutate(dataUrl, {
        onSuccess: () => setPendingDataUrl(null),
        onError: () => setPendingDataUrl(null),
      });
    };
    reader.readAsDataURL(file);
  };

  const preview = pendingDataUrl ?? logoUrl;

  return (
    <div className="space-y-2">
      <Label>Business Logo</Label>
      <div className="flex items-center gap-3">
        <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40">
          {preview ? (
            <img src={preview} alt="Business logo" className="max-h-full max-w-full object-contain" />
          ) : (
            <ImagePlus className="size-6 text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              disabled={disabled || busy}
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy}
              onClick={() => fileInputRef.current?.click()}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
              {logoUrl ? "Replace" : "Upload"}
            </Button>
            {logoUrl && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={disabled || busy}
                onClick={() => remove.mutate()}
              >
                <Trash2 className="size-4" />
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            PNG, JPEG or WebP · up to 300 KB · shown on receipts and invoices
          </p>
        </div>
      </div>
    </div>
  );
}
