/*
 * EasyCompute design system — content blocks from the mockups: Note (callout), CodeBlock (job script with syntax
 * colours + Copy), CheckRow (rule check list item), EventRow (agent activity feed), KeyValue (".kv"), Chips,
 * Toggle (".switch"), Meter label row, AttentionItem ("Needs your attention" row with an action).
 */

import React, { useMemo, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

import { cn } from '@/lib/utils';

import { TONE_PILL, type Tone } from './tone';

/* ------------------------------------------------------------------ Note ------------------------------------------------------------------ */

const NOTE_TONE = {
  good: 'bg-[var(--ec-strip)] border-[var(--ec-accent-line)]',
  warn: 'bg-[var(--ec-warn-bg)] border-[#5a4a26]',
  bad: 'bg-[var(--ec-crit-bg)] border-[#5a302c]',
  info: 'bg-[var(--ec-strip)] border-[var(--ec-accent-line)]',
} as const;

/** Callout (".note"): icon badge, bold title, muted body, optional action on the right. */
export function Note({ tone = 'info', icon, title, children, action, className }: { tone?: keyof typeof NOTE_TONE; icon?: ReactNode; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const iconTone: Tone = tone === 'warn' ? 'warn' : tone === 'bad' ? 'bad' : tone === 'good' ? 'good' : 'info';
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border px-3.5 py-3 text-[var(--ec-fg)]', NOTE_TONE[tone], className)}>
      <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs font-bold [&_svg]:size-3', TONE_PILL[iconTone])}>{icon ?? 'i'}</span>
      <div className="min-w-0 flex-1">
        {title ? <p className="m-0 font-medium text-[var(--ec-fg-hi)]">{title}</p> : null}
        {children ? <div className="text-[13px] text-[var(--ec-fg-2)]">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

/* --------------------------------------------------------------- CodeBlock --------------------------------------------------------------- */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Very small bash/sbatch highlighter: comments, #SBATCH, flags, strings, numbers. Returns safe HTML. */
export function highlightShell(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      if (/^\s*#SBATCH/.test(line)) {
        return esc(line)
          .replace(/^(\s*)#SBATCH/, '$1<span class="tok-k">#SBATCH</span>')
          .replace(/(=)([^\s]+)/g, '$1<span class="tok-s">$2</span>')
          .replace(/(\s)(\d[\d:.-]*)(?=\s|$)/g, '$1<span class="tok-n">$2</span>');
      }
      if (/^\s*#/.test(line)) return `<span class="tok-c">${esc(line)}</span>`;
      return esc(line)
        .replace(/(&quot;|")(.*?)(\1)/g, '<span class="tok-s">$1$2$3</span>')
        .replace(/(^|\s)(--?[a-zA-Z][\w-]*)/g, '$1<span class="tok-p">$2</span>')
        .replace(/(\s)(\d+(?:\.\d+)?)(?=\s|$)/g, '$1<span class="tok-n">$2</span>')
        .replace(/^(\s*)(srun|sbatch|module|python|torchrun|source|export|cd|scontrol|scancel)\b/, '$1<span class="tok-k">$2</span>');
    })
    .join('\n');
}

/** Job script / code (".code"): Fira Mono 12.5/20, syntax colours, Copy button top-right. */
export function CodeBlock({ code, language = 'shell', title, className, maxHeightClass }: { code: string; language?: 'shell' | 'plain'; title?: ReactNode; className?: string; maxHeightClass?: string }) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => (language === 'shell' ? highlightShell(code) : esc(code)), [code, language]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={cn('relative flex min-w-0 flex-col gap-2', className)}>
      {title ? <div className="text-sm font-medium text-[var(--ec-fg-hi)]">{title}</div> : null}
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 z-[1] inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--ec-line-2)] bg-[var(--ec-bar)] px-2 text-xs font-medium text-[var(--ec-fg)] hover:bg-[var(--ec-card)]"
        aria-label="Copy to clipboard"
      >
        {copied ? <Check className="size-3.5 text-[var(--ec-accent-hi)]" /> : <Copy className="size-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      {/* eslint-disable-next-line react/no-danger -- html is escaped by highlightShell/esc */}
      <pre className={cn('ec-code', maxHeightClass, maxHeightClass && 'overflow-y-auto')} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/* --------------------------------------------------------------- CheckRow --------------------------------------------------------------- */

const CK: Record<'ok' | 'warn' | 'crit' | 'info', { tone: Tone; glyph: string }> = {
  ok: { tone: 'good', glyph: '✓' },
  warn: { tone: 'warn', glyph: '!' },
  crit: { tone: 'bad', glyph: '×' },
  info: { tone: 'info', glyph: 'i' },
};

/** Rule-check row (".check"): round status glyph, title, muted detail, right slot (source / tag). */
export function CheckRow({ status, title, detail, right }: { status: 'ok' | 'warn' | 'crit' | 'info'; title: ReactNode; detail?: ReactNode; right?: ReactNode }) {
  const c = CK[status];
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2.5 border-b border-[var(--ec-line)] py-3 last:border-b-0">
      <span className={cn('mt-px grid size-5 place-items-center rounded-full text-xs font-bold', TONE_PILL[c.tone])} aria-hidden>
        {c.glyph}
      </span>
      <div className="min-w-0">
        <div className="font-medium text-[var(--ec-fg-hi)]">{title}</div>
        {detail ? <div className="mt-0.5 text-[13px] text-[var(--ec-fg-2)]">{detail}</div> : null}
      </div>
      {right ? <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--ec-fg-3)]">{right}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- EventRow --------------------------------------------------------------- */

/** Activity feed row (".ev"): mono time, small green icon tile, bold what + muted detail. */
export function EventRow({ time, icon, title, detail, tone = 'accent' }: { time: ReactNode; icon: ReactNode; title: ReactNode; detail?: ReactNode; tone?: Tone }) {
  return (
    <div className="grid grid-cols-[64px_22px_minmax(0,1fr)] items-start gap-2.5 border-b border-[var(--ec-line)] py-2.5 last:border-b-0">
      <span className="font-mono text-xs leading-5 text-[var(--ec-fg-3)]">{time}</span>
      <span className={cn('grid size-5 place-items-center rounded-md [&_svg]:size-3', TONE_PILL[tone])} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-medium text-[var(--ec-fg-hi)]">{title}</div>
        {detail ? <div className="text-[13px] text-[var(--ec-fg-2)]">{detail}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ AttentionItem ------------------------------------------------------------ */

/** "Needs your attention" row: round tone glyph, title, muted body, action button(s) on the right. */
export function AttentionItem({ tone, glyph, title, children, action }: { tone: Tone; glyph?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)] items-start gap-2.5 border-b border-[var(--ec-line)] py-3.5 first:pt-0 last:border-b-0 last:pb-0 sm:grid-cols-[22px_minmax(0,1fr)_auto]">
      <span className={cn('mt-px grid size-5 place-items-center rounded-full text-xs font-bold [&_svg]:size-3', TONE_PILL[tone])} aria-hidden>
        {glyph ?? '!'}
      </span>
      <div className="min-w-0">
        <div className="font-medium text-[var(--ec-fg-hi)]">{title}</div>
        {children ? <div className="mt-0.5 text-[13px] text-[var(--ec-fg-2)]">{children}</div> : null}
      </div>
      {action ? <div className="col-start-2 flex flex-wrap gap-2 sm:col-start-auto">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------- KeyValue etc ------------------------------------------------------------- */

/** Definition grid (".kv"): muted keys, white values, 13px. */
export function KeyValue({ items, className }: { items: Array<{ label: ReactNode; value: ReactNode }>; className?: string }) {
  return (
    <dl className={cn('m-0 grid grid-cols-[minmax(120px,max-content)_minmax(0,1fr)] gap-x-5 gap-y-2.5 text-[13px]', className)}>
      {items.map((it, i) => (
        <React.Fragment key={i}>
          <dt className="text-[var(--ec-fg-2)]">{it.label}</dt>
          <dd className="m-0 min-w-0 text-[var(--ec-fg-hi)]">{it.value ?? '—'}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** Small rounded chips (".chip"); `accent` for highlighted ones. */
export function Chips({ items, className }: { items: Array<{ label: ReactNode; accent?: boolean }>; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {items.map((c, i) => (
        <span key={i} className={cn('rounded-md px-[9px] text-xs leading-[22px] whitespace-nowrap', c.accent ? 'bg-[var(--ec-accent-bg)] text-[var(--ec-accent-text)]' : 'bg-[var(--ec-card-2)] text-[var(--ec-fg)]')}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

/** Toggle (".switch"): 30x18 track, green when on. A real button with aria-pressed. */
export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange?: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
      className={cn('relative inline-block h-[18px] w-[30px] shrink-0 rounded-full transition-colors disabled:opacity-50', on ? 'bg-[var(--ec-accent-hi)]' : 'bg-[var(--ec-line-2)]')}
    >
      <span aria-hidden className={cn('absolute top-0.5 size-3.5 rounded-full transition-[left]', on ? 'left-[14px] bg-[#132010]' : 'left-0.5 bg-[var(--ec-fg)]')} />
    </button>
  );
}

/** Small section heading (".sec" 18/500 white). */
export function SectionHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="m-0 text-lg leading-7 font-medium text-[var(--ec-fg-hi)]">{children}</h2>
      {aside ? <div className="text-[13px] text-[var(--ec-fg-2)]">{aside}</div> : null}
    </div>
  );
}
