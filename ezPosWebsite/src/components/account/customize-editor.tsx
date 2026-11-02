"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import {
  fetchStorefront,
  publishStorefront,
  updateDraftConfig,
  type StorefrontDetail,
} from "@/lib/api/online-store";
import {
  ADDABLE_SECTION_TYPES,
  createSection,
  moveSection,
  removeSection,
  SECTION_TYPE_LABELS,
  TOKEN_FIELDS,
  toggleSection,
  updateSectionProps,
  type StorefrontConfig,
} from "@/lib/online-store-helpers";
import { MediaPicker } from "./media-picker";

/** Which props each section type exposes in the editor. */
const PROP_FIELDS: Record<
  string,
  Array<{
    key: string;
    label: string;
    kind: "text" | "textarea" | "url" | "image" | "select" | "number";
    options?: Array<{ value: string; label: string }>;
  }>
> = {
  announcement: [
    { key: "text", label: "Text", kind: "text" },
    { key: "linkUrl", label: "Link (optional)", kind: "url" },
  ],
  hero: [
    { key: "heading", label: "Heading", kind: "text" },
    { key: "subheading", label: "Subheading", kind: "textarea" },
    { key: "imageUrl", label: "Background image", kind: "image" },
    { key: "ctaLabel", label: "Button label", kind: "text" },
    { key: "ctaHref", label: "Button link", kind: "url" },
    {
      key: "align",
      label: "Alignment",
      kind: "select",
      options: [
        { value: "left", label: "Left" },
        { value: "center", label: "Center" },
        { value: "right", label: "Right" },
      ],
    },
    { key: "overlayOpacity", label: "Image overlay (0-100)", kind: "number" },
  ],
  "featured-categories": [{ key: "heading", label: "Heading", kind: "text" }],
  "featured-products": [{ key: "heading", label: "Heading", kind: "text" }],
  "best-sellers": [
    { key: "heading", label: "Heading", kind: "text" },
    { key: "limit", label: "Products to show (1-12)", kind: "number" },
  ],
  "new-arrivals": [
    { key: "heading", label: "Heading", kind: "text" },
    { key: "limit", label: "Products to show (1-12)", kind: "number" },
  ],
  "promo-banners": [{ key: "heading", label: "Heading", kind: "text" }],
  brands: [{ key: "heading", label: "Heading", kind: "text" }],
  testimonials: [{ key: "heading", label: "Heading", kind: "text" }],
  newsletter: [
    { key: "heading", label: "Heading", kind: "text" },
    { key: "subheading", label: "Subheading", kind: "textarea" },
    { key: "buttonLabel", label: "Button label", kind: "text" },
  ],
};

export function CustomizeEditor() {
  const params = useParams<{ id: string }>();
  const storeId = Number(params?.id);
  const { businessId } = useActiveBusiness();
  const [store, setStore] = useState<StorefrontDetail | null>(null);
  const [config, setConfig] = useState<StorefrontConfig | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "warning"; text: string; role?: "alert" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!businessId || !Number.isInteger(storeId) || storeId <= 0) return;
    const result = await fetchStorefront(businessId, storeId);
    if (result.ok && result.data) {
      setStore(result.data);
      setConfig(result.data.draftConfig as unknown as StorefrontConfig);
    } else {
      setMessage({ tone: "warning", text: result.message, role: "alert" });
    }
  }, [businessId, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(): Promise<boolean> {
    if (!businessId || !config) return false;
    setBusy(true);
    const result = await updateDraftConfig(businessId, storeId, config);
    setBusy(false);
    setMessage({
      tone: result.ok ? "info" : "warning",
      text: result.ok ? "Draft saved. Publish to make it live." : result.message,
      role: result.ok ? undefined : "alert",
    });
    return result.ok;
  }

  async function saveAndPublish() {
    if (!(await save())) return;
    if (!businessId) return;
    setBusy(true);
    const result = await publishStorefront(businessId, storeId);
    setBusy(false);
    setMessage({
      tone: result.ok ? "info" : "warning",
      text: result.message,
      role: result.ok ? undefined : "alert",
    });
    await load();
  }

  function patch(sectionId: string, key: string, value: unknown) {
    setConfig((current) =>
      current ? updateSectionProps(current, sectionId, { [key]: value }) : current,
    );
  }

  if (!store || !config) {
    return message ? (
      <Alert tone={message.tone} title={message.text} role={message.role ?? "status"} />
    ) : (
      <p className="text-sm text-slate-500" role="status">Loading editor…</p>
    );
  }

  return (
    <div className="space-y-8">
      {message ? (
        <Alert tone={message.tone} title={message.text} role={message.role ?? "status"} />
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold text-slate-900">Design</h2>
        <p className="mt-1 text-sm text-slate-600">
          Colors, typography and layout for your whole store.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TOKEN_FIELDS.map((field) => {
            const value = config.tokens[field.key] ?? "";
            return (
              <div key={field.key}>
                <label
                  htmlFor={`token-${field.key}`}
                  className="block text-sm font-medium text-slate-700"
                >
                  {field.label}
                </label>
                {field.kind === "color" ? (
                  <span className="mt-1 flex items-center gap-2">
                    <input
                      id={`token-${field.key}`}
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
                      onChange={(event) =>
                        setConfig((current) =>
                          current
                            ? {
                                ...current,
                                tokens: {
                                  ...current.tokens,
                                  [field.key]: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                      className="h-9 w-14 cursor-pointer rounded border border-slate-300"
                    />
                    <input
                      value={value}
                      onChange={(event) =>
                        setConfig((current) =>
                          current
                            ? {
                                ...current,
                                tokens: {
                                  ...current.tokens,
                                  [field.key]: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                      className="w-28 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                      aria-label={`${field.label} hex value`}
                    />
                  </span>
                ) : (
                  <select
                    id={`token-${field.key}`}
                    value={value}
                    onChange={(event) =>
                      setConfig((current) =>
                        current
                          ? {
                              ...current,
                              tokens: {
                                ...current.tokens,
                                [field.key]: event.target.value,
                              },
                            }
                          : current,
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">Default</option>
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900">Homepage sections</h2>
          <span className="text-xs text-slate-500">Top to bottom = live order</span>
        </div>

        <ul className="mt-4 space-y-2">
          {config.sections.map((section, index) => (
            <li
              key={section.id}
              className="rounded-lg border border-slate-200 bg-slate-50/60"
            >
              <div className="flex flex-wrap items-center gap-2 p-3">
                <span className="flex-1 text-sm font-medium text-slate-900">
                  {SECTION_TYPE_LABELS[section.type] ?? section.type}
                  {section.enabled ? null : (
                    <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-500">
                      hidden
                    </span>
                  )}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setExpandedId(expandedId === section.id ? null : section.id)}>
                  {expandedId === section.id ? "Close" : "Edit"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfig((c) => (c ? moveSection(c, section.id, -1) : c))} disabled={index === 0}>
                  ↑
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfig((c) => (c ? moveSection(c, section.id, 1) : c))} disabled={index === config.sections.length - 1}>
                  ↓
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfig((c) => (c ? toggleSection(c, section.id) : c))}>
                  {section.enabled ? "Hide" : "Show"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfig((c) => (c ? removeSection(c, section.id) : c))}>
                  Remove
                </Button>
              </div>

              {expandedId === section.id ? (
                <div className="space-y-3 border-t border-slate-200 bg-white p-4">
                  {(PROP_FIELDS[section.type] ?? []).map((field) => {
                    const value = section.props[field.key];
                    const fieldId = `${section.id}-${field.key}`;
                    if (field.kind === "select") {
                      return (
                        <div key={field.key}>
                          <label htmlFor={fieldId} className="block text-sm font-medium text-slate-700">
                            {field.label}
                          </label>
                          <select
                            id={fieldId}
                            value={String(value ?? "")}
                            onChange={(event) => patch(section.id, field.key, event.target.value)}
                            className="mt-1 w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm"
                          >
                            <option value="">Default</option>
                            {field.options?.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    }
                    if (field.kind === "textarea") {
                      return (
                        <div key={field.key}>
                          <label htmlFor={fieldId} className="block text-sm font-medium text-slate-700">
                            {field.label}
                          </label>
                          <textarea
                            id={fieldId}
                            value={String(value ?? "")}
                            onChange={(event) => patch(section.id, field.key, event.target.value)}
                            maxLength={240}
                            rows={2}
                            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                          />
                        </div>
                      );
                    }
                    if (field.kind === "image") {
                      return (
                        <div key={field.key}>
                          <label htmlFor={fieldId} className="block text-sm font-medium text-slate-700">
                            {field.label}
                          </label>
                          <div className="mt-1 flex items-center gap-2">
                            <input
                              id={fieldId}
                              value={String(value ?? "")}
                              onChange={(event) => patch(section.id, field.key, event.target.value)}
                              placeholder="Upload or paste an image URL"
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                            />
                            <Button size="sm" variant="outline" onClick={() => setPickerFor(section.id)}>
                              Browse
                            </Button>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={field.key}>
                        <label htmlFor={fieldId} className="block text-sm font-medium text-slate-700">
                          {field.label}
                        </label>
                        <input
                          id={fieldId}
                          type={field.kind === "number" ? "number" : "text"}
                          value={String(value ?? "")}
                          onChange={(event) =>
                            patch(
                              section.id,
                              field.key,
                              field.kind === "number"
                                ? Number(event.target.value)
                                : event.target.value,
                            )
                          }
                          className="mt-1 w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="mt-4">
          <p className="text-sm font-medium text-slate-700">Add a section</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {ADDABLE_SECTION_TYPES.map((type) => (
              <Button
                key={type}
                size="sm"
                variant="outline"
                onClick={() => {
                  const section = createSection(type);
                  setExpandedId(section.id);
                  setConfig((current) =>
                    current
                      ? { ...current, sections: [...current.sections, section] }
                      : current,
                  );
                }}
              >
                + {SECTION_TYPE_LABELS[type]}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold text-slate-900">Navigation menu</h2>
        <p className="mt-1 text-sm text-slate-600">
          Links shown in your store header and footer. Use paths like{" "}
          <code className="rounded bg-slate-100 px-1">/products</code> or full
          page links like <code className="rounded bg-slate-100 px-1">/pages/about-us</code>.
        </p>
        <NavLinksEditor
          title="Header links"
          links={config.navigation?.header ?? []}
          max={8}
          onChange={(links) =>
            setConfig((current) =>
              current
                ? {
                    ...current,
                    navigation: {
                      header: links,
                      footer: current.navigation?.footer ?? [],
                    },
                  }
                : current,
            )
          }
        />
        <NavLinksEditor
          title="Footer links"
          links={config.navigation?.footer ?? []}
          max={12}
          onChange={(links) =>
            setConfig((current) =>
              current
                ? {
                    ...current,
                    navigation: {
                      header: current.navigation?.header ?? [],
                      footer: links,
                    },
                  }
                : current,
            )
          }
        />
      </section>

      <div className="sticky bottom-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save draft"}
        </Button>
        <Button variant="outline" onClick={() => void saveAndPublish()} disabled={busy}>
          Save & publish
        </Button>
        <span className="text-xs text-slate-500">
          Drafts never affect your live store until you publish.
        </span>
      </div>

      <MediaPicker
        open={pickerFor !== null}
        onPick={(url) => {
          if (pickerFor) patch(pickerFor, "imageUrl", url);
        }}
        onClose={() => setPickerFor(null)}
      />
    </div>
  );
}

function NavLinksEditor({  title,
  links,
  max,
  onChange,
}: {
  title: string;
  links: Array<{ label: string; href: string }>;
  max: number;
  onChange: (links: Array<{ label: string; href: string }>) => void;
}) {
  return (
    <div className="mt-4">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      <ul className="mt-2 space-y-2">
        {links.map((link, index) => (
          <li key={index} className="flex items-center gap-2">
            <input
              value={link.label}
              aria-label={`${title} link ${index + 1} label`}
              onChange={(event) => {
                const next = [...links];
                next[index] = { ...link, label: event.target.value };
                onChange(next);
              }}
              className="w-40 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="Label"
            />
            <input
              value={link.href}
              aria-label={`${title} link ${index + 1} URL`}
              onChange={(event) => {
                const next = [...links];
                next[index] = { ...link, href: event.target.value };
                onChange(next);
              }}
              className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="/products"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange(links.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {links.length < max ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => onChange([...links, { label: "", href: "" }])}
        >
          + Add link
        </Button>
      ) : null}
    </div>
  );
}
