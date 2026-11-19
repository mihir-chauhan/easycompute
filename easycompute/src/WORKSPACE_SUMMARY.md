# Workspace Summary

> Work-to-date map of this workspace (maintained by the agent). See `TEMPLATE_SUMMARY.md` for the
> template's initial state. Note: in this workspace both summaries live in `easycompute/src/`.

## Current state

**EasyCompute** — AI-assisted compute allocation and run monitoring for Purdue research labs. Generated code-first by
`templates/c3app-gen` in the C3 Code layout; all UI data comes from C3 types via `c3Call`.

## Backend types (`easycompute/src/`)

Response shapes and method contracts: `project/API.md`. Platform-name collisions forced `ComputeCluster` (not Cluster),
`JobAlert` (not Alert; field `alertType`), `ActionLogEntry` (not ActionLog; field `actedAt`), `RunMonitor` (not Monitor).

- Reference entities: `GpuType`, `ComputeCluster` (+ `.Billing`, `.Status`), `Partition` (one row per partition + QOS),
  `Lab`, `LabMember` (+ `.Role`), `Allocation` (+ `.Funding`), `Project`, `Policy` (+ `.Scope`, `.Severity`, `.Kind`),
  `AutopilotPolicy` (id = lab id). Shared enums `WorkloadType`, `ActionType`.
- Planner: `RunRequest` (+ `.Status`; `checkRules`, `recommendPlans`, `submit` in `RunRequest.js`), `RuleCheck`
  (+ `.Outcome`), `RunPlan` (+ `.Label`). Rule engine evaluates each Policy per candidate (partition x GPU count)
  and aggregates PASS/WARN/FAIL; plans are scored on finish time, cost, risk, deadline slack.
- Runs: `Job` (+ `.State`; `gpuHours`/`wastedGpuHours` are on-read calcs; `evaluateHealth`, `applyAction` in `Job.js`),
  `JobMetric`, `JobAlert` (+ `.AlertType`, `.Severity`, `.Status`), `ActionLogEntry` (+ `.Actor`, `.Outcome`).
- `RunMonitor.tick()` (`RunMonitor.js`): 15-minute simulation step + health + autopilot; CronJob seed
  `seed/CronJob/EasyComputeMonitorTick.json` (every 5 min, ships inactive).
- `Insights` (`Insights.js`): `predictDuration`, `labSummary`, `universityOverview` (all `json`). Aggregates that need
  GPU-hours are computed in JS over `fetchObjStream` (stored calcs were not populated by `upsertAllSeed`).
- Tests: `test/js-rhino/test_{RunRequest,Job,Insights}.js` (self-contained fixtures, need `testtools` in the manifest).
  Local runner without the platform: `node project/tools/backend-harness/run.js` (all methods on the seed) and
  `node project/tools/backend-harness/jasmine.js` (the Jasmine files on an in-memory mock).

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
