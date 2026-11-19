/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import type { ExtractedConstraint, LabConstraints, Policy } from './types';

const fmtAmount = (kind: string, amount: number) =>
  kind === 'USD' ? `$${Math.round(amount).toLocaleString('en-US')}` : `${Math.round(amount).toLocaleString('en-US')} ${kind.replace(/_/g, '-').toLowerCase()}`;

/** Advisor output → candidate LAB rules (one per enforceable statement), each tied to the sentence it came from. */
export function toCandidateRules(c: LabConstraints | null | undefined): ExtractedConstraint[] {
  if (!c) return [];
  const out: ExtractedConstraint[] = [];
  (c.budgets ?? []).forEach((b, i) =>
    out.push({
      key: `budget-${i}`,
      kind: 'BUDGET_REMAINING',
      severity: 'WARN',
      title: `Spend cap ${fmtAmount(b.kind, b.amount)}${b.period ? ` per ${b.period.toLowerCase()}` : ''}${b.scope ? ` (${b.scope})` : ''}`,
      limitValue: b.amount,
      limitText: b.kind,
      sourceText: b.evidence,
    }),
  );
  (c.deadlines ?? []).forEach((d, i) =>
    out.push({ key: `deadline-${i}`, kind: 'DEADLINE_FEASIBLE', severity: 'INFO', title: `Finish before ${d.label}`, limitText: d.date, sourceText: d.evidence }),
  );
  const p = c.preferences ?? {};
  if (p.preemptibleOk === false) out.push({ key: 'preempt', kind: 'PREEMPTIBLE_ONLY', severity: 'BLOCK', title: 'Never run on preemptible / standby QOS', limitText: 'deny' });
  if (p.preemptibleOk === true) out.push({ key: 'preempt', kind: 'PREEMPTIBLE_ONLY', severity: 'INFO', title: 'Exploratory work may use preemptible QOS', limitText: 'allow' });
  if (p.maxWalltimeHours) out.push({ key: 'wall', kind: 'MAX_WALLTIME', severity: 'WARN', title: `Max ${p.maxWalltimeHours} h walltime per job`, limitValue: p.maxWalltimeHours });
  if (p.quietHours) out.push({ key: 'quiet', kind: 'QUIET_HOURS', severity: 'INFO', title: `Quiet hours: ${p.quietHours}`, limitText: p.quietHours });
  (p.avoid ?? []).forEach((a, i) => out.push({ key: `avoid-${i}`, kind: 'ALLOWED_GPU_TYPES', severity: 'WARN', title: `Avoid ${a}`, limitText: `avoid:${a}` }));
  (c.dataRestrictions ?? []).forEach((d, i) =>
    out.push({
      key: `data-${i}`,
      kind: d.kind === 'EXPORT_CONTROL' || d.kind === 'CUI' ? 'EXPORT_CONTROL' : 'DATA_RESIDENCY',
      severity: 'BLOCK',
      title: d.description || `${d.kind.replace(/_/g, ' ')} data restriction`,
      limitText: d.kind,
      sourceText: d.evidence,
    }),
  );
  (c.memberCaps ?? []).forEach((m, i) =>
    out.push({ key: `cap-${i}`, kind: 'FAIRSHARE_CAP', severity: 'WARN', title: `${m.who} capped at ${Math.round(m.pct)}% of lab compute`, limitValue: m.pct, limitText: m.who, sourceText: m.evidence }),
  );
  (c.approvals ?? []).forEach((a, i) =>
    out.push({
      key: `approve-${i}`,
      kind: a.unit.toUpperCase().includes('GPU') ? 'MAX_GPUS_PER_JOB' : 'BUDGET_REMAINING',
      severity: 'WARN',
      title: `PI approval above ${a.threshold.toLocaleString('en-US')} ${a.unit}`,
      limitValue: a.threshold,
      limitText: a.unit,
      sourceText: a.evidence,
    }),
  );
  return out;
}

/** Drop candidates that already exist as lab rules (same kind + same title). */
export const notYetRules = (cands: ExtractedConstraint[], rules: Policy[]) =>
  cands.filter((c) => !rules.some((r) => r.kind === c.kind && r.title.trim().toLowerCase() === c.title.trim().toLowerCase()));
