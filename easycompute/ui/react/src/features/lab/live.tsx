/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';

import { liveSnapshot } from './api';
import type { Job, JobMetric, LiveSnapshot, SnapJob } from './types';

/** Poll interval for live views (runs, run detail, dashboard, home launched card). */
export const LIVE_POLL_MS = 7000;

/** True while the tab is visible; polling and tickers pause when it is hidden. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/** Wall clock that re-renders every `ms` (default 1 s) while the tab is visible. */
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

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};

/** Pulsing "LIVE · updated 4s ago" indicator for polled views. */
export function LiveBadge({ updatedAt, className }: { updatedAt: number | null; className?: string }) {
  const now = useNow(1000);
  const visible = usePageVisible();
  const stale = updatedAt != null && now - updatedAt > 3 * LIVE_POLL_MS;
  return (
    <span
      role="status"
      aria-live="off"
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full border border-[var(--c3-style-basic-border-border)] px-2.5 text-[11.5px] font-medium whitespace-nowrap text-[var(--c3-style-basic-fg-secondary)]',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-block size-[7px] rounded-full',
          !visible || stale ? 'bg-[var(--c3-style-basic-fg-secondary)]' : 'ec-pulse bg-[var(--ec-accent-hi,var(--c3-style-basic-fg-success))]',
        )}
      />
      <span className="text-[var(--c3-style-basic-fg-primary)]">{visible ? 'LIVE' : 'PAUSED'}</span>
      {updatedAt != null && <span>{`· updated ${ago(now - updatedAt)}`}</span>}
    </span>
  );
}

/**
 * A running job's numbers advanced to `now` from the last server read (`readAt`): elapsed walltime and cost tick
 * forward at the job's own burn rate between polls; the next poll replaces them with server values.
 */
export function liveJob(j: Job, readAt: number | null, now: number, progressPerRealSec?: number): Job {
  if (j.state !== 'RUNNING' || readAt == null) return j;
  const dtH = Math.max(0, ((now - readAt) / 1000) * (progressPerRealSec ?? 1 / 3600));
  const elapsed = j.elapsedHours ?? 0;
  const rate = elapsed > 0 ? (j.costUsd ?? 0) / elapsed : 0;
  const capped = j.timelimitHours != null ? Math.min(j.timelimitHours, elapsed + dtH) : elapsed + dtH;
  return { ...j, elapsedHours: capped, costUsd: (j.costUsd ?? 0) + rate * (capped - elapsed) };
}

/** Deterministic jitter in [-1, 1] for a key (stable across re-renders). */
export function seeded(key: string, n: number): number {
  let h = 2166136261;
  const str = `${key}:${n}`;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** Footer slot for live views (intentionally empty). */
export const SimNote = () => null;

/** Overlay a liveSnapshot entry on a fetched Job (snapshot wins: it is newer). */
export function mergeSnap(j: Job, s?: SnapJob): Job & { queuePosition?: number | null; etaStartAt?: string | null; progressPerRealSec?: number; latest?: SnapJob['latest'] } {
  if (!s) return j;
  return {
    ...j,
    state: s.state ?? j.state,
    nodeList: s.nodeList ?? j.nodeList,
    startTime: s.startTime ?? j.startTime,
    endTime: s.endTime ?? j.endTime,
    elapsedHours: s.elapsedHours ?? j.elapsedHours,
    timelimitHours: s.timelimitHours ?? j.timelimitHours,
    costUnits: s.costUnits ?? j.costUnits,
    costUsd: s.costUsd ?? j.costUsd,
    allocGpus: s.gpus ?? j.allocGpus,
    qos: s.qos ?? j.qos,
    queuePosition: s.queuePosition,
    etaStartAt: s.etaStartAt,
    progressPerRealSec: s.progressPerRealSec,
    latest: s.latest,
  };
}

/** Append the snapshot's latest sample when it is newer than the last fetched JobMetric. */
export function withLatest(ms: JobMetric[], latest?: SnapJob['latest'] | null): JobMetric[] {
  if (!latest?.ts) return ms;
  const last = ms.at(-1);
  if (last && last.ts >= latest.ts) return ms;
  return [...ms, { id: `snap-${latest.ts}`, ...latest } as JobMetric];
}

/**
 * Live-state adapter: polls `RunMonitor.liveSnapshot(labId)` every LIVE_POLL_MS while the tab is visible. If the
 * backend method is not available yet it stops silently and returns `null`, and pages keep using their own polled
 * Job / JobMetric fetches (the one-line swap the integrator asked for lives here).
 */
export function useLiveSnapshot(labId: string | null): { snap: LiveSnapshot | null; byJob: Record<string, SnapJob>; updatedAt: number | null } {
  const visible = usePageVisible();
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [off, setOff] = useState(false);
  useEffect(() => {
    if (!labId || off || !visible) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const run = () => {
      liveSnapshot(labId)
        .then((s) => {
          if (cancelled) return;
          if (!s || !Array.isArray(s.jobs)) {
            setOff(true);
            return;
          }
          setSnap(s);
          setUpdatedAt(Date.now());
          timer = window.setTimeout(run, LIVE_POLL_MS);
        })
        .catch(() => {
          if (!cancelled) setOff(true);
        });
    };
    run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [labId, off, visible]);
  const byJob = useMemo(() => Object.fromEntries((snap?.jobs ?? []).map((j) => [j.id, j])), [snap]);
  return { snap, byJob, updatedAt };
}
