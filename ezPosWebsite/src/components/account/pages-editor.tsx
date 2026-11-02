"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import {
  createPage,
  deletePage,
  fetchPages,
  updatePage,
  type StorefrontPageRow,
} from "@/lib/api/online-store";
import { looksLikePageSlug } from "@/lib/online-store-helpers";

type Block = Record<string, unknown>;

/**
 * Content pages editor (About Us, policies, delivery info…). Blocks are
 * structured (heading/paragraph/image/faq) — the backend rejects anything
 * else, so no HTML can ever reach the storefront.
 */
export function PagesEditor() {
  const params = useParams<{ id: string }>();
  const storeId = Number(params?.id);
  const { businessId } = useActiveBusiness();
  const [pages, setPages] = useState<StorefrontPageRow[] | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "warning"; text: string; role?: "alert" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<{ slug: string; title: string }>({ slug: "", title: "" });
  const [editing, setEditing] = useState<StorefrontPageRow | null>(null);
  const [editBlocks, setEditBlocks] = useState<Block[]>([]);

  const load = useCallback(async () => {
    if (!businessId || !Number.isInteger(storeId) || storeId <= 0) return;
    const result = await fetchPages(businessId, storeId);
    if (result.ok && result.data) {
      setPages(result.data);
    } else {
      setMessage({ tone: "warning", text: result.message, role: "alert" });
      setPages([]);
    }
  }, [businessId, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    if (!businessId) return;
    setBusy(true);
    const result = await createPage(businessId, storeId, {
      slug: draft.slug.trim(),
      title: draft.title.trim(),
      blocks: [],
    });
    setBusy(false);
    if (result.ok) {
      setCreating(false);
      setDraft({ slug: "", title: "" });
      await load();
    }
    setMessage({ tone: result.ok ? "info" : "warning", text: result.message, role: result.ok ? undefined : "alert" });
  }

  function openEdit(page: StorefrontPageRow) {
    setEditing(page);
    setEditBlocks(page.blocks ?? []);
  }

  function patchBlock(index: number, patch: Block) {
    setEditBlocks((current) =>
      current.map((block, i) => (i === index ? { ...block, ...patch } : block)),
    );
  }

  async function saveEdit() {
    if (!businessId || !editing) return;
    setBusy(true);
    const result = await updatePage(businessId, storeId, editing.id, {
      title: editing.title,
      blocks: editBlocks,
      seoTitle: editing.seoTitle,
      seoDescription: editing.seoDescription,
      isPublished: editing.isPublished,
    });
    setBusy(false);
    setMessage({ tone: result.ok ? "info" : "warning", text: result.message, role: result.ok ? undefined : "alert" });
    if (result.ok) {
      setEditing(null);
      await load();
    }
  }

  if (pages === null) {
    return <p className="text-sm text-slate-500" role="status">Loading pages…</p>;
  }

  return (
    <div className="space-y-6">
      {message ? (
        <Alert tone={message.tone} title={message.text} role={message.role ?? "status"} />
      ) : null}

      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-900">Content pages</h2>
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? "Cancel" : "New page"}
        </Button>
      </div>

      {creating ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="page-title" className="block text-sm font-medium text-slate-700">
                Title
              </label>
              <input
                id="page-title"
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="page-slug" className="block text-sm font-medium text-slate-700">
                Slug <span className="font-normal text-slate-400">(URL: /pages/&lt;slug&gt;)</span>
              </label>
              <input
                id="page-slug"
                value={draft.slug}
                onChange={(event) =>
                  setDraft({ ...draft, slug: event.target.value.toLowerCase().trim() })
                }
                placeholder="about-us"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              {draft.slug && !looksLikePageSlug(draft.slug) ? (
                <p className="mt-1 text-xs text-amber-700">
                  Lowercase letters, numbers and hyphens only.
                </p>
              ) : null}
            </div>
          </div>
          <Button
            className="mt-3"
            onClick={() => void handleCreate()}
            disabled={busy || !draft.title.trim() || !looksLikePageSlug(draft.slug)}
          >
            Create page
          </Button>
        </div>
      ) : null}

      {editing ? (
        <div className="rounded-xl border border-indigo-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-900">Editing: {editing.title}</h3>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Close
            </Button>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="edit-title" className="block text-sm font-medium text-slate-700">
                Title
              </label>
              <input
                id="edit-title"
                value={editing.title}
                onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex items-end gap-4">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={editing.isPublished}
                  onChange={(event) =>
                    setEditing({ ...editing, isPublished: event.target.checked })
                  }
                />
                Visible on store
              </label>
            </div>
            <div>
              <label htmlFor="edit-seo-title" className="block text-sm font-medium text-slate-700">
                SEO title <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id="edit-seo-title"
                value={editing.seoTitle ?? ""}
                onChange={(event) => setEditing({ ...editing, seoTitle: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="edit-seo-desc" className="block text-sm font-medium text-slate-700">
                SEO description <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id="edit-seo-desc"
                value={editing.seoDescription ?? ""}
                onChange={(event) =>
                  setEditing({ ...editing, seoDescription: event.target.value })
                }
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <p className="mt-4 text-sm font-medium text-slate-700">Content blocks</p>
          <ul className="mt-2 space-y-2">
            {editBlocks.map((block, index) => (
              <li key={index} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {String(block.type)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEditBlocks((current) => current.filter((_, i) => i !== index))
                    }
                  >
                    Remove
                  </Button>
                </div>
                {block.type === "heading" || block.type === "paragraph" ? (
                  <input
                    value={String(block.text ?? "")}
                    aria-label={`${block.type} text`}
                    onChange={(event) => patchBlock(index, { text: event.target.value })}
                    className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                ) : null}
                {block.type === "image" ? (
                  <input
                    value={String(block.url ?? "")}
                    aria-label="Image URL"
                    placeholder="Image URL"
                    onChange={(event) => patchBlock(index, { url: event.target.value })}
                    className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                ) : null}
              </li>
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setEditBlocks((current) => [
                  ...current,
                  { type: "heading", text: "New heading", level: 2 },
                ])
              }
            >
              + Heading
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setEditBlocks((current) => [
                  ...current,
                  { type: "paragraph", text: "" },
                ])
              }
            >
              + Paragraph
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setEditBlocks((current) => [
                  ...current,
                  { type: "image", url: "" },
                ])
              }
            >
              + Image
            </Button>
          </div>

          <Button className="mt-4" onClick={() => void saveEdit()} disabled={busy}>
            {busy ? "Saving…" : "Save page"}
          </Button>
        </div>
      ) : null}

      {pages.length === 0 ? (
        <p className="text-sm text-slate-500">
          No pages yet. Create an About Us or policy page — shoppers see these
          linked in your store footer.
        </p>
      ) : (
        <ul className="space-y-2">
          {pages.map((page) => (
            <li
              key={page.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-4"
            >
              <div>
                <p className="font-medium text-slate-900">{page.title}</p>
                <p className="text-sm text-slate-500">
                  /pages/{page.slug} · {page.isPublished ? "visible" : "hidden"} ·{" "}
                  {page.blocks?.length ?? 0} blocks
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => openEdit(page)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (businessId) void (async () => {
                      const result = await deletePage(businessId, storeId, page.id);
                      setMessage({ tone: result.ok ? "info" : "warning", text: result.message });
                      await load();
                    })();
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
