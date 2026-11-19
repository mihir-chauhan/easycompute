/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Check, ExternalLink, Rocket, ShieldCheck, X, Zap } from 'lucide-react';

import { ClusterTag, ToneBadge, type Tone } from '@/components/app';
import { Button } from '@/components/ui/button';

import type { Proposal } from './types';

const STATE_TONE: Record<string, Tone> = { PENDING: 'warn', APPLIED: 'good', FAILED: 'bad', DISCARDED: 'neutral' };
const STATE_LABEL: Record<string, string> = { PENDING: 'Awaiting your confirmation', APPLIED: 'Applied', FAILED: 'Failed', DISCARDED: 'Discarded' };

const usd = (v?: number | null) => (v == null ? '—' : `$${Math.round(v).toLocaleString()}`);
const hrs = (v?: number | null) => (v == null ? '—' : `${v} h`);

interface ProposalCardProps {
  proposal: Proposal;
  busy: boolean;
  onDecide: (p: Proposal, action: 'confirmProposal' | 'discardProposal') => void;
  compact?: boolean;
}

/**
 * Confirm-before-action card. The advisor only proposes; nothing is submitted or changed until the user clicks
 * Confirm, which calls Advisor.confirmProposal (RunRequest.submit or Job.applyAction).
 */
export default function ProposalCard({ proposal: p, busy, onDecide, compact }: ProposalCardProps) {
  const d = p.details ?? {};
  const isRun = p.kind === 'SUBMIT_RUN';
  const pending = p.state === 'PENDING';
  const jobId = p.resultJobId ?? p.jobId;
  return (
    <div
      data-testid="proposal-card"
      className="flex flex-col gap-2 rounded-lg border border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-primary)] p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--c3-style-basic-bg-secondary)] text-[var(--c3-style-basic-fg-accent)]">
            {isRun ? <Rocket className="size-4" aria-hidden /> : <Zap className="size-4" aria-hidden />}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-5">{p.summary}</div>
            {p.reason && !compact && <div className="text-xs text-[var(--c3-style-basic-fg-secondary)]">{p.reason}</div>}
          </div>
        </div>
        <ToneBadge tone={STATE_TONE[p.state] ?? 'neutral'}>{STATE_LABEL[p.state] ?? p.state}</ToneBadge>
      </div>

      {isRun && !compact && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-[var(--c3-style-basic-fg-secondary)]">Where</dt>
            <dd className="font-medium">
              <ClusterTag id={d.cluster} name={d.partition ?? d.cluster} />
            </dd>
          </div>
          <div>
            <dt className="text-[var(--c3-style-basic-fg-secondary)]">GPUs</dt>
            <dd className="font-medium tabular-nums">
              {d.gpus ?? '—'}× {d.gpuType ?? ''}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--c3-style-basic-fg-secondary)]">Wait + run</dt>
            <dd className="font-medium tabular-nums">
              {hrs(d.estWaitHours)} + {hrs(d.estDurationHours)}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--c3-style-basic-fg-secondary)]">Est. cost</dt>
            <dd className="font-medium tabular-nums">{usd(d.estCostUsd)}</dd>
          </div>
        </dl>
      )}
      {isRun && !compact && d.sbatchScript && (
        <details className="text-xs">
          <summary className="cursor-pointer select-none text-[var(--c3-style-basic-fg-secondary)] hover:text-[var(--c3-style-basic-fg-primary)]">
            sbatch preview
          </summary>
          <pre className="mt-1 max-h-56 overflow-auto rounded-md bg-[var(--c3-style-basic-bg-secondary)] p-2 font-mono text-[11px] leading-4">{d.sbatchScript}</pre>
        </details>
      )}

      {pending ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="solid" appearance="accent" leadingIcon={<Check />} loading={busy} disabled={busy} onClick={() => onDecide(p, 'confirmProposal')}>
            {isRun ? 'Confirm & submit' : 'Confirm'}
          </Button>
          <Button size="sm" variant="ghost" appearance="secondary" leadingIcon={<X />} disabled={busy} onClick={() => onDecide(p, 'discardProposal')}>
            Discard
          </Button>
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--c3-style-basic-fg-secondary)]">
            <ShieldCheck className="size-3" aria-hidden />
            Nothing changes until you confirm
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--c3-style-basic-fg-secondary)]">
          {p.resultText && <span>{p.resultText}</span>}
          {p.state === 'APPLIED' && jobId && (
            <Link to={`/runs/${encodeURIComponent(jobId)}`} className="inline-flex items-center gap-1 font-medium text-[var(--c3-style-basic-fg-accent)] hover:underline">
              Open job <ExternalLink className="size-3" aria-hidden />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
