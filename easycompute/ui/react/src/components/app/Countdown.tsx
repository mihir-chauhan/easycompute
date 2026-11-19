/*
 * EasyCompute design system — Countdown (walltime left, deadline in N days).
 */

import React, { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';

import { cn } from '@/lib/utils';

import { TONE_TEXT, type Tone } from './tone';

/** "3d 4h", "5h 12m", "18m", or "overdue 2h". */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const m = Math.floor(abs / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  const body = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${mm}m` : `${mm}m`;
  return ms < 0 ? `overdue ${body}` : body;
}

interface CountdownProps {
  /** ISO target time, or */
  to?: string | null;
  /** hours remaining from now (e.g. job timelimit - elapsed). */
  hoursLeft?: number | null;
  /** Warn below this many hours (default 2), bad below `badHours` (default 0.5) or when past. */
  warnHours?: number;
  badHours?: number;
  /** Prefix text, e.g. "left" is appended automatically; set `suffix=""` to drop it. */
  suffix?: string;
  icon?: boolean;
  className?: string;
}

/** Live countdown that re-renders every 30 s; coloured by urgency. */
export default function Countdown({ to, hoursLeft, warnHours = 2, badHours = 0.5, suffix = 'left', icon = true, className }: CountdownProps) {
  const [anchor] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(t);
  }, []);

  let target: number | null = null;
  if (to) {
    const t = new Date(to).getTime();
    target = Number.isNaN(t) ? null : t;
  } else if (hoursLeft != null) {
    target = anchor + hoursLeft * 3600000;
  }
  if (target == null) return <span className="text-[var(--c3-style-basic-fg-secondary)]">—</span>;

  const ms = target - now;
  const hrs = ms / 3600000;
  const tone: Tone = hrs < badHours ? 'bad' : hrs < warnHours ? 'warn' : 'neutral';
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap tabular-nums', tone === 'neutral' ? 'text-[var(--c3-style-basic-fg-primary)]' : TONE_TEXT[tone], className)}>
      {icon ? <Clock className="size-3.5 shrink-0" aria-hidden /> : null}
      {formatDuration(ms)}
      {ms >= 0 && suffix ? ` ${suffix}` : ''}
    </span>
  );
}
