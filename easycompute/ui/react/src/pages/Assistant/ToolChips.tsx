/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BookOpenText,
  Building2,
  ChevronDown,
  Clock,
  Gauge,
  HeartPulse,
  ListChecks,
  Rocket,
  ShieldCheck,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

import { SOFT } from './ProposalCard';
import type { ToolCall } from './types';

/** Human labels and icons for the advisor tools. */
export const TOOLS: Record<string, { label: string; icon: LucideIcon }> = {
  labContext: { label: 'Read lab context', icon: BookOpenText },
  labSummary: { label: 'Read lab dashboard', icon: Gauge },
  listPolicies: { label: 'Looked up policies', icon: ShieldCheck },
  predictDuration: { label: 'Predicted duration', icon: Clock },
  evaluateRun: { label: 'Checked rules & ranked plans', icon: ListChecks },
  liveJobs: { label: 'Scanned live jobs', icon: Activity },
  jobHealth: { label: 'Checked job health', icon: HeartPulse },
  universityOverview: { label: 'Read university overview', icon: Building2 },
  proposeRunSubmission: { label: 'Proposed a submission', icon: Rocket },
  proposeJobAction: { label: 'Proposed a job action', icon: Zap },
};

const formatArgs = (args?: string): string => {
  if (!args) return '';
  try {
    const obj = JSON.parse(args) as Record<string, unknown>;
    return Object.entries(obj)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
  } catch {
    return args;
  }
};

/**
 * Tool-call transparency under an answer: a row of pill chips ("Used N tools"), expandable into an "Agent activity"
 * feed (duration, icon, what the tool did, its arguments and result summary).
 */
export default function ToolChips({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  if (calls.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="tool-chips">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 text-xs font-medium text-[var(--c3-style-basic-fg-secondary)] hover:text-[var(--c3-style-basic-fg-primary)]"
        >
          Used {calls.length} tool{calls.length === 1 ? '' : 's'}
          <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
        {calls.map((c, i) => {
          const Icon = c.ok === false ? AlertTriangle : (TOOLS[c.tool]?.icon ?? Zap);
          return (
            <span
              key={`${c.tool}-${i}`}
              title={c.summary}
              className={cn('inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium', SOFT[c.ok === false ? 'bad' : 'accent'])}
            >
              <Icon className="size-3" aria-hidden />
              {c.tool}
            </span>
          );
        })}
      </div>
      {open && (
        <div className="flex flex-col rounded-lg border border-[var(--c3-style-basic-border-border)] px-3">
          {calls.map((c, i) => {
            const Icon = c.ok === false ? AlertTriangle : (TOOLS[c.tool]?.icon ?? Zap);
            const args = formatArgs(c.args);
            return (
              <div
                key={`${c.tool}-d-${i}`}
                className="grid grid-cols-[56px_20px_minmax(0,1fr)] items-start gap-2.5 border-b border-[var(--c3-style-basic-border-border)] py-2 last:border-b-0"
              >
                <span className="font-mono text-xs leading-5 text-[var(--c3-style-basic-fg-secondary)]">{c.millis != null ? `${c.millis} ms` : ''}</span>
                <span className={cn('mt-0.5 grid size-5 place-items-center rounded-md', SOFT[c.ok === false ? 'bad' : 'accent'])}>
                  <Icon className="size-3" aria-hidden />
                </span>
                <div className="min-w-0 text-[13px]">
                  <div className="font-medium text-[var(--c3-style-basic-fg-primary)]">{TOOLS[c.tool]?.label ?? c.tool}</div>
                  {c.summary && <div className="text-[var(--c3-style-basic-fg-secondary)]">{c.summary}</div>}
                  {args && <div className="break-words font-mono text-[11px] text-[var(--c3-style-basic-fg-secondary)]">{c.tool}({args})</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
