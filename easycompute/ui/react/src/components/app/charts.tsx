/*
 * EasyCompute design system — eCharts option builders + ChartLegend + MetricChart card.
 * Rules: colour by meaning (tone / cluster / billing helpers in ./tone), single series = ink, no smoothing,
 * no dual axes, light gridlines, HTML legend under the chart (never the canvas legend).
 */

import React, { type ReactNode } from 'react';

import EChart from './Chart';
import type { EChartsCoreOption } from '@/lib/echarts';
import { cn } from '@/lib/utils';

import { ModelComputing, ModelProvenance, type Provenance } from './Model';
import { ChartSkeleton, EmptyState, ErrorState } from './PageStates';
import { SectionCard } from './SectionCard';
import { ecColor, toneColor, type Tone } from './tone';

export interface ChartSeries {
  name: string;
  data: Array<number | null>;
  /** Resolved colour (from toneColor / clusterColor / billingColor). Default: ink. */
  color?: string;
  /** Series with the same stack id stack. */
  stack?: string;
  /** Line charts: fill the area under the line. */
  area?: boolean;
  /** Line charts: dashed (forecast, target). */
  dashed?: boolean;
  /** Bar charts: per-bar colours for this series (e.g. tone per value). */
  colors?: string[];
}

export interface ChartThreshold {
  value: number;
  label: string;
  tone?: Tone;
}

const tooltipValue = (fmt?: (v: number) => string) => (v: unknown) =>
  typeof v === 'number' ? (fmt ? fmt(v) : v.toLocaleString('en-US', { maximumFractionDigits: 1 })) : '—';

function markLines(thresholds?: ChartThreshold[], horizontal = false) {
  if (!thresholds?.length) return undefined;
  return {
    silent: true,
    symbol: 'none',
    label: { show: true, position: horizontal ? 'start' : 'insideEndTop', formatter: '{b}', fontSize: 11, color: ecColor('--c3-style-basic-fg-secondary') },
    data: thresholds.map((t) => ({
      name: t.label,
      ...(horizontal ? { xAxis: t.value } : { yAxis: t.value }),
      lineStyle: { color: t.tone ? toneColor(t.tone) : ecColor('--ec-target'), type: 'dashed', width: 1 },
    })),
  };
}

interface BarOptionArgs {
  categories: string[];
  series: ChartSeries[];
  /** Horizontal bars (ranked lists with long labels). */
  horizontal?: boolean;
  valueFormat?: (v: number) => string;
  /** Axis max (e.g. 100 for percentages). */
  max?: number;
  thresholds?: ChartThreshold[];
  /** Per-bar colours for a single series (e.g. cluster colours or tone per value). */
  itemColors?: string[];
  barMaxWidth?: number;
}

/** Bar / stacked bar / horizontal bar. */
export function barOption({ categories, series, horizontal, valueFormat, max, thresholds, itemColors, barMaxWidth = 28 }: BarOptionArgs): EChartsCoreOption {
  const ink = ecColor('--ec-ink');
  const valueAxis = {
    type: 'value',
    max,
    axisLabel: { formatter: (v: number) => (valueFormat ? valueFormat(v) : v.toLocaleString('en-US', { notation: 'compact' })) },
  };
  const categoryAxis = { type: 'category', data: categories, axisLabel: { interval: 0, hideOverlap: true, width: horizontal ? 120 : 80, overflow: 'truncate' } };
  return {
    animationDuration: 400,
    grid: { containLabel: true, top: 16, right: horizontal ? 24 : 0, bottom: 0, left: 0 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: tooltipValue(valueFormat) },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series: series.map((s, i) => ({
      type: 'bar',
      name: s.name,
      stack: s.stack,
      data: (s.colors ?? (series.length === 1 ? itemColors : undefined))?.length
        ? s.data.map((v, k) => ({ value: v, itemStyle: { color: (s.colors ?? itemColors ?? [])[k] } }))
        : s.data,
      itemStyle: { color: s.color ?? ink, borderRadius: s.stack ? 0 : horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0] },
      barMaxWidth,
      emphasis: { focus: 'series' },
      markLine: i === 0 ? markLines(thresholds, horizontal) : undefined,
    })),
  };
}

interface LineOptionArgs {
  x: string[];
  series: ChartSeries[];
  valueFormat?: (v: number) => string;
  min?: number;
  max?: number;
  thresholds?: ChartThreshold[];
  /** Index from which the x axis is a forecast (shaded band). */
  forecastFrom?: number;
}

/** Time series / trend lines; straight segments, 1.5px, optional area and dashed forecast band. */
export function lineOption({ x, series, valueFormat, min, max, thresholds, forecastFrom }: LineOptionArgs): EChartsCoreOption {
  const ink = ecColor('--ec-ink');
  return {
    animationDuration: 400,
    grid: { containLabel: true, top: 16, right: 8, bottom: 0, left: 0 },
    tooltip: { trigger: 'axis', valueFormatter: tooltipValue(valueFormat) },
    xAxis: { type: 'category', data: x, boundaryGap: false, axisLabel: { hideOverlap: true } },
    yAxis: { type: 'value', min, max, axisLabel: { formatter: (v: number) => (valueFormat ? valueFormat(v) : v.toLocaleString('en-US', { notation: 'compact' })) } },
    series: series.map((s, i) => {
      const color = s.color ?? ink;
      return {
        type: 'line',
        name: s.name,
        data: s.data,
        stack: s.stack,
        smooth: false,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color, width: 2, type: s.dashed ? 'dashed' : 'solid' },
        itemStyle: { color },
        areaStyle: s.area ? { color, opacity: 0.16 } : undefined,
        markLine: i === 0 ? markLines(thresholds) : undefined,
        markArea:
          i === 0 && forecastFrom != null && forecastFrom < x.length
            ? {
                silent: true,
                itemStyle: { color: ecColor('--c3-style-basic-bg-secondary'), opacity: 0.6 },
                label: { show: true, position: 'insideTop', formatter: 'Forecast', fontSize: 11, color: ecColor('--c3-style-basic-fg-secondary') },
                data: [[{ xAxis: x[forecastFrom] }, { xAxis: x[x.length - 1] }]],
              }
            : undefined,
      };
    }),
  };
}

export interface LegendItem {
  label: string;
  /** A Tailwind bg class (TONE_BG / CLUSTER_BG / BILLING_BG) */
  swatchClass: string;
  /** Dashed line swatch (targets, forecasts). */
  dashed?: boolean;
  value?: ReactNode;
}

/** HTML legend under a chart: small swatches, 12px muted labels. */
export function ChartLegend({ items, className }: { items: LegendItem[]; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-[var(--c3-style-basic-fg-secondary)]', className)}>
      {items.map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5">
          {it.dashed ? (
            <span aria-hidden className="inline-block w-3 border-t-2 border-dashed border-[var(--ec-target)]" />
          ) : (
            <span aria-hidden className={cn('inline-block size-2.5 rounded-[2px]', it.swatchClass)} />
          )}
          <span>{it.label}</span>
          {it.value != null ? <span className="font-medium tabular-nums text-[var(--c3-style-basic-fg-primary)]">{it.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}

interface MetricChartProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  option?: EChartsCoreOption | null;
  legend?: LegendItem[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Shown when `empty` is true. */
  empty?: boolean;
  emptyLabel?: string;
  /** Tailwind height class for the canvas (default h-72 = 288px). */
  heightClass?: string;
  ariaLabel: string;
  onItemClick?: (name: string) => void;
  /** Extra content under the chart (bar list, notes). */
  footer?: ReactNode;
  /** MODEL_MAP component behind the numbers: "<model> is computing…" while loading, provenance chip after. */
  model?: string;
  provenance?: Provenance | null;
  /** Live view: merge option updates so the chart animates between polls. */
  live?: boolean;
  className?: string;
}

/** Chart card: SectionCard + EChart + HTML legend, with loading / empty / error states built in. */
export function MetricChart({ title, subtitle, actions, option, legend, loading, error, onRetry, empty, emptyLabel = 'No data for this view yet.', heightClass = 'h-72', ariaLabel, onItemClick, footer, model, provenance, live, className }: MetricChartProps) {
  let body: ReactNode;
  if (error) body = <ErrorState message={error} onRetry={onRetry} />;
  else if (loading)
    body = (
      <div className="flex flex-col gap-2">
        {model ? <ModelComputing component={model} /> : null}
        <ChartSkeleton className={heightClass} />
      </div>
    );
  else if (empty || !option) body = <EmptyState title={emptyLabel} className={heightClass} />;
  else body = <EChart option={option} className={heightClass} ariaLabel={ariaLabel} onItemClick={onItemClick} merge={live} />;
  return (
    <SectionCard
      title={title}
      subtitle={subtitle}
      actions={
        actions || (model && !loading) ? (
          <span className="flex items-center gap-2">
            {model && !loading ? <ModelProvenance component={model} provenance={provenance} compact /> : null}
            {actions}
          </span>
        ) : undefined
      }
      className={cn('h-full', className)}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {body}
        {legend && legend.length > 0 && !error && !loading ? <ChartLegend items={legend} /> : null}
        {footer}
      </div>
    </SectionCard>
  );
}
