/*
 * EasyCompute design system — live views (SPEC "LIVE CLUSTER SIMULATION").
 *   const { data, updatedAt } = useLivePoll(() => getLiveSnapshot(), { intervalMs: 7000 });
 *   <LiveIndicator updatedAt={updatedAt} />                     "● LIVE · updated 4s ago"
 *   const series = useStreamingSeries(serverPoints, { seed: job.id, jitter: 2, min: 0, max: 100 });
 *   const cost = useAccrual(job.costUsd, usdPerHour / 3600, updatedAt);   // ticks every second between polls
 *   const shown = useAnimatedNumber(value);                       // eases between polled values
 * Polling pauses while the tab is hidden and refreshes immediately when it becomes visible again.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, type DependencyList } from 'react';

import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { errorMessage } from '@/components/PageFrame/PageFrame';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ timing ------------------------------------------------------------------ */

/** True while the document is visible. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/** Current time, re-rendering every `ms` (default 1 s) while the page is visible. */
export function useNow(ms = 1000): number {
  const visible = usePageVisible();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return undefined;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms, visible]);
  return now;
}

/* ----------------------------------------------------------------- polling ----------------------------------------------------------------- */

export interface LivePoll<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Time (ms) of the last successful response. */
  updatedAt: number | null;
  /** False while paused (tab hidden or `enabled: false`). */
  live: boolean;
  reload: () => void;
}

interface LivePollOptions {
  /** Poll interval, clamped to >= 5000 ms (preview-safety rule). Default 7000. */
  intervalMs?: number;
  enabled?: boolean;
}

/**
 * Loader on a timer: no overlapping requests, keeps the last good data on errors (shows the error once), pauses while
 * the tab is hidden, refreshes on return, cancels on unmount (StrictMode-safe).
 */
export function useLivePoll<T>(loader: () => Promise<T>, deps: DependencyList, { intervalMs = 7000, enabled = true }: LivePollOptions = {}): LivePoll<T> {
  const { reportError } = useErrorBoundary();
  const visible = usePageVisible();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [kick, setKick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const reload = useCallback(() => setKick((k) => k + 1), []);
  const active = enabled && visible;

  // Reset when the dependencies change (e.g. a different cluster id).
  useEffect(() => {
    setData(null);
    setLoading(true);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    let reported = false;
    const run = () => {
      loaderRef
        .current()
        .then((res) => {
          if (cancelled) return;
          setData(res);
          setError(null);
          setUpdatedAt(Date.now());
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(errorMessage(err));
          if (!reported) {
            reported = true;
            reportError(err);
          }
        })
        .finally(() => {
          if (cancelled) return;
          setLoading(false);
          timer = window.setTimeout(run, Math.max(5000, intervalMs));
        });
    };
    run();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, active, intervalMs, kick]);

  return { data, loading, error, updatedAt, live: active, reload };
}

/* -------------------------------------------------------------- LiveIndicator -------------------------------------------------------------- */

const agoText = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** "● LIVE · updated 4s ago" (pulsing while live; grey "PAUSED" while the tab is hidden; amber when stale). */
export function LiveIndicator({ updatedAt, live = true, staleAfterMs = 30000, className }: { updatedAt: number | null; live?: boolean; staleAfterMs?: number; className?: string }) {
  const now = useNow(1000);
  const age = updatedAt ? now - updatedAt : null;
  const stale = age != null && age > staleAfterMs;
  return (
    <span className={cn('inline-flex items-center gap-2 text-xs whitespace-nowrap text-[var(--ec-fg-2)]', className)} role="status" aria-live="off">
      <span
        className={cn(
          'inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold tracking-wide',
          !live ? 'bg-[var(--ec-card-2)] text-[var(--ec-fg-2)]' : stale ? 'bg-[var(--ec-warn-bg)] text-[var(--ec-warn-fg)]' : 'bg-[var(--ec-accent-bg)] text-[var(--ec-accent-hi)]',
        )}
      >
        <span aria-hidden className={cn('size-1.5 rounded-full', !live ? 'bg-[var(--ec-fg-3)]' : stale ? 'bg-[var(--ec-warn)]' : 'ec-pulse bg-[var(--ec-accent-hi)]')} />
        {live ? 'LIVE' : 'PAUSED'}
      </span>
      <span className="tabular-nums">{age == null ? 'connecting…' : `updated ${agoText(age)}`}</span>
    </span>
  );
}

/** Small honest footer line for live views. */
export function SimulatedTelemetryNote(_props: { className?: string }) {
  return null;
}

/* ---------------------------------------------------------- streaming & accrual ---------------------------------------------------------- */

/** Deterministic noise in [-1, 1] for a seed string and an integer step. */
export function seededNoise(seed: string, step: number): number {
  let h = 2166136261 ^ step;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967295) * 2 - 1;
}

export interface SeriesPoint {
  /** Epoch ms. */
  t: number;
  v: number | null;
  /** True for client-side interpolated points (render dimmer / dashed if desired). */
  synthetic?: boolean;
}

interface StreamingOptions {
  /** Seed for deterministic jitter (e.g. job id + metric). */
  seed: string;
  /** Spacing of synthetic points, ms (default 1500). */
  stepMs?: number;
  /** Max jitter amplitude around the last server value (default 1.5 units). */
  jitter?: number;
  min?: number;
  max?: number;
  /** Stop extending after this long without a new server sample (default 120 s). */
  maxGapMs?: number;
}

/**
 * Server samples plus a smooth synthetic tail from the last server sample to "now", one point per `stepMs` with
 * seeded, mean-reverting jitter around the last server value. Server points are always kept exactly, and the tail is
 * discarded as soon as a newer server sample arrives, so the chart never contradicts the server.
 */
export function useStreamingSeries(server: SeriesPoint[], { seed, stepMs = 1500, jitter = 1.5, min = -Infinity, max = Infinity, maxGapMs = 120000 }: StreamingOptions): SeriesPoint[] {
  const now = useNow(stepMs);
  return useMemo(() => {
    const pts = server.filter((p) => p.v != null).sort((a, b) => a.t - b.t);
    if (!pts.length) return server;
    const last = pts[pts.length - 1];
    const end = Math.min(now, last.t + maxGapMs);
    const tail: SeriesPoint[] = [];
    let v = last.v as number;
    for (let t = last.t + stepMs, k = 1; t <= end; t += stepMs, k++) {
      // Mean-reverting walk: pulls back toward the server value so the tail stays honest.
      v = v + ((last.v as number) - v) * 0.35 + seededNoise(seed, Math.floor(t / stepMs)) * jitter * 0.6;
      tail.push({ t, v: Math.max(min, Math.min(max, v)), synthetic: true });
      if (k > 400) break;
    }
    return [...pts, ...tail];
  }, [server, now, seed, stepMs, jitter, min, max, maxGapMs]);
}

/**
 * A value that keeps accruing between polls: `base + ratePerSec * seconds since updatedAt` (capped at `maxSeconds`,
 * default 60 s, so a stalled poll does not run away). Use for costs, GPU-hours, elapsed time.
 */
export function useAccrual(base: number | null | undefined, ratePerSec: number, updatedAt: number | null, maxSeconds = 60): number | null {
  const now = useNow(1000);
  if (base == null) return null;
  if (!updatedAt || !ratePerSec) return base;
  return base + ratePerSec * Math.min(maxSeconds, Math.max(0, (now - updatedAt) / 1000));
}

/** Eases a number toward its latest value (requestAnimationFrame, ~`durationMs`). */
export function useAnimatedNumber(target: number | null | undefined, durationMs = 700): number | null {
  const [shown, setShown] = useState<number | null>(target ?? null);
  const fromRef = useRef<number | null>(target ?? null);
  useEffect(() => {
    if (target == null) {
      setShown(null);
      fromRef.current = null;
      return undefined;
    }
    const from = fromRef.current;
    if (from == null || from === target || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setShown(target);
      fromRef.current = target;
      return undefined;
    }
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / durationMs);
      const e = 1 - Math.pow(1 - k, 3);
      const v = from + (target - from) * e;
      setShown(v);
      fromRef.current = v;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return shown;
}

/** Renders an animated number with a formatter: `<LiveNumber value={usd} format={formatUsd} />`. */
export function LiveNumber({ value, format = (v) => Math.round(v).toLocaleString('en-US') }: { value: number | null | undefined; format?: (v: number) => string }) {
  const v = useAnimatedNumber(value);
  return <span className="tabular-nums">{v == null ? '—' : format(v)}</span>;
}

/** Observed rate of change per second between successive polled values (0 until two samples). */
export function useObservedRate(value: number | null | undefined, updatedAt: number | null): number {
  const prev = useRef<{ v: number; t: number } | null>(null);
  const [rate, setRate] = useState(0);
  useEffect(() => {
    if (value == null || !updatedAt) return;
    const p = prev.current;
    if (p && updatedAt > p.t && value >= p.v) setRate((value - p.v) / ((updatedAt - p.t) / 1000));
    prev.current = { v: value, t: updatedAt };
  }, [value, updatedAt]);
  return rate;
}
