/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { type ReactNode } from 'react';

import { statusOf, StatusBadge, ToneBadge } from '@/components/app';
import { cn } from '@/lib/utils';

import { ALERT_TYPE_LABEL } from './format';
import type { AlertSeverity, AlertType } from './types';

/** Alert type label, toned by severity (Critical = bad, Warning = warn). */
export const AlertTypeBadge = ({ type, severity }: { type: AlertType; severity: AlertSeverity }) => (
  <ToneBadge tone={statusOf('alertSeverity', severity).tone}>{ALERT_TYPE_LABEL[type] ?? type}</ToneBadge>
);

export const JobStateBadge = ({ value }: { value?: string | null }) => <StatusBadge kind="jobState" value={value} />;

/** Label/value stat used inside cards (plan cards, run header). */
export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <span className="text-xs text-[var(--c3-style-basic-fg-secondary)]">{label}</span>
      <span className="truncate text-[15px] font-semibold tabular-nums text-[var(--c3-style-basic-fg-primary)]">{value}</span>
      {sub && <span className="truncate text-xs text-[var(--c3-style-basic-fg-secondary)]">{sub}</span>}
    </div>
  );
}

/** Muted secondary text colour (12-13px captions, meta lines). */
export const muted = 'text-[var(--c3-style-basic-fg-secondary)]';

/** Status note under the header after an action ("Simulated 15 min: …"). */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="status" className={cn('rounded-[var(--ec-card-radius,8px)] border border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-primary)] px-4 py-2 text-[13px]', muted)}>
      {children}
    </div>
  );
}

/* ---------- Gantry-style building blocks (layout only; colours come from theme tokens) ---------- */

const CHECK_ICON: Record<'ok' | 'warn' | 'bad' | 'info', { cls: string; glyph: string }> = {
  ok: { cls: 'bg-[var(--c3-style-basic-bg-success)] text-[var(--c3-style-basic-fg-success)]', glyph: '✓' },
  warn: { cls: 'bg-[var(--c3-style-basic-bg-warning)] text-[var(--c3-style-basic-fg-warning)]', glyph: '!' },
  bad: { cls: 'bg-[var(--c3-style-basic-bg-danger)] text-[var(--c3-style-basic-fg-danger)]', glyph: '✕' },
  info: { cls: 'bg-[var(--c3-style-basic-bg-info)] text-[var(--c3-style-basic-fg-info)]', glyph: '→' },
};

/** Round status glyph (✓ ! ✕ →) used by rule checks, lab rules and issue lists. */
export function CheckIcon({ kind, glyph }: { kind: 'ok' | 'warn' | 'bad' | 'info'; glyph?: string }) {
  return (
    <span aria-hidden className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold', CHECK_ICON[kind].cls)}>
      {glyph ?? CHECK_ICON[kind].glyph}
    </span>
  );
}

/** One row of a checks / rules list: icon, title, muted detail, right-side tag or actions. */
export function CheckRow({ kind, glyph, title, detail, right }: { kind: 'ok' | 'warn' | 'bad' | 'info'; glyph?: string; title: ReactNode; detail?: ReactNode; right?: ReactNode }) {
  return (
    <li className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2.5 border-b border-[var(--c3-style-basic-border-border)] py-3 first:pt-0 last:border-b-0 last:pb-0">
      <CheckIcon kind={kind} glyph={glyph} />
      <div className="min-w-0">
        <div className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">{title}</div>
        {detail && <div className={cn('mt-0.5 text-[13px]', muted)}>{detail}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{right}</div>
    </li>
  );
}

/** Label / value rows (run request, configuration cards). */
export function KV({ rows, labelWidth = 'w-32' }: { rows: [ReactNode, ReactNode][]; labelWidth?: string }) {
  return (
    <dl className="flex flex-col gap-2 text-[13px]">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-3">
          <dt className={cn('shrink-0', labelWidth, muted)}>{k}</dt>
          <dd className="min-w-0 text-[var(--c3-style-basic-fg-primary)]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Small monospace text (ids, job numbers, times, triggers). */
export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cn('font-mono text-[12px]', className)}>{children}</span>
);

/** `$ easycompute …` CLI hint line under tables. */
export function CliHint({ command }: { command: string }) {
  const [bin, ...rest] = command.split(' ');
  return (
    <div className="overflow-x-auto rounded-[var(--ec-card-radius,8px)] border border-[var(--c3-style-basic-border-border)] px-3 py-2 font-mono text-[12px] whitespace-nowrap">
      <span className={muted}>$ </span>
      <span className="text-[var(--c3-style-basic-fg-accent)]">{bin}</span> <span className="text-[var(--c3-style-basic-fg-primary)]">{rest.join(' ')}</span>
    </div>
  );
}

/** One line of a #!/bin/bash + #SBATCH script with light syntax colouring (comments, directives, flags, values). */
function ScriptLine({ line }: { line: string }) {
  if (/^\s*#!/.test(line) || /^\s*#(?!SBATCH)/.test(line)) return <span className={muted}>{line}</span>;
  const m = /^(\s*#SBATCH)(.*)$/.exec(line);
  const body = m ? m[2] : line;
  const comment = body.indexOf(' #');
  const code = comment >= 0 ? body.slice(0, comment) : body;
  const tail = comment >= 0 ? body.slice(comment) : '';
  const parts = code.split(/(\s+)/).map((tok, i) => {
    if (/^--?[\w-]+=/.test(tok)) {
      const [flag, ...val] = tok.split('=');
      return (
        <span key={i}>
          {flag}=<span className="text-[var(--c3-style-basic-fg-info)]">{val.join('=')}</span>
        </span>
      );
    }
    if (m && /^[\w.@:-]+$/.test(tok) && i > 0 && !tok.startsWith('-')) return <span key={i} className="text-[var(--c3-style-basic-fg-success)]">{tok}</span>;
    return <span key={i}>{tok}</span>;
  });
  return (
    <span>
      {m && <span className="text-[var(--c3-style-basic-fg-accent)]">{m[1]}</span>}
      {parts}
      {tail && <span className={muted}>{tail}</span>}
    </span>
  );
}

export function ScriptBlock({ script }: { script: string }) {
  return (
    <pre className="max-h-[440px] overflow-auto rounded-[var(--ec-card-radius,8px)] border border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-secondary)] p-4 font-mono text-[12.5px] leading-relaxed text-[var(--c3-style-basic-fg-primary)]">
      {script.split('\n').map((l, i) => (
        <div key={i}>
          <ScriptLine line={l} />
          {'\n'}
        </div>
      ))}
    </pre>
  );
}

/** Timeline row: mono time, icon chip, title, muted detail (agent activity, recent actions, detected issues). */
export function ActivityRow({ time, icon, title, detail }: { time: ReactNode; icon: ReactNode; title: ReactNode; detail?: ReactNode }) {
  return (
    <li className="grid grid-cols-[52px_24px_minmax(0,1fr)] gap-3 border-b border-[var(--c3-style-basic-border-border)] py-3 first:pt-0 last:border-b-0 last:pb-0">
      <span className={cn('pt-0.5 font-mono text-[11.5px]', muted)}>{time}</span>
      <span className="flex size-6 items-center justify-center rounded-md bg-[var(--c3-style-basic-bg-success)] text-[var(--c3-style-basic-fg-success)] [&_svg]:size-3.5">{icon}</span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">{title}</div>
        {detail && <div className={cn('mt-0.5 text-[13px]', muted)}>{detail}</div>}
      </div>
    </li>
  );
}

/** Card header right-side muted note ("From lab context", "Last 24 h"). */
export const HeadNote = ({ children }: { children: ReactNode }) => <span className={cn('text-[13px]', muted)}>{children}</span>;
