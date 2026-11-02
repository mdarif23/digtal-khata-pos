/**
 * Renders a JSON-LD structured-data block. Server-only usage in layouts and
 * pages; the data must be built from verified content, never fabricated.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
