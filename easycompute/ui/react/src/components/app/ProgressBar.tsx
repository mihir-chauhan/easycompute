/*
 * EasyCompute design system — ProgressBar and BudgetBurn (SVG, no inline styles).
 */

import React from 'react';

import { cn } from '@/lib/utils';

import { burnTone, TONE_FILL, TONE_TEXT, type Tone } from './tone';

const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

interface ProgressBarProps {
  /** Fraction 0-1. */
  value: number;
  tone?: Tone;
  /** Optional marker (fraction 0-1), e.g. share of the period elapsed or a target. */
  marker?: number | null;
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel?: string;
}

/** Thin rounded bar on a neutral track with an optional dark target/elapsed marker. */
export function ProgressBar({ value, tone = 'neutral', marker, size = 'sm', className, ariaLabel }: ProgressBarProps) {
  const v = clamp01(value);
  const h = size === 'sm' ? 6 : 8;
  return (
    <svg
      viewBox={`0 0 100 ${h}`}
      preserveAspectRatio="none"
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      className={cn('block w-full overflow-visible', size === 'sm' ? 'h-1.5' : 'h-2', className)}
    >
      <rect x={0} y={0} width={100} height={h} rx={h / 2} className="fill-[var(--ec-track)]" />
      {v > 0 ? <rect x={0} y={0} width={Math.max(v * 100, 1.5)} height={h} rx={h / 2} className={TONE_FILL[tone]} /> : null}
      {marker != null ? (
        <line x1={clamp01(marker) * 100} x2={clamp01(marker) * 100} y1={-2} y2={h + 2} strokeWidth={1.5} className="stroke-[var(--ec-target)]" />
      ) : null}
    </svg>
  );
}

interface BudgetBurnProps {
  used: number;
  total: number;
  /** Fraction (0-1) of the allocation period elapsed; drawn as a marker and used for the burn tone. */
  elapsed?: number | null;
  /** Formats used/total, e.g. `(v) => `${v} SU``. */
  format?: (v: number) => string;
  /** Hide the numbers line (bar only, for dense table cells). */
  compact?: boolean;
  className?: string;
}

/**
 * Allocation burn: used vs total with an "elapsed" marker. Colour says whether the lab burns faster than time
 * (see `burnTone`). Use for allocations, budgets, SU balances.
 */
export function BudgetBurn({ used, total, elapsed, format = (v) => v.toLocaleString('en-US', { maximumFractionDigits: 0 }), compact, className }: BudgetBurnProps) {
  const frac = total > 0 ? used / total : 0;
  const tone = burnTone(frac, elapsed);
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      {!compact && (
        <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
          <span className="truncate text-[var(--c3-style-basic-fg-secondary)]">
            <span className="font-medium text-[var(--c3-style-basic-fg-primary)]">{format(used)}</span> of {format(total)}
          </span>
          <span className={cn('font-medium', TONE_TEXT[tone])}>{Math.round(frac * 100)}%</span>
        </div>
      )}
      <ProgressBar
        value={frac}
        tone={tone}
        marker={elapsed}
        ariaLabel={`${Math.round(frac * 100)}% used${elapsed != null ? `, ${Math.round(elapsed * 100)}% of period elapsed` : ''}`}
      />
    </div>
  );
}
