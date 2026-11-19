/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Cpu, ShieldAlert, Wallet } from 'lucide-react';

import { c3Call } from '@/c3Action';
import { ErrorState, ModelComputing, ModelProvenance, SectionCard, ToneBadge, useC3Data, type Tone } from '@/components/app';

import type { Evidence, LabConstraints } from './types';

const fmtAmount = (kind: string, amount: number) => {
  if (kind === 'USD') return `$${Math.round(amount).toLocaleString()}`;
  const unit = { SU: 'SUs', GPU_HOURS: 'GPU-hours', GPU_YEARS: 'GPU-years', NODE_HOURS: 'node-hours', GPUS: 'GPUs' }[kind] ?? kind;
  return `${amount >= 1e6 ? `${amount / 1e6}M` : amount.toLocaleString()} ${unit}`;
};

const dayTone = (days?: number | null): Tone => (days == null ? 'neutral' : days < 3 ? 'bad' : days < 14 ? 'warn' : 'neutral');

/** Hover text: the exact quote of the lab text the field was extracted from, with its character offsets. */
const ev = (e?: Evidence) => (e && e.start >= 0 ? `"${e.quote}" (chars ${e.start}–${e.end})` : undefined);

function Group({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--c3-style-basic-fg-secondary)] [&_svg]:size-3.5">
        {icon}
        {title}
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex max-w-full cursor-help items-center gap-1 rounded-md border border-dashed border-[var(--c3-style-basic-border-border)] px-2 py-0.5 text-xs"
    >
      {children}
    </span>
  );
}

/**
 * What LabContextExtractor extracted from the lab context: schema-validated fields, each with an evidence span (hover
 * a chip for the exact quote). Fields stay UNCONFIRMED until the lab confirms them on the Lab Context page; the advisor
 * treats unconfirmed fields as hints.
 */
export default function LabKnowledge({ labId, labName }: { labId: string | null; labName?: string }) {
  const { data, loading, error, reload } = useC3Data<LabConstraints | null>(
    () => (labId ? (c3Call('Advisor', 'extractConstraints', null, [labId, null]) as Promise<LabConstraints>) : Promise.resolve(null)),
    [labId],
  );
  const p = data?.preferences ?? {};
  const pref = (field: string, value: unknown) => ev((p.evidence ?? []).find((e) => e.field === field && e.value === value));
  const confirmed = data?.status === 'CONFIRMED';
  const empty =
    data && !data.budgets.length && !data.deadlines.length && !data.dataRestrictions.length && !(p.clusters ?? []).length && !(p.avoid ?? []).length;
  return (
    <SectionCard
      title="Lab context"
      subtitle={labName ? `LabContextExtractor · ${labName}` : 'LabContextExtractor'}
      actions={
        data ? (
          <span title={data.llmError ? `LLM unavailable, rules parser used: ${data.llmError}` : undefined}>
            <ToneBadge tone={confirmed ? 'good' : 'warn'}>{confirmed ? 'Confirmed by lab' : 'Unconfirmed'}</ToneBadge>
          </span>
        ) : undefined
      }
      footer={
        data ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--c3-style-basic-fg-secondary)]">
            <ModelProvenance component="LabContextExtractor" provenance={data.provenance} compact />
            {data.validation && !data.validation.valid && (
              <span title={data.validation.errors.join('\n')}>{data.validation.dropped} field(s) failed validation</span>
            )}
            <Link to="/context" className="font-medium text-[var(--c3-style-basic-fg-accent)] hover:underline">
              {confirmed ? 'Review on Lab context' : 'Review & confirm'}
            </Link>
          </div>
        ) : undefined
      }
    >
      {!labId && <p className="text-sm text-[var(--c3-style-basic-fg-secondary)]">Pick a lab in the header.</p>}
      {labId && loading && <ModelComputing component="LabContextExtractor" variant="card" />}
      {labId && error && <ErrorState message={error} onRetry={reload} />}
      {data && !loading && (
        <div className="flex flex-col gap-3">
          {empty && <p className="text-sm text-[var(--c3-style-basic-fg-secondary)]">Nothing extracted yet. Add budgets, deadlines and data rules on the Lab context page.</p>}
          {data.budgets.length > 0 && (
            <Group icon={<Wallet aria-hidden />} title="Budget">
              {data.budgets.slice(0, 5).map((b, i) => (
                <Chip key={`b${i}`} title={ev(b.evidence)}>
                  <span className="font-semibold tabular-nums">{fmtAmount(b.kind, b.amount)}</span>
                  {b.scope && <span className="truncate text-[var(--c3-style-basic-fg-secondary)]">{b.scope}</span>}
                </Chip>
              ))}
            </Group>
          )}
          {data.deadlines.length > 0 && (
            <Group icon={<CalendarClock aria-hidden />} title="Deadlines">
              {data.deadlines.slice(0, 5).map((d, i) => (
                <Chip key={`d${i}`} title={ev(d.evidence)}>
                  <span className="truncate font-medium">{d.label}</span>
                  <ToneBadge tone={dayTone(d.daysAway)}>
                    {d.daysAway != null && d.daysAway >= 0 ? `${Math.max(0, Math.round(d.daysAway))} d` : d.date.substring(0, 10)}
                  </ToneBadge>
                </Chip>
              ))}
            </Group>
          )}
          {((p.clusters ?? []).length > 0 || (p.gpuTypes ?? []).length > 0 || (p.avoid ?? []).length > 0 || p.quietHours || (data.approvals ?? []).length > 0) && (
            <Group icon={<Cpu aria-hidden />} title="Preferences & approvals">
              {(p.clusters ?? []).map((c) => (
                <Chip key={`c${c}`} title={pref('clusters', c)}>
                  Prefers {c}
                </Chip>
              ))}
              {(p.gpuTypes ?? []).map((g) => (
                <Chip key={`g${g}`} title={pref('gpuTypes', g)}>
                  {g}
                </Chip>
              ))}
              {(p.avoid ?? []).map((a) => (
                <Chip key={`a${a}`} title={pref('avoid', a)}>
                  <span className="text-[var(--c3-style-basic-fg-danger)]">Avoid</span> {a}
                </Chip>
              ))}
              {p.quietHours && <Chip title={pref('quietHours', p.quietHours)}>Quiet {p.quietHours}</Chip>}
              {(data.approvals ?? []).map((a, i) => (
                <Chip key={`ap${i}`} title={ev(a.evidence)}>
                  PI approval &gt; {fmtAmount(a.unit, a.threshold)}
                </Chip>
              ))}
              {(data.memberCaps ?? []).map((m, i) => (
                <Chip key={`m${i}`} title={ev(m.evidence)}>
                  {m.who} cap {m.pct}%
                </Chip>
              ))}
            </Group>
          )}
          {data.dataRestrictions.length > 0 && (
            <Group icon={<ShieldAlert aria-hidden />} title="Data restrictions">
              {data.dataRestrictions.map((r, i) => (
                <span key={`r${i}`} title={ev(r.evidence) ?? r.description}>
                  <ToneBadge tone="bad">{r.kind.replace(/_/g, ' ')}</ToneBadge>
                </span>
              ))}
            </Group>
          )}
        </div>
      )}
    </SectionCard>
  );
}
