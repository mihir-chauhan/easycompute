/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Activity, BookOpenText, Database, ExternalLink, FileText, FolderKanban, Scale, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

import { SOFT } from './tones';
import type { Citation } from './types';

const KIND: Record<string, { icon: LucideIcon; label: string }> = {
  DOC: { icon: FileText, label: 'Purdue / ACCESS document' },
  POLICY: { icon: Scale, label: 'Policy rule' },
  LAB: { icon: BookOpenText, label: 'Lab context' },
  PROJECT: { icon: FolderKanban, label: 'Project' },
  JOB: { icon: Activity, label: 'Live job evidence' },
  DATA: { icon: Database, label: 'App data' },
};

/** Ids the answer text cites as [id]. */
export const citedIds = (text: string): Set<string> => new Set(Array.from(text.matchAll(/\[([^\]\s][^\]]{0,60})\]/g)).map((m) => m[1]));

function Chip({ c, cited }: { c: Citation; cited: boolean }) {
  const k = KIND[c.kind] ?? KIND.DATA;
  const Icon = k.icon;
  const external = !!c.url && /^https?:/.test(c.url);
  const body = (
    <>
      <span className={cn('grid size-4 shrink-0 place-items-center rounded', SOFT[cited ? 'accent' : 'neutral'])}>
        <Icon className="size-2.5" aria-hidden />
      </span>
      <span className="font-mono text-[11px]">{c.id}</span>
      <span className="max-w-[16rem] truncate">{c.title}</span>
      {c.version && c.kind === 'DOC' && <span className="text-[var(--c3-style-basic-fg-secondary)]">v{c.version}</span>}
      {external && <ExternalLink className="size-3 shrink-0 text-[var(--c3-style-basic-fg-secondary)]" aria-hidden />}
    </>
  );
  const cls = cn(
    'inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium',
    cited ? 'border-[var(--c3-style-basic-border-accent)] text-[var(--c3-style-basic-fg-primary)]' : 'border-[var(--c3-style-basic-border-border)] text-[var(--c3-style-basic-fg-secondary)]',
    c.url && 'hover:bg-[var(--c3-style-basic-bg-secondary)]',
  );
  const title = `${k.label}${c.quote ? `: "${c.quote}"` : ''}${c.url ? ` — ${c.url}` : ''}`;
  if (external) {
    return (
      <a href={c.url ?? undefined} target="_blank" rel="noreferrer" className={cls} title={title} data-testid="citation-chip">
        {body}
      </a>
    );
  }
  if (c.url) {
    return (
      <Link to={c.url} className={cls} title={title} data-testid="citation-chip">
        {body}
      </Link>
    );
  }
  return (
    <span className={cls} title={title} data-testid="citation-chip">
      {body}
    </span>
  );
}

/**
 * Source chips under an answer: the sources the answer cites inline as [id] first (highlighted), then the other
 * retrieved sources (collapsed to the first few). Documents and policies open their source URL; lab context,
 * projects and jobs open the page in the app.
 */
export default function Citations({ citations, text }: { citations: Citation[]; text: string }) {
  if (!citations.length) return null;
  const cited = citedIds(text);
  const used = citations.filter((c) => cited.has(c.id));
  const other = citations.filter((c) => !cited.has(c.id)).slice(0, Math.max(0, 6 - used.length));
  return (
    <div className="flex flex-col gap-1" data-testid="citations">
      <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--c3-style-basic-fg-secondary)]">
        Sources{used.length ? ` · ${used.length} cited` : ''}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {used.concat(other).map((c) => (
          <Chip key={c.id} c={c} cited={cited.has(c.id)} />
        ))}
      </div>
    </div>
  );
}
