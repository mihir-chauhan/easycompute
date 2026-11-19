# Workspace Summary

> Work-to-date map of this workspace (maintained by the agent). See `TEMPLATE_SUMMARY.md` for the
> template's initial state. Note: in this workspace both summaries live in `easycompute/src/`.

## Current state

**EasyCompute** — AI-assisted compute allocation and run monitoring for Purdue research labs. Generated code-first by
`templates/c3app-gen` in the C3 Code layout; all UI data comes from C3 types via `c3Call`.

## Backend types (`easycompute/src/`)

- `GpuType` (entity): inherited `name`, `vendor`, `memoryGb`, `fp16Tflops`, `relativeThroughput`, `costPerGpuHourUsd`.

## Data (`easycompute/data/`)

- `GpuType/GpuType.json` (2 rows).
- Deterministic (seed `easycompute-v1`, anchored at 2026-11-19); regenerate with the generator, do not hand-edit.
- Load: `C3.pkg().upsertAllSeed(true)` via `runJsOnLiveApp` (or `App.State.inst().get().withFields({ pkgFingerprint: -1, seeded: false }).update(); C3.pkg().upsertAllSeed()`).

## UI pages / routes (`ui/react/src/`)

| Route | Page |
| --- | --- |
| `/gpu-types` | `pages/GpuTypes/GpuTypeList.tsx` — server-side filter/sort/paginate, filters in URL params |

Shared: `components/PageFrame` (PageHeader + content; `LoadingState`, `ErrorState`, `EmptyRows`, `errorMessage`),
`components/StatusBadges` (one soft badge per enum), `components/DetailList`, `components/charts/EChart.tsx` (vendored
`lib/echarts*.ts` theme), `hooks/useLookups.ts` (reference lists for pickers), `lib/format.ts` (formatters, badge
appearance maps, `filterLiteral`, chart colors). Types and enum value arrays in `Interfaces.tsx`.

## Key decisions

- `c3Action.ts` is the canonical `c3Call` version from the c3-frontend skill; template placeholders removed.
- Font: `styles/manual-tokens.css` points `--theme-font-family-font-sans` at `Inter Variable` (the face
  `@fontsource-variable/inter` registers); `tokens.css` is untouched.
- Charts use semantic colors (badge appearance → `--c3-style-chart-*`), not the 8-hue categorical palette.
- Vendored `ui/chart.tsx` needs React 19, so `components/charts/EChart.tsx` wraps eCharts directly.
- `npm run build` needs `VITE_C3_PKG=easycompute` in a plain shell.
