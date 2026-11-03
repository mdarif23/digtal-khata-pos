import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { Loader2 } from "lucide-react";

interface LivePreviewProps {
  html: string | null;
  /** CSS width of the document, e.g. "58mm" or "210mm". */
  paperWidthCss: string;
  mode: "receipt" | "invoice";
  rendering: boolean;
}

/**
 * Live preview pane — renders the SAME standalone HTML the printer receives
 * inside an iframe (srcDoc). What you see here is byte-for-byte what prints.
 */
export function LivePreview({ html, paperWidthCss, mode, rendering }: LivePreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = useState(560);

  // Resize the iframe to its content after each re-render.
  useEffect(() => {
    if (!html) return;
    const timer = setTimeout(() => {
      const frame = iframeRef.current;
      const doc = frame?.contentDocument;
      if (doc?.body) {
        setFrameHeight(Math.max(320, doc.body.scrollHeight + 24));
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [html]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Live Preview</CardTitle>
          <div className="flex items-center gap-2">
            {rendering && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            <Badge variant="secondary" className="uppercase">
              {mode === "receipt" ? "Receipt" : "Invoice"} · {paperWidthCss}
            </Badge>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Sample transaction — nothing here creates a sale. The preview uses
          the exact template your printer receives.
        </p>
      </CardHeader>
      <CardContent className="bg-zinc-100 p-4">
        <div className="flex justify-center">
          {html ? (
            <iframe
              ref={iframeRef}
              title="Document preview"
              srcDoc={html}
              className="rounded-sm border border-zinc-300 bg-white shadow-lg"
              style={{ width: paperWidthCss, height: frameHeight }}
              sandbox="allow-same-origin"
            />
          ) : (
            <div className="flex h-72 w-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Rendering preview…
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
