/*
 * EasyCompute design system — model components (MODEL_MAP.md).
 *   <ModelComputing component="AnvilRuntimeQ50Q90" />                         inline "AnvilRuntimeQ50Q90 is computing…"
 *   <ModelComputing component="ClusterPolicyEngine" verb="is checking 49 rules" variant="card" />
 *   <ModelComputing component="LabFairShareAllocator" variant="overlay" active={loading}>{chart}</ModelComputing>
 *   <ModelProvenance component="AnvilRuntimeQ50Q90" provenance={res.provenance} />  chip + popover
 * MODEL_CATALOG holds the owner's spec for every component (method, training, historical-only); a backend
 * `provenance` object (version, training period, sample support, P50/P90, …) overrides/extends it when present.
 */

import React, { type ReactNode } from 'react';
import { Cpu, Info } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

import { KeyValue } from './Blocks';
import { Pill } from './StatusBadge';

/* ----------------------------------------------------------------- catalogue ----------------------------------------------------------------- */

export type ModelKind = 'learned' | 'rules' | 'llm' | 'statistical' | 'aggregation';

export interface ModelSpec {
  name: string;
  method: string;
  kind: ModelKind;
  training: string;
  historicalOnly?: boolean;
  /** What the component is used for (one line). */
  purpose: string;
}

export const MODEL_CATALOG: Record<string, ModelSpec> = {
  LabContextExtractor: { name: 'LabContextExtractor', method: 'Schema-constrained LLM + validation, evidence spans', kind: 'llm', training: 'No fine-tune; validated, lab confirms', purpose: 'Lab context extraction' },
  ClusterPolicyEngine: { name: 'ClusterPolicyEngine', method: 'Versioned deterministic rules', kind: 'rules', training: 'None (rules from RCAC / ACCESS docs + lab rules)', purpose: 'Purdue, cluster and lab rules' },
  AnvilRuntimeQ50Q90: { name: 'AnvilRuntimeQ50Q90', method: 'LinearQuantileRegressor (pinball loss), P50 + P90 heads', kind: 'learned', training: 'Completed Anvil parent jobs; temporal holdout', historicalOnly: true, purpose: 'Runtime estimate' },
  AnvilQueueWaitQ50Q90: { name: 'AnvilQueueWaitQ50Q90', method: 'LinearQuantileRegressor (pinball loss)', kind: 'learned', training: 'Started Anvil parent jobs; no backlog snapshots (low confidence)', historicalOnly: true, purpose: 'Queue wait estimate' },
  AnvilTaskCPUQ50Q90: { name: 'AnvilTaskCPUQ50Q90', method: 'LinearQuantileRegressor (pinball loss)', kind: 'learned', training: 'Parent requests + batch-step AveCPU', historicalOnly: true, purpose: 'CPU demand evidence' },
  AnvilHostMemoryQ50Q90: { name: 'AnvilHostMemoryQ50Q90', method: 'LinearQuantileRegressor (pinball loss)', kind: 'learned', training: 'Parent requests + batch-step TRES memory', historicalOnly: true, purpose: 'Host memory estimate' },
  GPUShapeAdvisor: { name: 'GPUShapeAdvisor', method: 'Hardware catalogue + deterministic rules', kind: 'rules', training: 'None (no GPU evidence in archive)', purpose: 'GPU type / count recommendation' },
  LabFairShareAllocator: { name: 'LabFairShareAllocator', method: 'Weighted deficit round robin; weighted max-min', kind: 'statistical', training: 'None', purpose: 'Fairness & launch ordering' },
  GPUUnderuseDetector: { name: 'GPUUnderuseDetector', method: 'EWMA / CUSUM over DCGM telemetry', kind: 'statistical', training: 'Run’s own baseline (needs telemetry feed)', purpose: 'Live GPU underuse' },
  GuardrailRuleEngine: { name: 'GuardrailRuleEngine', method: 'State machine with hysteresis', kind: 'rules', training: 'None; user confirms consequential actions', purpose: 'Memory / walltime / failure guardrails' },
  AllocationBurnForecaster: { name: 'AllocationBurnForecaster', method: 'Deterministic ledger + EWMA + low/base/high scenarios', kind: 'statistical', training: 'None', purpose: 'Allocation burn / run-out risk' },
  PolicyRAGAdvisor: { name: 'PolicyRAGAdvisor', method: 'RAG with source citations', kind: 'llm', training: 'No fine-tune; retrieval + citation eval', purpose: 'AI Advisor (explains, never acts)' },
  ClusterCapacityAggregator: { name: 'ClusterCapacityAggregator', method: 'Normalized metrics + constrained ranking', kind: 'aggregation', training: 'None', purpose: 'Cluster / university overview' },
};

/** Backend `provenance` object (API.md). All fields optional; unknown extras are shown as-is. */
export interface Provenance {
  component?: string;
  version?: string;
  method?: string;
  model?: string;
  trainingPeriod?: string;
  trainedFrom?: string;
  trainedTo?: string;
  sampleSupport?: number;
  samples?: number;
  support?: number;
  p50?: number;
  p90?: number;
  unit?: string;
  historicalOnly?: boolean;
  confidence?: string;
  asOf?: string;
  policyVersion?: string;
  rulesEvaluated?: number;
  sources?: string[];
  [key: string]: unknown;
}

/** Pull `provenance` off any API response (or return null). */
export const provenanceOf = (res: unknown): Provenance | null =>
  res && typeof res === 'object' && 'provenance' in res && (res as { provenance?: unknown }).provenance && typeof (res as { provenance?: unknown }).provenance === 'object'
    ? ((res as { provenance: Provenance }).provenance)
    : null;

/**
 * Provenance for one component from a response that may carry `provenance` as a single object, an array, or a map
 * keyed by component name (also looks at nested `<section>.provenance`).
 */
export function provenanceFor(res: unknown, component: string): Provenance | null {
  if (!res || typeof res !== 'object') return null;
  const p = (res as { provenance?: unknown }).provenance;
  if (Array.isArray(p)) return (p.find((x) => x && typeof x === 'object' && (x as Provenance).component === component) as Provenance) ?? null;
  if (p && typeof p === 'object') {
    const obj = p as Record<string, unknown>;
    if (obj[component] && typeof obj[component] === 'object') return obj[component] as Provenance;
    if (!obj.component || obj.component === component) return obj as Provenance;
  }
  for (const v of Object.values(res as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = (v as { provenance?: Provenance }).provenance;
      if (inner && typeof inner === 'object' && inner.component === component) return inner;
    }
  }
  return null;
}

/* --------------------------------------------------------------- ModelComputing --------------------------------------------------------------- */

interface ModelComputingProps {
  /** Exact component name from MODEL_MAP.md. */
  component: string;
  /** Verb phrase after the name. Default "is computing". */
  verb?: string;
  variant?: 'inline' | 'card' | 'overlay';
  /** overlay: show the overlay only while active. */
  active?: boolean;
  /** overlay: the content under the overlay. */
  children?: ReactNode;
  className?: string;
}

function Line({ component, verb }: { component: string; verb: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-[13px] text-[var(--ec-fg-2)]">
      <span aria-hidden className="ec-pulse inline-block size-[7px] shrink-0 rounded-full bg-[var(--ec-accent-hi)]" />
      <span className="min-w-0 truncate">
        <span className="font-mono text-[12.5px] text-[var(--ec-fg-hi)]">{component}</span> {verb}…
      </span>
    </span>
  );
}

/** "<ComponentName> is computing…" with a pulsing green dot (role=status, polite). */
export function ModelComputing({ component, verb = 'is computing', variant = 'inline', active = true, children, className }: ModelComputingProps) {
  const label = `${component} ${verb}`;
  if (variant === 'overlay') {
    return (
      <div className={cn('relative', className)} aria-busy={active || undefined}>
        {children}
        {active ? (
          <div role="status" aria-live="polite" aria-label={label} className="absolute inset-0 z-[2] grid place-items-center rounded-[inherit] bg-[rgb(24_24_24/0.72)] backdrop-blur-[1px]">
            <span className="rounded-full border border-[var(--ec-line-2)] bg-[var(--ec-card)] px-3 py-1.5">
              <Line component={component} verb={verb} />
            </span>
          </div>
        ) : null}
      </div>
    );
  }
  if (!active) return null;
  if (variant === 'card') {
    return (
      <div role="status" aria-live="polite" aria-label={label} className={cn('flex flex-col gap-3 py-2', className)}>
        <Line component={component} verb={verb} />
        <div className="flex flex-col gap-2" aria-hidden>
          <span className="ec-skeleton h-2.5 w-11/12" />
          <span className="ec-skeleton h-2.5 w-3/4" />
          <span className="ec-skeleton h-2.5 w-5/6" />
        </div>
      </div>
    );
  }
  return (
    <span role="status" aria-live="polite" aria-label={label} className={className}>
      <Line component={component} verb={verb} />
    </span>
  );
}

/* --------------------------------------------------------------- ModelProvenance --------------------------------------------------------------- */

const fmtNum = (v: number, unit?: string) => `${v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 2 : 1 })}${unit ? ` ${unit}` : ''}`;

interface ModelProvenanceProps {
  component: string;
  provenance?: Provenance | null;
  /** Hide the version text in the chip (popover still shows it). */
  compact?: boolean;
  className?: string;
}

/** Compact chip (icon + mono name + version) that opens a popover with method, training, support, P50/P90. */
export function ModelProvenance({ component, provenance, compact, className }: ModelProvenanceProps) {
  const name = provenance?.component ?? component;
  const spec = MODEL_CATALOG[name];
  const p = provenance ?? {};
  const support = p.sampleSupport ?? p.samples ?? p.support;
  const period = p.trainingPeriod ?? (p.trainedFrom || p.trainedTo ? `${p.trainedFrom ?? '…'} → ${p.trainedTo ?? '…'}` : undefined);
  const historical = p.historicalOnly ?? spec?.historicalOnly ?? false;
  const known = new Set(['component', 'version', 'method', 'model', 'trainingPeriod', 'trainedFrom', 'trainedTo', 'sampleSupport', 'samples', 'support', 'p50', 'p90', 'unit', 'historicalOnly', 'confidence', 'asOf', 'policyVersion', 'rulesEvaluated', 'sources']);
  const extras = Object.entries(p).filter(([k, v]) => !known.has(k) && v != null && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'));

  const items = [
    { label: 'Method', value: p.method ?? p.model ?? spec?.method ?? '—' },
    ...(p.version ? [{ label: 'Version', value: <span className="font-mono text-[12.5px]">{p.version}</span> }] : []),
    ...(p.policyVersion ? [{ label: 'Policy version', value: <span className="font-mono text-[12.5px]">{p.policyVersion}</span> }] : []),
    ...(p.rulesEvaluated != null ? [{ label: 'Rules evaluated', value: p.rulesEvaluated.toLocaleString('en-US') }] : []),
    { label: 'Training', value: period ?? spec?.training ?? '—' },
    ...(support != null ? [{ label: 'Sample support', value: `${support.toLocaleString('en-US')} jobs` }] : []),
    ...(p.p50 != null ? [{ label: 'P50', value: <span className="tabular-nums">{fmtNum(p.p50, p.unit)}</span> }] : []),
    ...(p.p90 != null ? [{ label: 'P90', value: <span className="tabular-nums">{fmtNum(p.p90, p.unit)}</span> }] : []),
    ...(p.confidence ? [{ label: 'Confidence', value: String(p.confidence) }] : []),
    ...(p.sources?.length ? [{ label: 'Sources', value: p.sources.join(', ') }] : []),
    ...(p.asOf ? [{ label: 'As of', value: new Date(p.asOf).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }] : []),
    ...extras.map(([k, v]) => ({ label: k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), value: String(v) })),
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Provenance: ${name}`}
          className={cn(
            'inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-md border border-[var(--ec-line-2)] px-1.5 text-[11px] whitespace-nowrap text-[var(--ec-fg-2)] hover:border-[var(--ec-fg-3)] hover:text-[var(--ec-fg-hi)]',
            className,
          )}
        >
          <Cpu className="size-3 shrink-0 text-[var(--ec-accent-text)]" aria-hidden />
          <span className="truncate font-mono text-[11px] text-[var(--ec-fg)]">{name}</span>
          {!compact && p.version ? <span className="font-mono text-[var(--ec-fg-3)]">{p.version}</span> : null}
          {historical ? <span className="rounded bg-[var(--ec-blue-bg)] px-1 text-[10px] leading-4 text-[var(--ec-blue)]">historical</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] max-w-[92vw] border border-[var(--ec-line-2)] bg-[var(--ec-card)]! p-4 text-[var(--ec-fg)]">
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="m-0 truncate font-mono text-[13px] text-[var(--ec-fg-hi)]">{name}</p>
              {spec ? <p className="m-0 text-xs text-[var(--ec-fg-2)]">{spec.purpose}</p> : null}
            </div>
            {historical ? <Pill tone="info">Historical only</Pill> : spec?.kind === 'rules' ? <Pill tone="good">Deterministic</Pill> : null}
          </div>
          <KeyValue items={items} className="grid-cols-[minmax(96px,max-content)_minmax(0,1fr)]" />
          {historical ? (
            <p className="m-0 flex gap-1.5 text-xs text-[var(--ec-fg-3)]">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
              Trained on archived Slurm accounting only; not a live scheduler forecast.
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
