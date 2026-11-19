/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Check, ExternalLink, Rocket, X, Zap } from 'lucide-react';

import { ToneBadge, type Tone } from '@/components/app';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { Proposal } from './types';

/** Soft tinted circle / square per tone (theme tokens, same pair the soft badges use). */
export const SOFT: Record<Tone, string> = {
  good: 'bg-[var(--c3-style-basic-bg-success)] text-[var(--c3-style-basic-fg-success)]',
  warn: 'bg-[var(--c3-style-basic-bg-warning)] text-[var(--c3-style-basic-fg-warning)]',
  bad: 'bg-[var(--c3-style-basic-bg-danger)] text-[var(--c3-style-basic-fg-danger)]',
  info: 'bg-[var(--c3-style-basic-bg-info)] text-[var(--c3-style-basic-fg-info)]',
  accent: 'bg-[var(--c3-style-basic-bg-accent)] text-[var(--c3-style-basic-fg-accent)]',
  neutral: 'bg-[var(--c3-style-basic-bg-secondary)] text-[var(--c3-style-basic-fg-secondary)]',
  pink: 'bg-[var(--ec-pink-bg,var(--c3-style-basic-bg-secondary))] text-[var(--ec-pink)]',
};

const STATE_TONE: Record<string, Tone> = { PENDING: 'warn', APPLIED: 'good', FAILED: 'bad', DISCARDED: 'neutral' };
const STATE_LABEL: Record<string, string> = { PENDING: 'Needs approval', APPLIED: 'Applied', FAILED: 'Failed', DISCARDED: 'Discarded' };
const ACTION_VERB: Record<string, string> = {
  EXTEND_WALLTIME: 'Approve extension',
  CANCEL: 'Approve cancel',
  CHECKPOINT_NOW: 'Approve checkpoint',
  REQUEUE_STANDBY: 'Approve requeue',
  SCALE_DOWN: 'Approve scale-down',
  NOTIFY_PI: 'Send to PI',
  HOLD: 'Approve hold',
};

const usd = (v?: number | null) => (v == null ? null : `$${Math.round(v).toLocaleString()}`);

interface ProposalCardProps {
  proposal: Proposal;
  busy: boolean;
  onDecide: (p: Proposal, action: 'confirmProposal' | 'discardProposal') => void;
  /** Inside a list (right panel): no border box, divider rows like the mockup "Needs your attention" card. */
  row?: boolean;
}

/**
 * Confirm-before-action item in the style of the "Needs your attention" rows: toned icon, title, short rationale,
 * approve button. The advisor only proposes; nothing changes until the user clicks Approve, which calls
 * Advisor.confirmProposal (RunRequest.submit or Job.applyAction).
 */
export default function ProposalCard({ proposal: p, busy, onDecide, row }: ProposalCardProps) {
  const d = p.details ?? {};
  const isRun = p.kind === 'SUBMIT_RUN';
  const pending = p.state === 'PENDING';
  const tone = STATE_TONE[p.state] ?? 'neutral';
  const jobId = p.resultJobId ?? p.jobId;
  const facts = isRun
    ? [
        d.partition ?? d.cluster,
        d.gpus != null ? `${d.gpus}× ${d.gpuType ?? 'GPU'}` : null,
        d.estDurationHours != null ? `~${d.estDurationHours} h run${d.estWaitHours ? ` + ${d.estWaitHours} h wait` : ''}` : null,
        usd(d.estCostUsd),
        d.meetsDeadline === true ? 'meets deadline' : d.meetsDeadline === false ? 'misses deadline' : null,
      ].filter(Boolean)
    : [p.jobId, d.state, d.gpus != null ? `${d.gpus} GPUs` : null, d.timelimitHours != null ? `${d.elapsedHours ?? 0} / ${d.timelimitHours} h walltime` : null].filter(Boolean);

  return (
    <div
      data-testid="proposal-card"
      className={cn(
        'grid grid-cols-[22px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-2 sm:grid-cols-[22px_minmax(0,1fr)_auto]',
        row ? 'border-b border-[var(--c3-style-basic-border-border)] py-3 last:border-b-0' : 'rounded-lg border border-[var(--c3-style-basic-border-border)] p-3',
      )}
    >
      <span className={cn('mt-px grid size-5 place-items-center rounded-full', SOFT[tone])}>
        {isRun ? <Rocket className="size-3" aria-hidden /> : <Zap className="size-3" aria-hidden />}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">{p.summary}</span>
          <ToneBadge tone={tone}>{STATE_LABEL[p.state] ?? p.state}</ToneBadge>
        </div>
        {p.reason && <div className="mt-0.5 text-[13px] text-[var(--c3-style-basic-fg-secondary)]">{p.reason}</div>}
        {facts.length > 0 && <div className="mt-1 font-mono text-xs text-[var(--c3-style-basic-fg-secondary)]">{facts.join(' · ')}</div>}
        {isRun && d.sbatchScript && !row && (
          <details className="mt-1.5 text-xs">
            <summary className="cursor-pointer select-none text-[var(--c3-style-basic-fg-secondary)] hover:text-[var(--c3-style-basic-fg-primary)]">Job script</summary>
            <pre className="mt-1 max-h-56 overflow-auto rounded-md border border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-secondary)] p-2 font-mono text-[11px] leading-4">
              {d.sbatchScript}
            </pre>
          </details>
        )}
        {!pending && (p.resultText || (p.state === 'APPLIED' && jobId)) && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--c3-style-basic-fg-secondary)]">
            {p.resultText && <span>{p.resultText}</span>}
            {p.state === 'APPLIED' && jobId && (
              <Link to={`/runs/${encodeURIComponent(jobId)}`} className="inline-flex items-center gap-1 font-medium text-[var(--c3-style-basic-fg-accent)] hover:underline">
                Open in monitor <ExternalLink className="size-3" aria-hidden />
              </Link>
            )}
          </div>
        )}
      </div>
      {pending && (
        <div className="col-start-2 flex flex-wrap gap-2 sm:col-start-3 sm:justify-end">
          <Button size="sm" variant="solid" appearance="accent" leadingIcon={<Check />} loading={busy} disabled={busy} onClick={() => onDecide(p, 'confirmProposal')}>
            {isRun ? 'Approve & submit' : ACTION_VERB[p.actionType ?? ''] ?? 'Approve'}
          </Button>
          <Button size="sm" variant="outline" appearance="secondary" leadingIcon={<X />} disabled={busy} onClick={() => onDecide(p, 'discardProposal')}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
