# EasyCompute design system (`@/components/app`)

Owner: ui-admin. Everything here is token-driven and works in light and dark mode. Pages never use raw hex colours.

## Identity (owner direction: match the "Gantry" mockups, input/gantry-mockups)
- DARK ONLY. Page #181818, tiles #232323, thin #2f2f2f borders (#464646 for controls), text #d1d1d1, headings
  #fff, muted #a3a3a3 / #747474. Bright green accent #7fee64 (primary buttons with #132010 text, active nav,
  running, chart line); green text #6ac345; amber #e8b54d warn; red #f2766b crit; blue #79a4c4 info; pink #d176bd
  (PI approval / Lab admin); violet #a78bfa. CSS vars: `--ec-bg --ec-card --ec-card-2 --ec-line --ec-line-2 --ec-fg
  --ec-fg-hi --ec-fg-2 --ec-fg-3 --ec-accent-hi --ec-accent-text --ec-accent-bg --ec-warn-fg/-bg --ec-crit-fg/-bg
  --ec-blue/-bg --ec-pink/-bg --ec-strip --ec-mono` (styles/manual-tokens.css). Vendored kit components pick the
  palette up automatically (Layer-3 `--c3-style-basic-*` overridden).
- Type: Inter (UI) 14/20; page title 24/32 weight 500; description 16/24; card title 16/500 white; section 18/500;
  tile label 12, tile value 22; table header 12/500 muted. Fira Mono (`font-mono` or `.ec-mono`) for ids, times,
  limits, code. Compact: 34px controls, 12x16 table cells, 8px radius cards, 6px buttons, pill badges.
- Layout: content column max-width 1180 (left aligned), 24px gaps, page padding 28/32 (16 on phones).

## Components
```tsx
import { PageFrame, KpiRow, KpiTile, CardGrid, SectionCard, MetricChart, barOption, lineOption, DataTable,
  StatusBadge, SeverityBadge, ToneBadge, ToneDot, ClusterTag, BillingTag, BudgetBurn, ProgressBar, Sparkline,
  Countdown, EmptyState, ErrorState, KpiRowSkeleton, TableSkeleton, SearchBox, Segmented, ResultCount,
  ClearFilters, useC3Data, useThemeKey, useAppShell, clusterColor, toneColor } from '@/components/app';
```
- **PageFrame** `title description breadcrumbs actions badges tabs toolbar` — every page. `toolbar` = one row:
  `<SearchBox/> <Segmented/> <ClearFilters/> <ResultCount>12 policies</ResultCount>`.
- **KpiRow / KpiTile** — max 4 tiles. `<KpiTile label="Grant compute remaining" value="$16,760" chip="of $48,000" caption="NSF IIS award · ends Aug 31, 2027"
  tone="warn" trend={[..]} trendTone="good" delta={{ text: '+4 pts', tone: 'good', direction: 'up' }} help="..." onClick />`.
- **CardGrid** `layout="halves" | "thirds" | "two-one" | "one-two" | "quarters"` — dashboard rows, stack < 1024px.
- **SectionCard** `title subtitle actions footer flush` — the one card (transparent, thin border, 18x20 header with divider, 20px body). `flush` for tables/lists; `actions` can hold muted text such as "Last 24 h".
- **MetricChart** — chart card with loading/empty/error built in:
  ```tsx
  const themeKey = useThemeKey(); // rebuild options on light/dark flip
  const option = useMemo(() => data && barOption({ categories, series: [{ name: 'GPU util', data }],
    itemColors: ids.map(clusterColor), max: 100, valueFormat: (v) => `${v}%`,
    thresholds: [{ value: 70, label: 'Target 70%' }] }), [data, themeKey]);
  <MetricChart title="..." subtitle="..." option={option} loading={loading} error={error} onRetry={reload}
    legend={[{ label: 'Gilbreth', swatchClass: CLUSTER_BG.gilbreth }]} ariaLabel="..." />
  ```
  `lineOption({ x, series: [{ name, data, color, area, dashed }], min, max, thresholds, forecastFrom })`.
  Rules: no smoothing, no dual axes, single series = ink, HTML legend (`ChartLegend`) not the canvas legend.
- **DataTable** `columns rows rowKey onRowClick loading emptyLabel emptyHint emptyAction initialSort pageSize` —
  client-side sort; columns `{ key, header, render, sortValue, align: 'right', className, hideBelow: 'md' }`.
  Wrap in `<SectionCard flush>`. For big server-paged lists copy `pages/GpuTypes/GpuTypeList.tsx`.
- **Pill** `tone` (+`dot`, `pulse`) — the mockups' ".st" badge; `ToneBadge` = Pill. Tones: good, accent (running,
  green), info (queued, blue), warn, bad, neutral (off), pink (PI approval).
- **Mockup blocks** (`Blocks.tsx`): `Note` (callout, tone info/good/warn/bad), `CodeBlock code title` (sbatch syntax
  colours + Copy), `CheckRow status=ok|warn|crit|info title detail right` (rule checks), `AttentionItem tone title
  action` ("Needs your attention"), `EventRow time icon title detail` (agent activity / action history),
  `KeyValue items` (".kv"), `Chips items`, `Toggle on onChange label` (".switch"), `SectionHeading`.
- **Toolbar**: `SearchBox`, `Segmented` (".seg" with count chips), `SelectPill label value options` ("Cluster: All ▾"),
  `ClearFilters`, `ResultCount`, `PageTabs tabs value onChange` (underline tabs, e.g. Launch planner steps).
- **ModelComputing** `component verb? variant='inline'|'card'|'overlay' active? children?` — every place a MODEL_MAP
  component runs: pulsing green dot + "<mono>AnvilRuntimeQ50Q90</mono> is computing…" (role=status). `verb` e.g.
  `is checking 49 rules`. `card` adds skeleton lines; `overlay` dims its children while `active`.
- **ModelProvenance** `component provenance? compact?` — chip (cpu icon, mono name, version, "historical" tag) opening a
  popover: method, version / policy version, training period, sample support, P50/P90 (+unit), confidence, sources,
  "Historical only" note. Defaults come from `MODEL_CATALOG` (all 13 MODEL_MAP components); pass the backend
  `provenance` object to add version/support/P50/P90. Helpers: `provenanceOf(res)`, `provenanceFor(res, component)`
  (handles a single object, an array, a map keyed by component, or `<section>.provenance`). `MetricChart` takes
  `model` + `provenance` and does both automatically (computing line while loading, chip in the header after).
- **StatusBadge** `kind="jobState|alertSeverity|alertStatus|ruleSeverity|ruleScope|checkOutcome|runRequestStatus|clusterStatus|actionOutcome|actor" value=...`;
  `SeverityBadge value="CRITICAL|WARNING|INFO|BLOCK|WARN"`; `ToneBadge tone>text`; `ToneDot tone label`.
- **BudgetBurn** `used total elapsed format compact` — bar + elapsed-period marker, toned by burn rate.
  **ProgressBar** `value(0-1) tone marker size`.
- **Sparkline** `values tone domain area` — SVG, cheap in tables/tiles.
- **Countdown** `to | hoursLeft warnHours badHours suffix` — "3h 12m left", warn/bad colouring, ticks every 30 s.
- **ClusterTag** `id name`, **BillingTag** `billing`.
- **States**: `KpiRowSkeleton`, `ChartSkeleton`, `TableSkeleton`, `Skeleton`, `EmptyState icon title hint action`,
  `ErrorState message onRetry`. Every data view shows loading / empty / error.
- **useC3Data(loader, deps, pollMs?)** → `{ data, loading, error, reload }`; cancels on unmount (StrictMode-safe),
  reports errors, polls no faster than 5 s.
- **AppShell / AppShellProvider / useAppShell** — Gantry shell: announcement strip, 52px top bar (logo, workspace
  switcher = lab + "Lab admin" pill, menu also switches to Research Computing; "/ all clusters" scope; Search ⌘K
  palette; Cluster health; Budget; bell; settings; avatar), grouped sidebar with badges and allocation meters.
  Nav items: `{ path, label, icon, group?: 'Before a run' | 'During a run' | 'Lab', badge?: number | '2 live' | 'New',
  badgeTone?: 'live' | 'new', hidden? }`. `useAppShell()` -> `{ labId, lab, setLabId, view, clusterId }`.

## Rules
- Dark only: never add light-mode styles. Theme changes go ONLY in `styles/manual-tokens.css` (+ `.dark` twin) and the unlayered block at the end of
  `globals.css`. Never edit `styles/tokens.css` or `components/ui/*`. Plain Tailwind utilities on vendored
  components lose to their SCSS: use `utility!` or a `:root .bem` rule.
- Dashboards: <= 4 KPI tiles, then 2/3+1/3 or 1/2+1/2 rows, <= 4 charts; breakdowns as bars, not donuts.
- Phones (390px): no horizontal page scroll; hide low-value table columns with `hideBelow`.
