/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useEffect, useRef } from 'react';

import { echarts, type ECharts, type EChartsCoreOption } from '@/lib/echarts';
import { C3_THEME_NAME, ensureC3Theme, subscribeToThemeChanges } from '@/lib/echarts-theme';
import { cn } from '@/lib/utils';

interface EChartProps {
  option: EChartsCoreOption;
  /** Tailwind height class, e.g. `h-72`. The chart always fills its container width. */
  className?: string;
  ariaLabel: string;
  /** Called with the clicked data item's name (category / slice). */
  onItemClick?: (name: string) => void;
  /** Live views: merge updates into the running chart so bars/lines glide instead of redrawing. */
  merge?: boolean;
}

/**
 * (components/app copy of components/charts/EChart with a `merge` mode for live updates.)
 * Thin eCharts canvas wrapper that uses the token-driven C3 theme (colors come from
 * `--c3-style-chart-chart-*`), resizes with its container, and re-themes when `.dark` flips.
 */
export default function EChart({ option, className, ariaLabel, onItemClick, merge = false }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const optionRef = useRef(option);
  const clickRef = useRef(onItemClick);
  optionRef.current = option;
  clickRef.current = onItemClick;

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    ensureC3Theme(echarts);

    const init = () => {
      chartRef.current?.dispose();
      const chart = echarts.init(el, C3_THEME_NAME);
      chart.setOption(optionRef.current);
      chart.on('click', (params: { name?: string }) => {
        if (params.name && clickRef.current) clickRef.current(params.name);
      });
      chartRef.current = chart;
    };
    init();

    const unsubscribe = subscribeToThemeChanges(init);
    const observer = new ResizeObserver(() => chartRef.current?.resize());
    observer.observe(el);

    return () => {
      unsubscribe();
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: !merge, lazyUpdate: merge });
  }, [option, merge]);

  return <div ref={ref} role="img" aria-label={ariaLabel} className={cn('h-72 w-full min-w-0', className)} />;
}
