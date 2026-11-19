# EasyCompute design system (`@/components/app`)

Owner: ui-admin. Everything here is token-driven and works in light and dark mode. Pages never use raw hex colours.

## Identity
- Calm neutral UI (grey page `bg-page`, white cards). Accent = **Purdue black + old gold, used sparingly**:
  primary buttons are black (gold in dark mode), links / active nav / focus / selection are gold
  (`--c3-style-basic-fg-accent` = Aged gold #8E6F3E). The top bar is black with a gold mark in both themes.
- Font: Inter Variable (fixed in `styles/manual-tokens.css`). Headings semibold.
- Type scale: page title 24/600 (PageFrame), card title 15/600 (SectionCard), body 14, secondary 12-13 muted
  (`text-[var(--c3-style-basic-fg-secondary)]`), KPI value 28/600 tabular.
- Spacing: 4px grid; page padding 24 (16 on phones), 16px gaps, 20px card padding, content max-width 1440.
- Cards: 1px border, 8px radius, hairline shadow. Tables: 40px single-line rows, right-aligned tabular numbers.
- Badges: ONE style (soft). Never colour a number by magnitude unless it is a status (use tones).

## Colour by meaning (`tone.ts`, tokens in `styles/manual-tokens.css`)
| Meaning | Tone | Token | Use |
|---|---|---|---|
| good / healthy | `good` | `--ec-good` | util >= 70%, completed, pass, on-track burn |
| warning | `warn` | `--ec-warn` | 40-70% util, burn ahead of time, WARN rules |
| bad / critical | `bad` | `--ec-bad` | < 40% util, failed, OOM, critical, BLOCK |
| idle / other / unknown | `neutral` | `--ec-neutral` | idle GPU-hours, cancelled |
| highlight | `accent` | `--ec-accent` | running, Purdue, selected, autopilot |
| default single series | — | `--ec-ink` (Purdue Steel) | any one-series chart |
| target / limit marker | — | `--ec-target` | dashed target lines, elapsed marker |

Clusters: `--ec-cluster-{anvil,gilbreth,gautschi,negishi,bell,aws-p4d}`; billing:
`--ec-billing-{in-house,access,third-party}` (in-house = gold, ACCESS = steel blue, third-party = clay; Anvil is
ACCESS-blue and AWS is clay, so the two encodings agree). Helpers: `clusterColor(id)`, `billingColor(b)`,
`toneColor(t)` (resolved strings for eCharts), `CLUSTER_BG[id]`, `BILLING_BG[b]`, `TONE_BG/TONE_TEXT/TONE_FILL`
(Tailwind classes). Thresholds: `utilTone(pct)`, `efficiencyTone(frac)`, `burnTone(usedFrac, elapsedFrac)`.

## Components
```tsx
import { PageFrame, KpiRow, KpiTile, CardGrid, SectionCard, MetricChart, barOption, lineOption, DataTable,
  StatusBadge, SeverityBadge, ToneBadge, ToneDot, ClusterTag, BillingTag, BudgetBurn, ProgressBar, Sparkline,
  Countdown, EmptyState, ErrorState, KpiRowSkeleton, TableSkeleton, SearchBox, Segmented, ResultCount,
  ClearFilters, useC3Data, useThemeKey, useAppShell, clusterColor, toneColor } from '@/components/app';
```
- **PageFrame** `title description breadcrumbs actions badges tabs toolbar` — every page. `toolbar` = one row:
  `<SearchBox/> <Segmented/> <ClearFilters/> <ResultCount>12 policies</ResultCount>`.
- **KpiRow / KpiTile** — max 4 tiles. `<KpiTile label="GPU utilization" value="71" unit="%" caption="last 7 days"
  tone="warn" trend={[..]} trendTone="good" delta={{ text: '+4 pts', tone: 'good', direction: 'up' }} help="..." onClick />`.
- **CardGrid** `layout="halves" | "thirds" | "two-one" | "one-two" | "quarters"` — dashboard rows, stack < 1024px.
- **SectionCard** `title subtitle actions footer flush` — the one card. `flush` for tables/lists.
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
- **AppShell / AppShellProvider / useAppShell** — app chrome proposal for the integrator (see header comment in
  `AppShell.tsx`). `useAppShell().labId` = the demo "logged-in" lab; works outside the provider (returns null).

## Rules
- Theme changes go ONLY in `styles/manual-tokens.css` (+ `.dark` twin) and the unlayered block at the end of
  `globals.css`. Never edit `styles/tokens.css` or `components/ui/*`. Plain Tailwind utilities on vendored
  components lose to their SCSS: use `utility!` or a `:root .bem` rule.
- Dashboards: <= 4 KPI tiles, then 2/3+1/3 or 1/2+1/2 rows, <= 4 charts; breakdowns as bars, not donuts.
- Phones (390px): no horizontal page scroll; hide low-value table columns with `hideBelow`.
