"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import {
  deleteMedia,
  fetchMedia,
  uploadMediaFile,
  type MediaItem,
} from "@/lib/api/online-store";

/**
 * Storefront media library: upload (presigned PUT direct to object storage),
 * browse, pick, delete. `onPick` receives the public URL of the chosen image.
 */
export function MediaPicker({
  open,
  onPick,
  onClose,
}: {
  open: boolean;
  onPick: (url: string) => void;
  onClose: () => void;
}) {
  const { businessId } = useActiveBusiness();
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!businessId) return;
    const result = await fetchMedia(businessId);
    if (result.ok && result.data) {
      setItems(result.data);
      setMessage(null);
    } else {
      setMessage(result.message);
      setItems([]);
    }
  }, [businessId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function handleUpload(file: File) {
    if (!businessId) return;
    setUploading(true);
    setMessage(null);
    const result = await uploadMediaFile(businessId, file);
    setUploading(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    await load();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Media library"
    >
      <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">Media library</h2>
          <button
            type="button"
            className="text-sm text-slate-500 hover:text-slate-900"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {message ? (
          <div className="mt-3">
            <Alert tone="warning" title={message} role="alert" />
          </div>
        ) : null}

        <div className="mt-4 flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void handleUpload(file);
            }}
          />
          <Button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? "Uploading…" : "Upload image"}
          </Button>
          <span className="text-xs text-slate-500">
            JPEG, PNG or WebP
          </span>
        </div>

        {items === null ? (
          <p className="mt-4 text-sm text-slate-500" role="status">Loading…</p>
        ) : items.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No images yet — upload your logo, banners and product photos.
          </p>
        ) : (
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {items.map((item) => (
              <li
                key={item.id}
                className="overflow-hidden rounded-lg border border-slate-200"
              >
                <button
                  type="button"
                  className="block w-full"
                  onClick={() => {
                    if (item.publicUrl) {
                      onPick(item.publicUrl);
                      onClose();
                    }
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.publicUrl ?? ""}
                    alt={item.fileName}
                    className="h-24 w-full object-cover"
                  />
                  <span className="block truncate px-2 py-1 text-xs text-slate-600">
                    {item.fileName}
                  </span>
                </button>
                <button
                  type="button"
                  className="w-full border-t border-slate-100 py-1 text-xs text-red-600 hover:bg-red-50"
                  onClick={() => {
                    if (businessId) void (async () => {
                      await deleteMedia(businessId, item.id);
                      await load();
                    })();
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
