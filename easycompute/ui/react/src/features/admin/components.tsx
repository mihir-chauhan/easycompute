/*
 * Admin-view building blocks shared by the Research Computing pages.
 */

import React, { type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** 0-100 -> "87%". */
export const pct = (v?: number | null): string => (v == null ? '—' : `${Math.round(v)}%`);
/** 0-1 -> "12%". */
export const frac = (v?: number | null): string => (v == null ? '—' : `${Math.round(v * 100)}%`);
export const num = (v?: number | null, digits = 0): string =>
  v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits });
export const compact = (v?: number | null): string =>
  v == null ? '—' : Math.abs(v) < 1000 ? Math.round(v).toLocaleString('en-US') : v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const usd = (v?: number | null): string =>
  v == null ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', notation: v >= 10000 ? 'compact' : 'standard', maximumFractionDigits: v >= 10000 ? 1 : 0 });
export const hours = (v?: number | null): string => {
  if (v == null) return '—';
  if (v < 1) return `${Math.round(v * 60)} min`;
  if (v >= 48) return `${Math.round(v / 24)} d`;
  return `${v.toFixed(v < 10 ? 1 : 0)} h`;
};

export interface Segment {
  key: string;
  label: string;
  value: number;
  /** Tailwind bg class for the swatch. */
  bgClass: string;
  /** Matching Tailwind fill class for the bar segment (literal, so Tailwind generates it). */
  fillClass: string;
}

/** Single 100% stacked bar (composition of a whole). */
export function SegmentBar({ segments, className }: { segments: Segment[]; className?: string }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let x = 0;
  return (
    <svg viewBox="0 0 100 10" preserveAspectRatio="none" className={cn('block h-3 w-full overflow-hidden rounded-full', className)} role="img" aria-label={segments.map((s) => `${s.label} ${Math.round((s.value / total) * 100)}%`).join(', ')}>
      {segments.map((s) => {
        const w = (s.value / total) * 100;
        const rect = <rect key={s.key} x={x} y={0} width={Math.max(0, w - 0.4)} height={10} className={s.fillClass} />;
        x += w;
        return rect;
      })}
    </svg>
  );
}

/** Label / value row used in side lists (swatch, label, primary value, muted secondary). */
export function StatRow({ swatch, label, value, sub, onClick }: { swatch?: string; label: ReactNode; value: ReactNode; sub?: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {swatch ? <span aria-hidden className={cn('inline-block size-2.5 shrink-0 rounded-[2px]', swatch)} /> : null}
        <span className="truncate text-sm text-[var(--c3-style-basic-fg-primary)]">{label}</span>
      </span>
      <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
        <span className="text-sm font-semibold text-[var(--c3-style-basic-fg-primary)]">{value}</span>
        {sub != null ? <span className="w-12 text-right text-xs text-[var(--c3-style-basic-fg-secondary)]">{sub}</span> : null}
      </span>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="-mx-2 flex w-[calc(100%+16px)] items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-[var(--c3-style-basic-bg-hover)]">
      {body}
    </button>
  ) : (
    <div className="flex items-center justify-between gap-3 py-1.5">{body}</div>
  );
}

/** Small uppercase section label inside a card. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-[11px] font-semibold tracking-wide text-[var(--c3-style-basic-fg-secondary)] uppercase', className)}>{children}</p>;
}

/** Unit price with enough precision for SU prices ($0.012). */
export const unitPrice = (v?: number | null): string =>
  v == null ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: v < 0.1 ? 3 : 2 });
