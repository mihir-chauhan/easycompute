/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, Wrench } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { ToolCall } from './types';

/** Human labels for the advisor tools. */
export const TOOL_LABEL: Record<string, string> = {
  labContext: 'Lab context',
  labSummary: 'Lab summary',
  listPolicies: 'Policies',
  predictDuration: 'Duration model',
  evaluateRun: 'Rule check + plans',
  liveJobs: 'Live jobs',
  jobHealth: 'Job health',
  universityOverview: 'University overview',
  proposeRunSubmission: 'Proposed submit',
  proposeJobAction: 'Proposed job action',
};

const formatArgs = (args?: string): string => {
  if (!args) return '';
  try {
    const obj = JSON.parse(args) as Record<string, unknown>;
    return Object.entries(obj)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ');
  } catch {
    return args;
  }
};

/** "Used N tools" row of chips under an answer; click to see arguments and the result summary of each call. */
export default function ToolChips({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  if (calls.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid="tool-chips">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 text-xs font-medium text-[var(--c3-style-basic-fg-secondary)] hover:text-[var(--c3-style-basic-fg-primary)]"
        >
          <Wrench className="size-3" aria-hidden />
          Used {calls.length} tool{calls.length === 1 ? '' : 's'}
          <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
        {calls.map((c, i) => (
          <span
            key={`${c.tool}-${i}`}
            title={c.summary}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
              c.ok === false
                ? 'border-[var(--c3-style-basic-border-danger)] text-[var(--c3-style-basic-fg-danger)]'
                : 'border-[var(--c3-style-basic-border-border)] text-[var(--c3-style-basic-fg-primary)]',
            )}
          >
            {c.ok === false && <AlertTriangle className="size-3" aria-hidden />}
            {TOOL_LABEL[c.tool] ?? c.tool}
          </span>
        ))}
      </div>
      {open && (
        <ol className="flex flex-col gap-1 rounded-md bg-[var(--c3-style-basic-bg-secondary)] p-2 text-xs">
          {calls.map((c, i) => (
            <li key={`${c.tool}-d-${i}`} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
              <span className="shrink-0 font-mono font-semibold">{c.tool}</span>
              <span className="min-w-0 break-words text-[var(--c3-style-basic-fg-secondary)]">
                {formatArgs(c.args) || 'no arguments'}
                {c.summary ? ` → ${c.summary}` : ''}
                {c.millis != null ? ` (${c.millis} ms)` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
