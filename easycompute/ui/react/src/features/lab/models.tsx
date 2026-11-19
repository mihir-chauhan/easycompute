/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React from 'react';
import { ModelComputing as SharedComputing, ModelProvenance as SharedProvenance, type Provenance } from '@/components/app';
import { cn } from '@/lib/utils';

import type { AlertType } from './types';

/**
 * Model / engine components behind each lab feature (owner spec: project/MODEL_MAP.md). The UI names the exact
 * component wherever it runs ("<Name> is computing…") and labels results with a provenance chip.
 */
export type ModelName =
  | 'LabContextExtractor'
  | 'ClusterPolicyEngine'
  | 'AnvilRuntimeQ50Q90'
  | 'AnvilTaskCPUQ50Q90'
  | 'AnvilHostMemoryQ50Q90'
  | 'GPUShapeAdvisor'
  | 'LabFairShareAllocator'
  | 'GPUUnderuseDetector'
  | 'GuardrailRuleEngine'
  | 'AllocationBurnForecaster';

export const MODEL_INFO: Record<ModelName, { method: string; version: string; historical?: boolean; note?: string }> = {
  LabContextExtractor: { method: 'schema-constrained LLM + validation', version: 'v1', note: 'Every extracted field cites its evidence and needs lab confirmation.' },
  ClusterPolicyEngine: { method: 'versioned deterministic rules', version: 'policy set 2026-11-02', note: 'Exact and explainable; nothing can waive a BLOCK rule.' },
  AnvilRuntimeQ50Q90: { method: 'LinearQuantileRegressor (pinball loss)', version: 'v1', historical: true, note: 'P50/P90 trained on completed jobs, temporal holdout.' },
  AnvilTaskCPUQ50Q90: { method: 'LinearQuantileRegressor', version: 'v1', historical: true, note: 'Per-task core-equivalent; right-sizing evidence only.' },
  AnvilHostMemoryQ50Q90: { method: 'LinearQuantileRegressor', version: 'v1', historical: true, note: 'Host RAM only; the archive has no GPU VRAM.' },
  GPUShapeAdvisor: { method: 'hardware catalogue + deterministic rules', version: 'v1', note: 'No learned GPU model (no GPU evidence in the archive).' },
  LabFairShareAllocator: { method: 'weighted deficit round robin', version: 'v1', note: 'Lab-level ordering only; does not change Slurm priority.' },
  GPUUnderuseDetector: { method: 'EWMA / CUSUM over DCGM telemetry', version: 'v1', note: 'Persistent underuse versus the run’s own baseline.' },
  GuardrailRuleEngine: { method: 'state machine with hysteresis', version: 'v1', note: 'Hysteresis avoids flapping; records why it fired. You confirm consequential actions.' },
  AllocationBurnForecaster: { method: 'deterministic ledger + EWMA + scenarios', version: 'v1', note: 'Baseline / low / high burn scenarios from the policy ledger.' },
};

/** Inline "<Name> is computing…" indicator (shared design-system component). */
export function ModelComputing({ name, detail, className }: { name: ModelName; detail?: string; className?: string }) {
  return <SharedComputing component={name} verb={(detail ?? 'is computing').replace(/…$/, '')} className={className} />;
}

/** Several components computing at once (plan ranking). */
export function ModelsComputing({ names, className }: { names: ModelName[]; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {names.map((n) => (
        <ModelComputing key={n} name={n} />
      ))}
    </div>
  );
}

/**
 * Provenance chip (shared design-system popover). `provenance` = the backend object when the response carries one;
 * `support` / `period` / `confidence` / `extra` fill in what the page knows.
 */
export function ModelProvenance({
  name,
  provenance,
  support,
  period,
  confidence,
  extra,
  className,
}: {
  name: ModelName;
  provenance?: Provenance | null;
  /** Sample support, e.g. "227 jobs". */
  support?: string;
  /** Training / data period. */
  period?: string;
  confidence?: 'low' | 'medium' | 'high';
  extra?: string;
  className?: string;
}) {
  const info = MODEL_INFO[name];
  const p: Provenance = {
    ...(support ? { coverage: support } : {}),
    ...(period ? { trainingPeriod: period } : {}),
    ...(confidence ? { confidence } : {}),
    ...(info.note ? { note: info.note } : {}),
    ...(extra ? { details: extra } : {}),
    ...(provenance ?? {}),
  };
  return <SharedProvenance component={name} provenance={p} compact className={className} />;
}

/** Which component raised an alert. */
export const alertModel = (t: AlertType): ModelName => (t === 'IDLE_GPU' || t === 'LOW_GPU_UTIL' ? 'GPUUnderuseDetector' : t === 'BUDGET_BURN' ? 'AllocationBurnForecaster' : 'GuardrailRuleEngine');

/** The rule (state-machine transition) behind each alert type: "why it fired". */
export const ALERT_RULE: Record<AlertType, string> = {
  IDLE_GPU: 'GPU util < 5% while CPU busy for ≥ 30 min (critical at the idle-cancel limit)',
  LOW_GPU_UTIL: 'Window mean GPU util 5-35% over ≥ 45 min, below the run’s own baseline',
  OOM_RISK: 'GPU memory ≥ 95%, or ≥ 88% and rising ≥ 2 pts per sample; host memory ≥ 92%',
  WALLTIME_RISK: 'Predicted remaining runtime > remaining walltime, or near the limit with a stale checkpoint',
  BUDGET_BURN: 'Allocation used + this run’s remaining cost ≥ the lab’s budget-alert threshold',
  HUNG_JOB: 'GPU < 2%, CPU < 3%, I/O < 0.5 MB/s and flat loss for ≥ 30 min',
  NODE_FAILURE: '0 W power and 0% util after a non-zero sample',
  PREEMPTION_RISK: 'Preemptible QOS and checkpoint older than 30 min (10-min grace on preemption)',
  STALE_CHECKPOINT: 'Non-preemptible run with checkpoint older than 120 min',
};

const fmtEvidence = (e: unknown): string | null => {
  if (!e || typeof e !== 'object') return typeof e === 'string' ? e : null;
  const parts = Object.entries(e as Record<string, unknown>)
    .filter(([, v]) => v != null && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'))
    .slice(0, 5)
    .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()} ${typeof v === 'number' ? Math.round(v * 100) / 100 : String(v)}`);
  return parts.length ? parts.join(' · ') : null;
};

/** "Why it fired": the GuardrailRuleEngine rule / transition (backend `firedRule`) plus its evidence values. */
export const WhyFired = ({ type, firedRule, evidence }: { type: AlertType; firedRule?: string; evidence?: unknown }) => {
  const ev = fmtEvidence(evidence);
  return (
    <span className="text-[12px] text-[var(--c3-style-basic-fg-secondary)]">
      <span className="font-medium">Why it fired: </span>
      {firedRule || ALERT_RULE[type]}
      {ev ? <span className="font-mono text-[11.5px]">{` · ${ev}`}</span> : null}
    </span>
  );
};
