/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { type ReactNode } from 'react';
import { CalendarClock, Cpu, ShieldAlert, Sparkles, Wallet } from 'lucide-react';

import { c3Call } from '@/c3Action';
import { ErrorState, SectionCard, Skeleton, ToneBadge, useC3Data, type Tone } from '@/components/app';

import type { LabConstraints } from './types';

const fmtAmount = (kind: string, amount: number) => {
  if (kind === 'USD') return `$${Math.round(amount).toLocaleString()}`;
  const unit = { SU: 'SUs', GPU_HOURS: 'GPU-hours', GPU_YEARS: 'GPU-years', NODE_HOURS: 'node-hours', GPUS: 'GPUs' }[kind] ?? kind;
  return `${amount >= 1e6 ? `${amount / 1e6}M` : amount.toLocaleString()} ${unit}`;
};

const dayTone = (days?: number | null): Tone => (days == null ? 'neutral' : days < 3 ? 'bad' : days < 14 ? 'warn' : 'neutral');

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
    <span title={title} className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--c3-style-basic-border-border)] px-2 py-0.5 text-xs">
      {children}
    </span>
  );
}

/**
 * "What the advisor knows about this lab": the lab context dump parsed into constraints by Advisor.extractConstraints
 * (LLM, cached per text; rules-based parser when no LLM is available). Evidence sentences show on hover.
 */
export default function LabKnowledge({ labId, labName }: { labId: string | null; labName?: string }) {
  const { data, loading, error, reload } = useC3Data<LabConstraints | null>(
    () => (labId ? (c3Call('Advisor', 'extractConstraints', null, [labId, null]) as Promise<LabConstraints>) : Promise.resolve(null)),
    [labId],
  );
  const p = data?.preferences ?? {};
  const empty =
    data && !data.budgets.length && !data.deadlines.length && !data.dataRestrictions.length && !(p.clusters ?? []).length && !(p.avoid ?? []).length;
  return (
    <SectionCard
      title="What the advisor knows"
      subtitle={labName ? `Parsed from the ${labName} context` : 'Parsed from the lab context'}
      actions={
        data ? (
          <span title={data.llmError ? `LLM unavailable: ${data.llmError}` : data.model ? `Model client ${data.model}` : undefined}>
            <ToneBadge tone={data.source === 'llm' ? 'accent' : 'neutral'}>
              {data.source === 'llm' ? (
                <span className="inline-flex items-center gap-1">
                  <Sparkles className="size-3" aria-hidden /> AI-parsed
                </span>
              ) : (
                'Rules parser'
              )}
            </ToneBadge>
          </span>
        ) : undefined
      }
    >
      {!labId && <p className="text-sm text-[var(--c3-style-basic-fg-secondary)]">Pick a lab in the header.</p>}
      {labId && loading && (
        <div className="flex flex-col gap-2" aria-busy>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-5/6" />
          <Skeleton className="h-6 w-3/4" />
        </div>
      )}
      {labId && error && <ErrorState message={error} onRetry={reload} />}
      {data && !loading && (
        <div className="flex flex-col gap-3">
          {empty && <p className="text-sm text-[var(--c3-style-basic-fg-secondary)]">No constraints found yet. Add budgets, deadlines and data rules on the Lab Context page.</p>}
          {data.budgets.length > 0 && (
            <Group icon={<Wallet aria-hidden />} title="Budget">
              {data.budgets.slice(0, 5).map((b, i) => (
                <Chip key={`b${i}`} title={b.evidence}>
                  <span className="font-semibold tabular-nums">{fmtAmount(b.kind, b.amount)}</span>
                  {b.scope && <span className="truncate text-[var(--c3-style-basic-fg-secondary)]">{b.scope}</span>}
                </Chip>
              ))}
            </Group>
          )}
          {data.deadlines.length > 0 && (
            <Group icon={<CalendarClock aria-hidden />} title="Deadlines">
              {data.deadlines.slice(0, 5).map((d, i) => (
                <Chip key={`d${i}`} title={d.evidence}>
                  <span className="truncate font-medium">{d.label}</span>
                  <ToneBadge tone={dayTone(d.daysAway)}>
                    {d.daysAway != null && d.daysAway >= 0 ? `${Math.max(0, Math.round(d.daysAway))} d` : d.date.substring(0, 10)}
                  </ToneBadge>
                </Chip>
              ))}
            </Group>
          )}
          {((p.clusters ?? []).length > 0 || (p.gpuTypes ?? []).length > 0 || (p.avoid ?? []).length > 0 || p.quietHours) && (
            <Group icon={<Cpu aria-hidden />} title="Preferences">
              {(p.clusters ?? []).map((c) => (
                <Chip key={`c${c}`}>Prefers {c}</Chip>
              ))}
              {(p.gpuTypes ?? []).map((g) => (
                <Chip key={`g${g}`}>{g}</Chip>
              ))}
              {(p.avoid ?? []).map((a) => (
                <Chip key={`a${a}`}>
                  <span className="text-[var(--c3-style-basic-fg-danger)]">Avoid</span> {a}
                </Chip>
              ))}
              {p.quietHours && <Chip>Quiet {p.quietHours}</Chip>}
              {(data.approvals ?? []).map((a, i) => (
                <Chip key={`ap${i}`} title={a.evidence}>
                  PI approval &gt; {fmtAmount(a.unit, a.threshold)}
                </Chip>
              ))}
              {(data.memberCaps ?? []).map((m, i) => (
                <Chip key={`m${i}`} title={m.evidence}>
                  {m.who} cap {m.pct}%
                </Chip>
              ))}
            </Group>
          )}
          {data.dataRestrictions.length > 0 && (
            <Group icon={<ShieldAlert aria-hidden />} title="Data restrictions">
              {data.dataRestrictions.map((r, i) => (
                <span key={`r${i}`} title={r.evidence ?? r.description}>
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
