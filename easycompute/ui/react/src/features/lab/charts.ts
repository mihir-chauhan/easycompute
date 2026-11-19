/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import type { EChartsCoreOption } from '@/lib/echarts';
import { chartColor } from '@/lib/format';
import type { BadgeAppearance } from '@/components/ui/badge';

export interface TimeSeries {
  name: string;
  points: [number, number | null][];
  appearance: BadgeAppearance;
  dashed?: boolean;
  area?: boolean;
}

/** Light-grid time-series line chart (no smoothing, single axis), colours from semantic chart tokens. */
export function timeSeriesOption({
  series,
  yFormatter = (v: number) => String(v),
  yMax,
  height = 'auto',
  thresholds = [],
  legend = series.length > 1,
}: {
  series: TimeSeries[];
  yFormatter?: (v: number) => string;
  yMax?: number;
  height?: string;
  thresholds?: { value: number; label: string; appearance: BadgeAppearance }[];
  legend?: boolean;
}): EChartsCoreOption {
  return {
    animationDuration: 300,
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) => (typeof v === 'number' ? yFormatter(v) : '—'),
    },
    legend: legend ? { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 4 } : undefined,
    grid: { left: 8, right: 16, top: legend ? 32 : 12, bottom: 8, containLabel: true, height },
    xAxis: { type: 'time', axisLabel: { hideOverlap: true } },
    yAxis: { type: 'value', max: yMax, splitNumber: 4, axisLabel: { formatter: (v: number) => yFormatter(v) } },
    series: series.map((s, i) => ({
      name: s.name,
      type: 'line',
      showSymbol: false,
      smooth: false,
      data: s.points,
      lineStyle: { width: s.dashed ? 1.5 : 2, type: s.dashed ? 'dashed' : 'solid', color: chartColor(s.appearance) },
      itemStyle: { color: chartColor(s.appearance) },
      areaStyle: s.area ? { color: chartColor(s.appearance), opacity: 0.08 } : undefined,
      markLine:
        i === 0 && thresholds.length
          ? {
              symbol: 'none',
              silent: true,
              data: thresholds.map((t) => ({
                yAxis: t.value,
                label: { formatter: t.label, position: 'insideEndTop', color: chartColor(t.appearance) },
                lineStyle: { color: chartColor(t.appearance), type: 'dashed', width: 1 },
              })),
            }
          : undefined,
    })),
  };
}

/** Horizontal bar chart for ranked categories (single hue unless per-bar appearance given). */
export function hBarOption(
  rows: { label: string; value: number; appearance?: BadgeAppearance }[],
  formatter: (v: number) => string = (v) => String(v),
): EChartsCoreOption {
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: unknown) => (typeof v === 'number' ? formatter(v) : '—') },
    grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', axisLabel: { formatter: (v: number) => formatter(v) }, splitNumber: 3 },
    yAxis: { type: 'category', inverse: true, data: rows.map((r) => r.label), axisTick: { show: false } },
    series: [
      {
        type: 'bar',
        barMaxWidth: 16,
        data: rows.map((r) => ({ value: r.value, itemStyle: { color: chartColor(r.appearance ?? 'accent'), borderRadius: [0, 2, 2, 0] } })),
        label: { show: true, position: 'right', formatter: (p: { value: number }) => formatter(p.value), fontSize: 11 },
      },
    ],
  };
}
