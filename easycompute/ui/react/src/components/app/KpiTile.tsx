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

/** KPI tile: 13px muted label, 28px semibold tabular value, one-line caption. */
export function KpiTile({ label, value, unit, caption, delta, tone, trend, trendTone = 'neutral', help, onClick, className }: KpiTileProps) {
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
      <MetricCardValue className="flex items-baseline gap-1">
        <span className="truncate">{value}</span>
        {unit ? <span className="text-sm font-medium text-[var(--c3-style-basic-fg-secondary)]">{unit}</span> : null}
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
