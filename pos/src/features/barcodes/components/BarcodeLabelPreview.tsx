import { useEffect, useState } from "react";
import { renderLabelPagesHtml } from "../labelRenderer.js";
import type { LabelConfig, LabelItem, LabelSize } from "../labelTemplates.js";
import { layoutLabels } from "../labelTemplates.js";

interface PreviewProps {
  items: LabelItem[];
  size: LabelSize;
  config: LabelConfig;
  copiesPerItem: number;
  shopName: string | null;
  logoDataUrl: string | null;
}

/**
 * Live label preview — the EXACT HTML the print pipeline uses (rendered
 * into a scaled-down iframe), so what you see is what prints.
 */
export function BarcodeLabelPreview(props: PreviewProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function build() {
      if (props.items.length === 0) {
        setHtml(null);
        setError(null);
        return;
      }
      try {
        const queue = props.items.flatMap((item) =>
          Array.from({ length: props.copiesPerItem }, () => item),
        );
        const pages = layoutLabels(queue, props.size, props.config);
        const document = await renderLabelPagesHtml(pages, props.config, {
          shopName: props.shopName,
          logoDataUrl: props.logoDataUrl,
        });
        if (!cancelled) {
          setHtml(document);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Preview failed.");
        }
      }
    }
    void build();
    return () => {
      cancelled = true;
    };
  }, [props.items, props.size, props.config, props.copiesPerItem, props.shopName, props.logoDataUrl]);

  if (props.items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
        Select products or variants to see the label preview.
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
        {error}
      </div>
    );
  }
  if (html === null) {
    return <div className="p-6 text-center text-sm text-slate-400">Rendering preview…</div>;
  }
  const scale = Math.min(1, 560 / (props.size.widthMm * (props.size.kind === "a4" ? 3.23 : 1)));
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-3">
      <iframe
        title="Label preview"
        srcDoc={html}
        className="h-64 w-full border-0 bg-white"
        sandbox="allow-same-origin"
        style={{ transform: `scale(${Math.max(0.5, Math.min(1, scale))})`, transformOrigin: "top left" }}
      />
      <p className="mt-2 text-xs text-slate-500">
        {props.items.length} item(s) × {props.copiesPerItem} copy/copies — first page shown.
      </p>
    </div>
  );
}
