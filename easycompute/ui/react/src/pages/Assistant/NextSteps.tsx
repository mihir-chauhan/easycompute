/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Rocket } from 'lucide-react';

import { cn } from '@/lib/utils';

import { SOFT } from './tones';
import type { NextLink } from './types';

/**
 * Next steps under an answer, in the style of the "Needs your attention" rows. PolicyRAGAdvisor never acts: each row
 * deep-links to the Launch planner (run request + plan pre-filled) or the run page, where the user reviews and confirms.
 */
export default function NextSteps({ links }: { links: NextLink[] }) {
  if (!links.length) return null;
  return (
    <div className="flex flex-col rounded-lg border border-[var(--c3-style-basic-border-border)] px-3" data-testid="next-steps">
      {links.map((l) => {
        const isPlan = l.kind === 'PLAN';
        return (
          <div
            key={l.href}
            className="grid grid-cols-[22px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5 border-b border-[var(--c3-style-basic-border-border)] py-2.5 last:border-b-0 sm:grid-cols-[22px_minmax(0,1fr)_auto]"
          >
            <span className={cn('grid size-5 place-items-center rounded-full', SOFT[isPlan ? 'accent' : 'warn'])}>
              {isPlan ? <Rocket className="size-3" aria-hidden /> : <Activity className="size-3" aria-hidden />}
            </span>
            <span className="min-w-0 text-[13px] text-[var(--c3-style-basic-fg-primary)]">{l.title}</span>
            <Link
              to={l.href}
              className="col-start-2 inline-flex h-7 w-fit items-center gap-1.5 rounded-md border border-[var(--c3-style-basic-border-border)] px-2.5 text-xs font-medium text-[var(--c3-style-basic-fg-primary)] hover:bg-[var(--c3-style-basic-bg-secondary)] sm:col-start-3"
            >
              {l.label}
              <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>
        );
      })}
      <div className="py-1.5 text-[11px] text-[var(--c3-style-basic-fg-secondary)]">PolicyRAGAdvisor explains only; you confirm actions on these pages.</div>
    </div>
  );
}
