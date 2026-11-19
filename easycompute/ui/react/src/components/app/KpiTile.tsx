/*
 * EasyCompute design system — KPI tile and KPI row (max 4 tiles per row).
 */

import React, { type ReactNode } from 'react';

import {
  MetricCard,
  MetricCardCaption,
  MetricCardDelta,
  MetricCardHeader,
  MetricCardLabel,
  MetricCardValue,
} from '@/components/ui/metric-card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import Sparkline from './Sparkline';
import { TONE_BG, type Tone } from './tone';

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  /** Unit rendered small after the value ("GPUs", "%"). */
  unit?: string;
  /** Small rounded chip after the value, e.g. "of $48,000", "left this semester", "Jan 22". */
  chip?: ReactNode;
  /** One line, muted. */
  caption?: ReactNode;
  /** Delta text such as "+12% vs last month" with its tone (good = green, bad = red). */
  delta?: { text: string; tone: 'good' | 'bad' | 'neutral'; direction?: 'up' | 'down' | 'neutral' };
  /** Status dot before the label (e.g. bad when there are open critical alerts). */
  tone?: Tone;
  /** Optional trend under the value. */
  trend?: number[];
  trendTone?: Tone;
  /** Help text shown in a tooltip on the label. */
  help?: string;
  onClick?: () => void;
  className?: string;
}

/** KPI tile (mockup ".tile"): #232323 tile, 12px label, 22px value + optional chip, 12px muted caption. */
export function KpiTile({ label, value, unit, chip, caption, delta, tone, trend, trendTone = 'neutral', help, onClick, className }: KpiTileProps) {
  const labelNode = (
    <MetricCardLabel className="flex items-center gap-1.5">
      {tone ? <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', TONE_BG[tone])} /> : null}
      <span className="truncate">{label}</span>
    </MetricCardLabel>
  );
  return (
    <MetricCard
      variant="outlined"
      interactive={Boolean(onClick)}
      onClick={onClick}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
      className={cn('min-w-0', className)}
    >
      <MetricCardHeader>
        {help ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="min-w-0 flex-1 cursor-help">{labelNode}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">{help}</TooltipContent>
          </Tooltip>
        ) : (
          labelNode
        )}
      </MetricCardHeader>
      <MetricCardValue className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="truncate">
          {value}
          {unit ? <span className="ml-1 text-sm text-[var(--ec-fg-2)]">{unit}</span> : null}
        </span>
        {chip != null ? (
          <span className="rounded-full bg-[var(--ec-card-2)] px-2 text-xs leading-5 whitespace-nowrap text-[var(--ec-fg)]">{chip}</span>
        ) : null}
      </MetricCardValue>
      {trend && trend.length > 1 ? <Sparkline values={trend} tone={trendTone} ariaLabel={`${label} trend`} /> : null}
      {(delta || caption) && (
        <div className="flex min-w-0 items-center gap-2">
          {delta ? (
            <MetricCardDelta
              tone={delta.tone === 'good' ? 'positive' : delta.tone === 'bad' ? 'negative' : 'neutral'}
              direction={delta.direction}
            >
              {delta.text}
            </MetricCardDelta>
          ) : null}
          {caption ? <MetricCardCaption className="truncate">{caption}</MetricCardCaption> : null}
        </div>
      )}
    </MetricCard>
  );
}

/** Responsive KPI row: 1 col on phones, 2 on tablets, up to 4 on desktop. */
export function KpiRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4', className)}>{children}</div>;
}
