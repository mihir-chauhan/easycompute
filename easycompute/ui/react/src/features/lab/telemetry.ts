/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

/*
 * Live job telemetry for charts, cards and sparklines.
 *   const series = useTelemetry(job, serverMetrics);            // JobMetric[] from start to now, extends every 2 s
 * Server JobMetric samples are always kept as-is. Where they are missing (before the first sample, gaps, after the last
 * sample) the series is completed from the job's workload profile (deterministic per job id) and shifted so it joins
 * the server samples exactly, so it never contradicts them.
 */

import { useMemo } from 'react';

import { seededNoise } from '@/components/app';

import { useNow } from './live';
import type { JobMetric, JobState, WorkloadType } from './types';

/** The job fields the profile needs (a Job merged with its liveSnapshot entry works). */
export interface TelemetryJob {
  id: string;
  state?: JobState;
  workloadType?: WorkloadType;
  startTime?: string;
  submitTime?: string;
  elapsedHours?: number;
  progressPerRealSec?: number;
  gpuType?: { id: string };
  gpuTypeId?: string;
  allocGpus?: number;
}

export type TelemetryPoint = JobMetric & { t: number };

interface Options {
  /** How far back to show (default: from job start, at most 6 h). */
  windowMs?: number;
  /** Target number of points in the older part of the window (default 120). */
  points?: number;
}

/** Charts and cards refresh at this cadence. */
export const TELEMETRY_TICK_MS = 2000;
const FINE_SPAN_MS = 90_000;
const LADDER = [2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3];
const KEYS = ['gpuUtilPct', 'gpuMemPct', 'cpuUtilPct', 'memPct', 'ioReadMBps', 'ioWriteMBps', 'powerW', 'trainingLoss'] as const;
type Key = (typeof KEYS)[number];
type Sample = Partial<Record<Key | 'checkpointAgeMin', number | null>>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Stable per-job parameter in [0, 1]. */
const u = (id: string, name: string) => (seededNoise(`${id}:${name}`, 7) + 1) / 2;
/** Smooth value noise in [-1, 1] over real time with the given period. */
const vnoise = (seed: string, t: number, period: number) => {
  const x = t / period;
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return seededNoise(seed, i) * (1 - s) + seededNoise(seed, i + 1) * s;
};

const tdp = (gpu?: string) => {
  const g = (gpu ?? '').toUpperCase();
  if (g.includes('H100') || g.includes('H200') || g.includes('B200')) return 700;
  if (g.includes('A100')) return 400;
  if (g.includes('A30') || g.includes('A10')) return 165;
  if (g.includes('L40') || g.includes('V100')) return 300;
  return 350;
};

/** Default progress rate (job hours per real second) when the server does not report one. */
const DEFAULT_RATE = 10 / 3600;

function rateOf(job: TelemetryJob): number {
  return job.progressPerRealSec && job.progressPerRealSec > 0 ? job.progressPerRealSec : DEFAULT_RATE;
}

function originOf(job: TelemetryJob, now: number, rate: number): number {
  const start = job.startTime ? Date.parse(job.startTime) : NaN;
  if (Number.isFinite(start) && start <= now) return start;
  const fromElapsed = now - ((job.elapsedHours ?? 0) / rate) * 1000;
  return Math.round(fromElapsed / 1000) * 1000;
}

/** Workload profile value of every metric at real time `t` (`p` = job progress hours at `t`). */
function profile(job: TelemetryJob, t: number, p: number): Sample {
  const id = job.id;
  const pm = p * 60;
  const fast = (k: string) => vnoise(`${id}:${k}:f`, t, 2500);
  const slow = (k: string) => vnoise(`${id}:${k}:s`, t, 45000);
  const wt = job.workloadType ?? 'TRAINING';
  const power = (util: number) => tdp(job.gpuType?.id ?? job.gpuTypeId) * (0.2 + 0.75 * (util / 100)) + 6 * fast('pw');
  const ramp = (min: number) => 1 - Math.exp(-pm / min);

  if (wt === 'INFERENCE') {
    const util = 55 + 30 * (0.5 + 0.5 * vnoise(`${id}:burst`, t, 20000)) + 3 * fast('u');
    return {
      gpuUtilPct: util,
      gpuMemPct: (40 + 25 * u(id, 'mem')) * ramp(2) + 0.5 * fast('m'),
      cpuUtilPct: 20 + 10 * u(id, 'cpu') + 3 * fast('c'),
      memPct: 25 + 15 * u(id, 'ram') + slow('r'),
      ioReadMBps: 40 + 30 * (0.5 + 0.5 * slow('io')),
      ioWriteMBps: 2 + Math.abs(2 * fast('w')),
      powerW: power(util),
      trainingLoss: null,
      checkpointAgeMin: null,
    };
  }
  if (wt === 'DATA_PROCESSING') {
    const util = 8 + 10 * u(id, 'lvl') + 3 * fast('u');
    return {
      gpuUtilPct: util,
      gpuMemPct: (10 + 10 * u(id, 'mem')) * ramp(3),
      cpuUtilPct: 85 + 12 * (0.5 + 0.5 * slow('c')) + fast('c'),
      memPct: (45 + 25 * u(id, 'ram')) * ramp(5) + slow('r'),
      ioReadMBps: 600 + 500 * (0.5 + 0.5 * slow('io')) + 40 * fast('io'),
      ioWriteMBps: 150 + 120 * (0.5 + 0.5 * slow('w')),
      powerW: power(util),
      trainingLoss: null,
      checkpointAgeMin: null,
    };
  }
  if (wt === 'INTERACTIVE') {
    const active = vnoise(`${id}:act`, t, 90000) > -0.1;
    const util = active ? 55 + 25 * (0.5 + 0.5 * slow('u')) + 4 * fast('u') : 2 + 2 * Math.abs(fast('u'));
    return {
      gpuUtilPct: util,
      gpuMemPct: (30 + 30 * u(id, 'mem')) * ramp(4) + 0.5 * fast('m'),
      cpuUtilPct: active ? 30 + 10 * fast('c') : 5 + 2 * Math.abs(fast('c')),
      memPct: 20 + 15 * u(id, 'ram') + slow('r'),
      ioReadMBps: active ? 60 + 30 * Math.abs(fast('io')) : 1,
      ioWriteMBps: 1 + Math.abs(fast('w')),
      powerW: power(util),
      trainingLoss: null,
      checkpointAgeMin: null,
    };
  }

  // TRAINING / FINETUNE / SIMULATION: warm-up, steady compute, periodic checkpoints.
  const sim = wt === 'SIMULATION';
  const warm = clamp(pm / (sim ? 8 : 15), 0, 1);
  const ease = 1 - Math.pow(1 - warm, 2);
  const ck = sim ? 15 : 30 + 30 * u(id, 'ck');
  const phase = pm % ck;
  const inCk = pm >= ck && phase < 1.5;
  const steady = sim ? 90 + 8 * u(id, 'lvl') : 85 + 12 * u(id, 'lvl');
  let util = 20 + (steady - 20) * ease + 2.5 * fast('u') + 1.5 * slow('u');
  if (warm >= 1 && vnoise(`${id}:dip`, t, 40000) > 0.88) util -= 18;
  if (inCk) util *= 0.62;
  const memPlateau = 55 + 30 * u(id, 'mem');
  const l0 = 2.2 + 1.6 * u(id, 'l0');
  const lf = 0.25 + 0.45 * u(id, 'lf');
  const tau = 3 + 6 * u(id, 'lt');
  const loss = lf + (l0 - lf) * Math.exp(-p / tau);
  return {
    gpuUtilPct: util,
    gpuMemPct: 6 + (memPlateau - 6) * ramp(sim ? 3 : 6) + 0.6 * fast('m'),
    cpuUtilPct: (warm < 1 ? 55 * (1 - warm) : 0) + 22 + 15 * u(id, 'cpu') + 3 * fast('c'),
    memPct: (28 + 22 * u(id, 'ram')) * ramp(4) + slow('r'),
    ioReadMBps: warm < 1 ? 950 - 780 * warm + 30 * fast('io') : 120 + 90 * u(id, 'io') + 35 * fast('io'),
    ioWriteMBps: inCk ? 600 + 400 * u(id, 'cw') + 40 * fast('w') : 4 + 3 * Math.abs(fast('w')),
    powerW: power(util),
    trainingLoss: sim ? null : loss * (1 + 0.035 * fast('l') + 0.02 * slow('l')),
    checkpointAgeMin: pm < ck ? pm : phase,
  };
}

const finalize = (k: Key, v: number) => {
  if (k === 'gpuUtilPct' || k === 'cpuUtilPct') return Math.round(clamp(v, 0, 100) * 10) / 10;
  if (k === 'gpuMemPct' || k === 'memPct') return Math.round(clamp(v, 0, 99) * 10) / 10;
  if (k === 'trainingLoss') return Math.round(Math.max(0.01, v) * 1000) / 1000;
  return Math.round(Math.max(0, v) * 10) / 10;
};

/**
 * Series for one job from its start (or `windowMs` back) to `now`. Not running: the server samples as they are.
 * Running: server samples kept exactly; missing stretches completed from the job's profile, offset to join them.
 */
export function buildTelemetry(job: TelemetryJob, server: JobMetric[], now: number, { windowMs = 6 * 3600_000, points = 120 }: Options = {}): TelemetryPoint[] {
  const real: TelemetryPoint[] = server
    .map((m) => ({ ...m, t: Date.parse(m.ts) }))
    .filter((m) => Number.isFinite(m.t))
    .sort((a, b) => a.t - b.t);
  if (job.state !== 'RUNNING') return real;

  const rate = rateOf(job);
  const origin = originOf(job, now, rate);
  const from = Math.max(origin, now - windowMs);
  const prog = (t: number) => Math.max(0, ((t - origin) / 1000) * rate);
  const shown = real.filter((m) => m.t >= from - 60_000 && m.t <= now + 5000);

  // Grid: coarse (epoch-aligned, stable between renders) for the older part, 2 s for the last 90 s.
  const fineFrom = Math.max(from, now - FINE_SPAN_MS);
  const step = LADDER.find((s) => (fineFrom - from) / s <= points) ?? LADDER[LADDER.length - 1];
  const grid: number[] = [];
  for (let t = Math.ceil(from / step) * step; t < fineFrom; t += step) grid.push(t);
  for (let t = Math.ceil(fineFrom / TELEMETRY_TICK_MS) * TELEMETRY_TICK_MS; t <= now; t += TELEMETRY_TICK_MS) grid.push(t);
  if (from === origin && (!grid.length || grid[0] > origin)) grid.unshift(origin);

  const last = shown.at(-1);
  const cover = Math.max(step, 20_000) * 0.75;
  const near = (t: number) => shown.some((m) => Math.abs(m.t - t) < cover);
  const fill = grid.filter((t) => (last && t > last.t ? true : !near(t)));

  // Per-metric offset (server - profile) at each server sample: interpolated between samples, held outside them.
  const anchors = Object.fromEntries(
    KEYS.map((k) => [k, shown.filter((m) => m[k] != null).map((m) => ({ t: m.t, d: (m[k] as number) - ((profile(job, m.t, prog(m.t))[k] as number | null) ?? (m[k] as number)) }))]),
  ) as Record<Key, { t: number; d: number }[]>;
  const offset = (k: Key, t: number) => {
    const a = anchors[k];
    if (!a.length) return 0;
    if (t <= a[0].t) return a[0].d;
    const lastA = a[a.length - 1];
    if (t >= lastA.t) return lastA.d;
    const i = a.findIndex((x) => x.t > t);
    const f = (t - a[i - 1].t) / (a[i].t - a[i - 1].t);
    return a[i - 1].d + (a[i].d - a[i - 1].d) * f;
  };
  const ckReal = shown.filter((m) => m.checkpointAgeMin != null);

  const synth: TelemetryPoint[] = fill.map((t) => {
    const p = profile(job, t, prog(t));
    const out: TelemetryPoint = { id: `${job.id}:${t}`, ts: new Date(t).toISOString(), t };
    KEYS.forEach((k) => {
      const v = p[k];
      if (v != null) out[k] = finalize(k, v + offset(k, t));
    });
    // Checkpoint age keeps counting from the most recent server reading before `t`.
    const prev = [...ckReal].reverse().find((m) => m.t <= t);
    out.checkpointAgeMin = prev ? Math.round(((prev.checkpointAgeMin as number) + ((t - prev.t) / 1000) * rate * 60) * 10) / 10 : p.checkpointAgeMin != null ? Math.round(p.checkpointAgeMin * 10) / 10 : undefined;
    return out;
  });

  return [...shown.filter((m) => m.t >= from), ...synth].sort((a, b) => a.t - b.t);
}

/** `buildTelemetry` re-evaluated every 2 s. Pass a stable `server` array (memoized) to avoid extra work. */
export function useTelemetry(job: TelemetryJob | null | undefined, server: JobMetric[] | undefined, opts: Options = {}): TelemetryPoint[] {
  const now = useNow(TELEMETRY_TICK_MS);
  const { windowMs, points } = opts;
  return useMemo(
    () => (job ? buildTelemetry(job, server ?? [], now, { windowMs, points }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [job?.id, job?.state, job?.workloadType, job?.startTime, job?.progressPerRealSec, job?.gpuType?.id, job?.gpuTypeId, server, now, windowMs, points],
  );
}

/**
 * Average GPU util across several jobs' series on a shared time grid (30 s steps, 2 s for the last minute), for
 * lab-wide charts. A job counts from its first point on.
 */
export function fleetUtil(seriesList: TelemetryPoint[][], now: number, windowMs = 30 * 60_000): { t: number[]; v: (number | null)[] } {
  const lists = seriesList.filter((s) => s.some((p) => p.gpuUtilPct != null));
  const grid: number[] = [];
  const fineFrom = now - 60_000;
  for (let t = Math.ceil((now - windowMs) / 30_000) * 30_000; t < fineFrom; t += 30_000) grid.push(t);
  for (let t = Math.ceil(fineFrom / TELEMETRY_TICK_MS) * TELEMETRY_TICK_MS; t <= now; t += TELEMETRY_TICK_MS) grid.push(t);
  const v = grid.map((t) => {
    const vals = lists.map((s) => [...s].reverse().find((p) => p.t <= t && p.gpuUtilPct != null)?.gpuUtilPct).filter((x): x is number => x != null);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  });
  return { t: grid, v };
}
