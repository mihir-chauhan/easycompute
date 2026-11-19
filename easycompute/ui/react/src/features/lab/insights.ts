/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import type { Job } from './types';

/** Failed runs burn every GPU-hour they used. */
const FAILED = new Set(['FAILED', 'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL', 'PREEMPTED']);

export const gpuHours = (j: Job): number => (j.allocGpus ?? 0) * (j.elapsedHours ?? 0);

/**
 * Wasted GPU-hours for a finished job: all of it when the run failed (no usable result), otherwise the idle
 * share of runs that averaged under 50% GPU utilization.
 */
export const wastedGpuHours = (j: Job): number => {
  const gh = gpuHours(j);
  if (!gh) return 0;
  if (FAILED.has(j.state ?? '')) return gh;
  const u = j.gpuUtilAvg;
  return u != null && u < 50 ? gh * (1 - u / 100) : 0;
};

export interface WastePattern {
  key: string;
  label: string;
  jobs: number;
  wastedGpuHours: number;
  wastedUsd: number;
  recommendation: string;
}

const usdPerGpuHour = (j: Job) => {
  const gh = gpuHours(j);
  return gh ? (j.costUsd ?? 0) / gh : 0;
};

export function wastePatterns(jobs: Job[]): WastePattern[] {
  const defs: { key: string; label: string; test: (j: Job) => boolean; waste: (j: Job) => number; recommendation: string }[] = [
    {
      key: 'idle',
      label: 'Idle GPUs (< 10% utilization)',
      test: (j) => !FAILED.has(j.state ?? '') && j.gpuUtilAvg != null && j.gpuUtilAvg < 10 && gpuHours(j) > 0,
      waste: (j) => gpuHours(j) * (1 - (j.gpuUtilAvg ?? 0) / 100),
      recommendation: 'Turn on Autopilot "cancel idle after 60 min"; idle interactive sessions are the usual cause.',
    },
    {
      key: 'under',
      label: 'Oversized GPU request (10-50% utilization)',
      test: (j) => !FAILED.has(j.state ?? '') && j.gpuUtilAvg != null && j.gpuUtilAvg >= 10 && j.gpuUtilAvg < 50 && gpuHours(j) > 0,
      waste: (j) => gpuHours(j) * (1 - (j.gpuUtilAvg ?? 0) / 100),
      recommendation: 'Request fewer GPUs or a smaller type (A30 / L40S); raise --cpus-per-task for dataloader-bound jobs.',
    },
    {
      key: 'oom',
      label: 'Out-of-memory crashes',
      test: (j) => j.state === 'OUT_OF_MEMORY',
      waste: gpuHours,
      recommendation: 'Plan on 80 GB GPUs or enable gradient checkpointing; the planner sizes memory from model parameters.',
    },
    {
      key: 'timeout',
      label: 'Hit walltime without finishing',
      test: (j) => j.state === 'TIMEOUT',
      waste: gpuHours,
      recommendation: 'Checkpoint every 30 min with --signal=B:USR1@600 --requeue so time-outs resume instead of restarting.',
    },
    {
      key: 'failed',
      label: 'Failed runs',
      test: (j) => j.state === 'FAILED' || j.state === 'PREEMPTED',
      waste: gpuHours,
      recommendation: 'Smoke-test on gpu-debug (30 min) before multi-GPU submissions.',
    },
  ];
  return defs
    .map((d) => {
      const hits = jobs.filter(d.test);
      const wasted = hits.reduce((s, j) => s + d.waste(j), 0);
      return {
        key: d.key,
        label: d.label,
        jobs: hits.length,
        wastedGpuHours: wasted,
        wastedUsd: hits.reduce((s, j) => s + d.waste(j) * usdPerGpuHour(j), 0),
        recommendation: d.recommendation,
      };
    })
    .filter((p) => p.jobs > 0)
    .sort((a, b) => b.wastedGpuHours - a.wastedGpuHours);
}

export interface GroupStats {
  key: string;
  label: string;
  jobs: number;
  gpuHours: number;
  wastedGpuHours: number;
  avgUtil: number | null;
  successRate: number;
  costUsd: number;
}

export function groupStats(jobs: Job[], keyOf: (j: Job) => string, labelOf: (j: Job) => string = keyOf): GroupStats[] {
  const by = new Map<string, Job[]>();
  jobs.forEach((j) => {
    const k = keyOf(j);
    by.set(k, [...(by.get(k) ?? []), j]);
  });
  return [...by.entries()]
    .map(([key, js]) => {
      const gh = js.reduce((s, j) => s + gpuHours(j), 0);
      const utilW = js.filter((j) => j.gpuUtilAvg != null && gpuHours(j) > 0);
      const utilGh = utilW.reduce((s, j) => s + gpuHours(j), 0);
      return {
        key,
        label: labelOf(js[0]),
        jobs: js.length,
        gpuHours: gh,
        wastedGpuHours: js.reduce((s, j) => s + wastedGpuHours(j), 0),
        avgUtil: utilGh ? utilW.reduce((s, j) => s + (j.gpuUtilAvg ?? 0) * gpuHours(j), 0) / utilGh : null,
        successRate: js.filter((j) => j.state === 'COMPLETED').length / js.length,
        costUsd: js.reduce((s, j) => s + (j.costUsd ?? 0), 0),
      };
    })
    .sort((a, b) => b.gpuHours - a.gpuHours);
}

/** Bucket counts for a 0-100 value in `size`-wide bins. */
export function histogram(values: number[], size = 10): { label: string; lo: number; count: number }[] {
  const bins = Array.from({ length: Math.ceil(100 / size) }, (_, i) => ({ label: `${i * size}-${(i + 1) * size}%`, lo: i * size, count: 0 }));
  values.forEach((v) => {
    const i = Math.min(bins.length - 1, Math.max(0, Math.floor(v / size)));
    bins[i].count += 1;
  });
  return bins;
}

/** ISO week start (Monday) for weekly rollups. */
export const weekStart = (iso: string): string => {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
};
