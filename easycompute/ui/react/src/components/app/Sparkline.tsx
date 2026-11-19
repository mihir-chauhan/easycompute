/*
 * EasyCompute design system — Sparkline: tiny inline SVG trend (no eCharts instance, cheap in tables and KPI tiles).
 */

import React, { useMemo } from 'react';

import { cn } from '@/lib/utils';

import { TONE_FILL, TONE_STROKE, type Tone } from './tone';

interface SparklineProps {
  values: Array<number | null | undefined>;
  tone?: Tone;
  /** Fixed y domain, e.g. [0, 100] for percentages. Default: data min/max. */
  domain?: [number, number];
  /** Draw a light area under the line. */
  area?: boolean;
  /** Tailwind size classes; default fills the width at 28px tall. */
  className?: string;
  ariaLabel?: string;
}

const W = 100;
const H = 28;

export default function Sparkline({ values, tone = 'neutral', domain, area = true, className, ariaLabel }: SparklineProps) {
  const { line, fill } = useMemo(() => {
    const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null);
    if (pts.length < 2) return { line: '', fill: '' };
    const ys = pts.map((p) => p[1]);
    const lo = domain ? domain[0] : Math.min(...ys);
    const hi = domain ? domain[1] : Math.max(...ys);
    const span = hi - lo || 1;
    const n = values.length - 1 || 1;
    const xy = pts.map(([i, v]) => [(i / n) * W, H - 2 - ((v - lo) / span) * (H - 4)] as [number, number]);
    const d = xy.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
    return {
      line: d,
      fill: `${d} L${xy[xy.length - 1][0].toFixed(2)},${H} L${xy[0][0].toFixed(2)},${H} Z`,
    };
  }, [values, domain]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel ?? 'Trend'}
      className={cn('block h-7 w-full overflow-visible', className)}
    >
      {area && fill ? <path d={fill} className={cn(TONE_FILL[tone], 'opacity-15')} stroke="none" /> : null}
      {line ? <path d={line} fill="none" strokeWidth={1.5} className={TONE_STROKE[tone]} strokeLinejoin="round" /> : null}
    </svg>
  );
}
