/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import type { Tone } from '@/components/app';
import type { ActionType, AlertType, WorkloadType } from './types';

export const WORKLOAD_LABEL: Record<WorkloadType, string> = {
  TRAINING: 'Training',
  FINETUNE: 'Fine-tune',
  INFERENCE: 'Inference',
  SIMULATION: 'Simulation',
  DATA_PROCESSING: 'Data processing',
  INTERACTIVE: 'Interactive',
};

export const ALERT_TYPE_LABEL: Record<AlertType, string> = {
  IDLE_GPU: 'Idle GPU',
  LOW_GPU_UTIL: 'Low GPU utilization',
  OOM_RISK: 'Out-of-memory risk',
  WALLTIME_RISK: 'Walltime risk',
  BUDGET_BURN: 'Budget burn',
  HUNG_JOB: 'Hung job',
  NODE_FAILURE: 'Node failure',
  PREEMPTION_RISK: 'Preemption risk',
  STALE_CHECKPOINT: 'Stale checkpoint',
};

export const ACTION_LABEL: Record<ActionType, string> = {
  SUBMIT: 'Submit',
  CANCEL: 'Cancel job',
  EXTEND_WALLTIME: 'Extend walltime',
  REQUEUE_STANDBY: 'Requeue to standby',
  CHECKPOINT_NOW: 'Checkpoint now',
  SCALE_DOWN: 'Scale down GPUs',
  NOTIFY_PI: 'Notify PI',
  HOLD: 'Hold',
};

/** `AUTO_RESOLVED` → `Auto resolved`. */
export const titleCase = (v: string): string => v.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `$1,234` (cents only under $100). */
export const formatUsd = (v?: number | null): string => (v == null ? '—' : Math.abs(v) < 100 ? usd2.format(v) : usd0.format(v));

export const formatInt = (v?: number | null): string => (v == null ? '—' : int.format(v));

/** 0-100 scale → `72%`. */
export const formatPct100 = (v?: number | null): string => (v == null ? '—' : `${Math.round(v)}%`);

/** Hours → `3h 20m`, `2d 4h`, `45m`. */
export const formatDuration = (hours?: number | null): string => {
  if (hours == null || Number.isNaN(hours)) return '—';
  const h = Math.max(0, hours);
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) {
    const mins = Math.round(h * 60);
    const whole = Math.floor(mins / 60);
    const m = mins - whole * 60;
    return m ? `${whole}h ${m}m` : `${whole}h`;
  }
  const totalH = Math.round(h);
  const d = Math.floor(totalH / 24);
  const rem = totalH - d * 24;
  return rem ? `${d}d ${rem}h` : `${d}d`;
};

/** Countdown text and urgency for a deadline. */
export const countdown = (iso?: string | null, now = Date.now()): { text: string; tone: Tone; days: number } => {
  if (!iso) return { text: '—', tone: 'neutral', days: Infinity };
  const ms = new Date(iso).getTime() - now;
  const days = ms / 86400000;
  if (ms <= 0) return { text: 'Passed', tone: 'neutral', days };
  const text = days >= 2 ? `${Math.floor(days)}d ${Math.floor((days % 1) * 24)}h` : formatDuration(ms / 3600000);
  return { text, tone: days < 7 ? 'bad' : days < 21 ? 'warn' : 'neutral', days };
};

/** `5 min ago`, `3 h ago`, `Nov 12`. */
export const formatRelative = (iso?: string | null, now = Date.now()): string => {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export const formatClock = (iso?: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
};

/** Walltime remaining for a live job, hours. */
export const walltimeLeft = (job: { timelimitHours?: number; elapsedHours?: number }): number | null =>
  job.timelimitHours == null ? null : Math.max(0, job.timelimitHours - (job.elapsedHours ?? 0));

/** `Gautschi · ai · normal` for a job (Slurm partition name, not the long display name). */
export const whereLabel = (j: { cluster?: { id: string; name?: string }; partition?: { id: string; name?: string; slurmPartition?: string }; qos?: string }): string =>
  [j.cluster?.name ?? j.cluster?.id, j.partition?.slurmPartition ?? j.partition?.name ?? j.partition?.id, j.qos].filter(Boolean).join(' · ');

/** Clock time for today, `Nov 19` otherwise (activity timelines). */
export const formatShortDateTime = (iso?: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toDateString() === new Date().toDateString() ? formatClock(iso) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
