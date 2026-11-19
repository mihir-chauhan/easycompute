/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import { formatDuration, formatInt, formatUsd } from './format';
import type { RuleCheck, RunPlan, SummaryAllocation } from './types';

/** What the user asked the one-box planner to optimise for. */
export type Preference = 'balanced' | 'fast' | 'hours' | 'free';

export const PREFERENCE_LABEL: Record<Preference, string> = {
  balanced: 'Balanced',
  fast: 'Faster',
  hours: 'Fewer GPU-hours',
  free: 'No grant money',
};

/** Read a preference out of free text ("as fast as possible", "use free compute", "fewer GPU hours"). */
export function preferenceFrom(text: string): Preference | null {
  const t = text.toLowerCase();
  if (/\b(fast|faster|sooner|asap|quick|urgent|h100)\b/.test(t)) return 'fast';
  if (/(gpu.?hours|fewer hours|preempt|standby|cheap|fewer)/.test(t)) return 'hours';
  if (/(free compute|no grant|grant money|\$0|anvil|access su|free)/.test(t)) return 'free';
  if (/balanced|default/.test(t)) return 'balanced';
  return null;
}

const isPreemptible = (p: RunPlan) => /preempt|standby/i.test(`${p.qos ?? ''} ${p.partition?.id ?? ''}`);
const isFree = (p: RunPlan) => (p.estCostUsd ?? 1) === 0 || p.cluster?.id === 'anvil' || /standby/i.test(p.qos ?? '');
const by = (f: (p: RunPlan) => number) => (a: RunPlan, b: RunPlan) => f(a) - f(b);
const finish = (p: RunPlan) => (p.finishBy ? new Date(p.finishBy).getTime() : (p.estWaitHours ?? 0) + (p.estDurationHours ?? 0));

/** The plan for a preference, plus a note when no plan really matches it. */
export function pickPlan(plans: RunPlan[], pref: Preference): { plan: RunPlan | null; note?: string } {
  if (!plans.length) return { plan: null };
  if (pref === 'fast') return { plan: [...plans].sort(by(finish))[0] };
  if (pref === 'hours') {
    const pre = plans.filter(isPreemptible);
    return { plan: [...(pre.length ? pre : plans)].sort(by((p) => p.estCostUnits ?? Infinity))[0] };
  }
  if (pref === 'free') {
    const free = plans.filter(isFree);
    if (free.length) return { plan: [...free].sort(by((p) => p.estCostUsd ?? Infinity))[0] };
    return { plan: [...plans].sort(by((p) => p.estCostUsd ?? Infinity))[0], note: 'No free or ACCESS option passed every rule, so EasyCompute fell back to the cheapest paid option.' };
  }
  return { plan: plans.find((p) => p.label === 'Balanced') ?? [...plans].sort(by((p) => p.rank ?? 9))[0] };
}

const allocFor = (p: RunPlan, allocations: SummaryAllocation[]) => allocations.find((a) => a.clusterId === p.cluster?.id);

/** "Costs $0 from your grant." / "Uses 605 of your Gautschi GPU-hours (~$1,060)." */
export function costPhrase(p: RunPlan, allocations: SummaryAllocation[]): string {
  const a = allocFor(p, allocations);
  if ((p.estCostUsd ?? 0) === 0) return 'Costs $0 from your grant.';
  if (a && (a.unitName ?? '').toUpperCase() !== 'USD') {
    const unit = (a.unitName ?? 'units').replace(/hour$/i, 'hours');
    return `Uses ${formatInt(p.estCostUnits)} of your ${a.clusterName ?? ''} ${unit} (~${formatUsd(p.estCostUsd)}).`;
  }
  return `Costs about ${formatUsd(p.estCostUsd)}${a?.grantName ? ` from ${a.grantName}` : ''}.`;
}

export const doneBy = (p: RunPlan): string =>
  p.finishBy ? new Date(p.finishBy).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : `in ${formatDuration((p.estWaitHours ?? 0) + (p.estDurationHours ?? 0))}`;

/** The settings EasyCompute chose for this plan, as label/value chips. */
export function settingsOf(p: RunPlan, allocations: SummaryAllocation[]): [string, string][] {
  const a = allocFor(p, allocations);
  const rows: [string, string | undefined][] = [
    ['Cluster', p.cluster?.name ?? p.cluster?.id],
    ['Partition', p.slurmPartition ?? p.partition?.name],
    ['QOS', p.qos],
    ['GPUs', p.gpus ? `${p.gpus} × ${p.gpuType?.id ?? 'GPU'}` : undefined],
    ['Nodes', p.nodes ? String(p.nodes) : undefined],
    ['Walltime', (p.chainedJobs ?? 1) > 1 ? `${p.chainedJobs} × ${formatDuration(p.walltimeHours)}, chained` : formatDuration(p.walltimeHours)],
    ['GPU memory', p.gpuMemNeedGb ? `~${formatInt(p.gpuMemNeedGb)} GB needed` : undefined],
    ['Account', p.account],
    ['Pays from', a?.grantName ?? a?.unitName],
  ];
  return rows.filter((r): r is [string, string] => Boolean(r[1]));
}

const firstSentence = (s?: string) => (s ?? '').split(/(?<=\.)\s/)[0].replace(/\s*Source:.*$/, '').trim();

/** Auto-fixes and notes the planner applied (rules routed around, chained jobs, the plan rationale). */
export function fixesOf(p: RunPlan, checks: RuleCheck[]): string[] {
  const out: string[] = [];
  if ((p.chainedJobs ?? 1) > 1) out.push(`Split into ${p.chainedJobs} chained jobs that resume from checkpoint, because ${p.slurmPartition ?? 'this partition'} allows ${formatDuration(p.walltimeHours)} per job.`);
  checks
    .filter((c) => c.outcome === 'WARN')
    .slice(0, 3)
    .forEach((c) => out.push(`${c.title ?? c.ruleKind}: ${firstSentence(c.message)}`));
  const why = firstSentence(p.rationale);
  if (why) out.push(why);
  return out;
}
