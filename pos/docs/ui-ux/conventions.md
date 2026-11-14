# ezPos Frontend — UI Conventions (migration guide)

Apply these when touching any page under `pos/src`. They are presentation-only rules:
**never change business logic, API payloads, validation, permissions, or route paths.**

## Page shell
- Wrap page content in `<PageContainer>` from `@/components/common/PageContainer`
  (`width="narrow"` for settings/detail, default for most, `"wide"` only for dense tables).
- First child: `<PageHeader title="…" description="…" actions={<>…</>} />` from
  `@/components/common/PageHeader` — replaces hand-rolled `<h1>` blocks. Keep one `h1` per page.
- Remove `min-h-screen` wrappers (the app shell now provides the frame).

## Money / dates / quantities
- Import from `@/lib/format`: `formatCurrency` (৳1,234.50), `formatNumber`, `formatQty`,
  `formatDate`, `formatDateTime`. Delete local `Intl.NumberFormat` money wrappers and
  `৳${x.toFixed(2)}` templates — including manual `৳ {formatCurrency(…)}` prefixes (double symbol).
- Keep business rounding helpers (e.g. `roundMoney`) — they are logic, not presentation.

## Status chips
- Use `<StatusBadge tone="success|warning|danger|info|primary|neutral">label</StatusBadge>`
  from `@/components/common/StatusBadge`. Map statuses: paid/completed/received/active/in-stock →
  `success`; partial/pending/low-stock/draft → `warning`; unpaid/failed/out-of-stock/expired/cancelled
  → `danger`; ordered/shipped/in-progress → `info`; informational → `primary`; archived/neutral → `neutral`.

## KPI tiles
- Use `<SummaryCard title value description icon />` from `@/components/common/SummaryCard`
  (pass icons as `<Icon className="size-4 text-muted-foreground" />`). Delete local copies.

## Empty states
- Use `<EmptyState icon={PackageSearch} title="…" description="…" action={<Button/>} />`
  from `@/components/common/EmptyState` for "no rows found" table bodies (as a `<TableRow><TableCell colSpan={n}>` wrapper when inside a table) and panel empties.

## Search inputs
- Use `<SearchInput value onChange placeholder ariaLabel />` from `@/components/common/SearchInput`
  instead of hand-rolled Search-icon + `pl-9` inputs — unless the input has special keyboard
  behavior (barcode scan Enter handlers) that must be preserved; keep those as-is.

## Colors
- Raw palette classes (`slate-*`, `emerald-*`, `amber-*`, `rose-*`, `sky-*`, `blue-*`, `green-*`,
  `red-*`, `violet-*`) map to tokens: money-positive/inflow → `success`; attention/pending →
  `warning`; negative/outflow/error → `destructive`; info/neutral-blue → `info`; brand accents →
  `primary`; muted text → `text-muted-foreground`; white card surfaces → `bg-card`, page canvas →
  `bg-muted/30`. Chart series may use `chart-1..5` tokens (var(--chart-N)).
- Never rely on color alone to convey status — StatusBadge always renders the label.

## Destructive actions
- Replace `window.confirm(...)` with the shared `ConfirmDeleteDialog`
  (`@/components/common/ConfirmDeleteDialog`) where it wraps a delete; for non-delete
  confirmations keep `window.confirm` unless the dialog already exists.

## Tables
- Prefer `@/components/ui/table` primitives over raw `<table>` when conversion is mechanical
  (`<table>`→`<Table>`, `<thead>`→`<TableHeader>`+`<TableRow>`, `<th>`→`<TableHead>`,
  `<tbody>`→`<TableBody>`, `<tr>`→`<TableRow>`, `<td>`→`<TableCell>` — classes on cells keep working).
- Right-align money/quantity columns (`text-right` + `tabular-nums` on the cell content).
- Numeric/font: add `tabular-nums` where numbers align.

## Dialogs
- Keep behavior; standardize `DialogContent` width to `sm:max-w-md` (confirm) / `sm:max-w-lg`
  (single-entity forms) / `sm:max-w-2xl` (multi-section) / `sm:max-w-3xl` (large forms) and rely on
  built-in scroll (`max-h-[90dvh] overflow-y-auto` only when needed).
- Footer: use `DialogFooter` with Cancel (outline) before the primary action.

## Buttons
- Native `<button>` → `Button` component when it's a simple clickable; keep aria-labels.
- One primary (default variant) action per view; everything else outline/ghost.
- Semantic variants exist and are used sparingly: `success` (approve, receive,
  complete — positive completion), `warning` (refunds and other
  attention-required financial actions), `info`, and `destructive` — which is
  SOLID red: deletes, cancel/void of business transactions, discard changes.
  Routine actions are never red (e.g. clock-out, bulk apply); a modal Cancel
  is neutral outline, cancelling a business transaction is destructive.
- Primary actions are action-BLUE (`--primary`); the ezPos green is the brand
  mark (`--sidebar-primary`) and the SUCCESS color — never a button default.

## Testing
- Tests asserting display copy (money strings, labels) must be updated to the new presentation —
  carefully, one at a time, running the affected test file: `npx vitest run <file>`.
- After each module: `npx tsc -p tsconfig.app.json --noEmit` must show **no new errors** in your
  files (pre-existing errors exist — compare against the file list in /tmp/tsc-baseline-files.txt
  if unsure), and `npx vitest run` for the module's test files must pass.
