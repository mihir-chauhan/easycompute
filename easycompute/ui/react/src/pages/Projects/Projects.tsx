/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

/*
 * Projects: live compute consumption per active project of the current lab.
 * Data: RunMonitor.liveSnapshot(labId) + live Job rows (project refs) every 7 s; Project rows, the lab's jobs of the
 * last 7 days and recent GPU-util samples every 60 s. Everything per project is aggregated client-side.
 * Privacy: project descriptions, deadline labels, workload types, job names and users render only for
 * UNIVERSITY_ADMIN (and are not even requested otherwise, except what liveSnapshot always returns).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, Clock, FolderKanban, Lock } from 'lucide-react';

import { c3Call } from '@/c3Action';
import {
  EmptyState,
  ErrorState,
  KpiRow,
  KpiRowSkeleton,
  KpiTile,
  LiveIndicator,
  LiveNumber,
  Note,
  PageFrame,
  Pill,
  ProgressBar,
  SectionCard,
  Sparkline,
  TableSkeleton,
  TONE_TEXT,
  useAccrual,
  useAppShell,
  useC3Data,
  useLivePoll,
  useNow,
  useStreamingSeries,
  utilTone,
  DEFAULT_LAB_ID,
  type SeriesPoint,
  type Tone,
} from '@/components/app';
import { liveSnapshot } from '@/features/lab/api';
import { JobStateBadge } from '@/features/lab/components';
import { countdown, formatPct100, formatUsd, WORKLOAD_LABEL } from '@/features/lab/format';
import type { FetchResult, JobState, LiveSnapshot, Project, SnapJob, WorkloadType } from '@/features/lab/types';
import { filterLiteral } from '@/lib/format';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ data ------------------------------------------------------------------ */

const LIVE_MS = 7000;
const SLOW_MS = 60000;
const DAY_MS = 86400000;
const NO_PROJECT = '__none';
/** A running job under this GPU utilization (or with an idle/low-util/hung alert) counts as underusing its GPUs. */
const IDLE_UTIL = 20;
const IDLE_ALERTS = new Set(['IDLE_GPU', 'LOW_GPU_UTIL', 'HUNG_JOB']);

interface JobRow {
  id: string;
  project?: { id: string };
  state?: JobState;
  allocGpus?: number;
  allocCpus?: number;
  gpuType?: { id: string };
  startTime?: string;
  endTime?: string;
  submitTime?: string;
  elapsedHours?: number;
  costUsd?: number;
  jobName?: string;
  user?: string;
  cluster?: { id: string };
}

interface MetricRow {
  job?: { id: string };
  ts: string;
  gpuUtilPct?: number;
}

async function fetchObjs<T>(type: string, spec: Record<string, unknown>): Promise<T[]> {
  const res = (await c3Call(type, 'fetch', null, [{ offset: 0, ...spec }])) as FetchResult<T> | null;
  return res?.objs ?? [];
}

const labFilter = (labId: string) => `lab.id == ${filterLiteral(labId)}`;
const jobInclude = (admin: boolean) =>
  `id, project.id, state, allocGpus, allocCpus, gpuType.id, cluster.id, startTime, endTime, submitTime, elapsedHours, costUsd${admin ? ', jobName, user' : ''}`;

/** Every 60 s: projects, the lab's jobs that ran in the last 7 days, recent GPU-util samples of live jobs. */
async function loadSlow(labId: string, admin: boolean) {
  const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const [projects, jobs, metrics] = await Promise.all([
    fetchObjs<Project>('Project', {
      include: `id, name, deadline, priority${admin ? ', description, deadlineLabel, workloadType' : ''}`,
      filter: labFilter(labId),
      order: 'ascending(priority)',
      limit: 100,
    }),
    fetchObjs<JobRow>('Job', {
      include: jobInclude(admin),
      filter: `${labFilter(labId)} && (endTime >= dateTime(${filterLiteral(since)}) || !exists(endTime))`,
      order: 'descending(submitTime)',
      limit: 2000,
    }),
    fetchObjs<MetricRow>('JobMetric', {
      include: 'job.id, ts, gpuUtilPct',
      filter: `job.${labFilter(labId)} && job.isLive == true && ts >= dateTime(${filterLiteral(new Date(Date.now() - 15 * 60000).toISOString())})`,
      order: 'descending(ts)',
      limit: 1500,
    }),
  ]);
  return { projects, jobs, metrics };
}

/** Every 7 s: live snapshot + the live Job rows (the snapshot has no project reference). */
async function loadLive(labId: string, admin: boolean) {
  const [snap, liveJobs] = await Promise.all([
    liveSnapshot(labId),
    fetchObjs<JobRow>('Job', { include: jobInclude(admin), filter: `${labFilter(labId)} && isLive == true`, limit: 200 }),
  ]);
  return { snap, liveJobs };
}

/* --------------------------------------------------------------- aggregation --------------------------------------------------------------- */

/** One job with the freshest numbers (snapshot over Job row). */
interface J {
  id: string;
  projectId: string;
  state?: JobState;
  gpus: number;
  cpus: number;
  gpuTypeId?: string;
  clusterId?: string;
  start: number | null;
  end: number | null;
  elapsedHours: number;
  costUsd: number;
  /** elapsedHours gained per real second while running. */
  pps: number;
  util: number | null;
  idle: boolean;
  jobName?: string;
  user?: string;
}

interface Agg {
  id: string;
  project: Project | null;
  jobs: J[];
  running: J[];
  queued: J[];
  gpus: number;
  cpus: number;
  gpusByType: [string, number][];
  utilNow: number | null;
  gpuH24: number;
  gpuH7d: number;
  gpuHToday: number;
  cost7d: number;
  /** Per real second, while running. */
  gpuHRate: number;
  costRate: number;
  /** USD per job-hour of the running jobs. */
  burnPerHour: number;
  idleJobs: number;
  share: number;
  active: boolean;
}

const ms = (iso?: string | null) => (iso ? new Date(iso).getTime() : null);

function toJ(row: JobRow, s: SnapJob | undefined): J {
  const state = s?.state ?? row.state;
  const gpus = s?.gpus ?? row.allocGpus ?? 0;
  const util = s?.latest?.gpuUtilPct ?? null;
  const elapsedHours = s?.elapsedHours ?? row.elapsedHours ?? 0;
  const alerts = (s?.alerts ?? []).filter((a) => a.status === 'OPEN' || a.status === 'ACKED');
  const running = state === 'RUNNING';
  return {
    id: row.id,
    projectId: row.project?.id ?? NO_PROJECT,
    state,
    gpus,
    cpus: row.allocCpus ?? 0,
    gpuTypeId: s?.gpuTypeId ?? row.gpuType?.id,
    clusterId: s?.clusterId ?? row.cluster?.id,
    start: ms(s?.startTime ?? row.startTime),
    end: ms(s?.endTime ?? row.endTime),
    elapsedHours,
    costUsd: s?.costUsd ?? row.costUsd ?? 0,
    pps: running ? (s?.progressPerRealSec ?? 1 / 3600) : 0,
    util,
    idle: running && gpus > 0 && ((util != null && util < IDLE_UTIL && elapsedHours > 0.25) || alerts.some((a) => IDLE_ALERTS.has(a.alertType))),
    jobName: row.jobName ?? s?.jobName,
    user: row.user ?? s?.user,
  };
}

/** Share of a job's total (GPU-hours or cost) that fell inside [from, now], prorated over its wall-clock run. */
function inWindow(j: J, total: number, from: number, now: number): number {
  if (j.start == null || !total) return 0;
  const end = j.end ?? now;
  if (end <= from) return 0;
  const span = end - j.start;
  if (span <= 0 || j.start >= from) return total;
  return (total * (end - Math.max(from, j.start))) / span;
}

function aggregate(projects: Project[], jobs: J[], at: number): Agg[] {
  const midnight = new Date(at).setHours(0, 0, 0, 0);
  const byProject = new Map<string, J[]>();
  jobs.forEach((j) => byProject.set(j.projectId, [...(byProject.get(j.projectId) ?? []), j]));
  const ids = [...projects.map((p) => p.id), ...(byProject.has(NO_PROJECT) ? [NO_PROJECT] : [])];
  const rows = ids.map((id): Agg => {
    const project = projects.find((p) => p.id === id) ?? null;
    const js = byProject.get(id) ?? [];
    const running = js.filter((j) => j.state === 'RUNNING');
    const queued = js.filter((j) => j.state === 'PENDING');
    const types = new Map<string, number>();
    running.forEach((j) => j.gpus && types.set(j.gpuTypeId ?? 'GPU', (types.get(j.gpuTypeId ?? 'GPU') ?? 0) + j.gpus));
    const gpus = running.reduce((a, j) => a + j.gpus, 0);
    const utilJobs = running.filter((j) => j.util != null && j.gpus > 0);
    const utilGpus = utilJobs.reduce((a, j) => a + j.gpus, 0);
    const sum = (f: (j: J) => number) => js.reduce((a, j) => a + f(j), 0);
    const gpuH7d = sum((j) => inWindow(j, j.gpus * j.elapsedHours, at - 7 * DAY_MS, at));
    const deadline = ms(project?.deadline);
    return {
      id,
      project,
      jobs: js,
      running,
      queued,
      gpus,
      cpus: running.reduce((a, j) => a + j.cpus, 0),
      gpusByType: [...types.entries()].sort((a, b) => b[1] - a[1]),
      utilNow: utilGpus ? utilJobs.reduce((a, j) => a + (j.util ?? 0) * j.gpus, 0) / utilGpus : null,
      gpuH24: sum((j) => inWindow(j, j.gpus * j.elapsedHours, at - DAY_MS, at)),
      gpuH7d,
      gpuHToday: sum((j) => inWindow(j, j.gpus * j.elapsedHours, midnight, at)),
      cost7d: sum((j) => inWindow(j, j.costUsd, at - 7 * DAY_MS, at)),
      gpuHRate: running.reduce((a, j) => a + j.gpus * j.pps, 0),
      costRate: running.reduce((a, j) => a + (j.elapsedHours > 0 ? (j.costUsd / j.elapsedHours) * j.pps : 0), 0),
      burnPerHour: running.reduce((a, j) => a + (j.elapsedHours > 0 ? j.costUsd / j.elapsedHours : 0), 0),
      idleJobs: running.filter((j) => j.idle).length,
      share: 0,
      active: running.length > 0 || queued.length > 0 || gpuH7d > 0 || js.length > 0 || (deadline != null && deadline > at && deadline - at < 30 * DAY_MS),
    };
  });
  const labGpuH = rows.reduce((a, r) => a + r.gpuH7d, 0);
  rows.forEach((r) => (r.share = labGpuH ? r.gpuH7d / labGpuH : 0));
  return rows.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      Number(a.id === NO_PROJECT) - Number(b.id === NO_PROJECT) ||
      b.gpus - a.gpus ||
      (a.project?.priority ?? 9) - (b.project?.priority ?? 9) ||
      b.gpuH7d - a.gpuH7d,
  );
}

/* ------------------------------------------------------------------ format ------------------------------------------------------------------ */

const fmtGpuH = (v: number) => (v < 100 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));
const shortGpu = (id: string) => id.replace(/-\d+GB$/i, '');
const PRIORITY: Record<number, { label: string; tone: Tone }> = {
  1: { label: 'P1 · High', tone: 'warn' },
  2: { label: 'P2 · Medium', tone: 'info' },
  3: { label: 'P3 · Low', tone: 'neutral' },
};
const fg3 = 'text-[var(--ec-fg-3)]';
const fg2 = 'text-[var(--ec-fg-2)]';
const GRID = 'lg:grid-cols-[minmax(210px,1.7fr)_minmax(110px,1fr)_minmax(90px,0.8fr)_minmax(150px,1.3fr)_minmax(100px,0.9fr)_minmax(110px,1fr)_minmax(90px,0.8fr)_28px]';

/* ---------------------------------------------------------------- utilization ---------------------------------------------------------------- */

/** GPU-weighted utilization of a project's jobs in 20 s buckets (server samples only). */
function projectSeries(jobs: J[], samples: Record<string, SeriesPoint[]>): SeriesPoint[] {
  const buckets = new Map<number, { w: number; v: number }>();
  jobs.forEach((j) => {
    if (!j.gpus) return;
    (samples[j.id] ?? []).forEach((p) => {
      if (p.v == null) return;
      const b = Math.floor(p.t / 20000) * 20000;
      const cur = buckets.get(b) ?? { w: 0, v: 0 };
      buckets.set(b, { w: cur.w + j.gpus, v: cur.v + p.v * j.gpus });
    });
  });
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, x]) => ({ t, v: x.v / x.w }));
}

/** Streaming sparkline: server samples + seeded tail, resampled onto a fixed 10-minute grid ending now. */
function UtilSpark({ seed, server, tone }: { seed: string; server: SeriesPoint[]; tone: Tone }) {
  const series = useStreamingSeries(server, { seed, stepMs: 2000, jitter: 2, min: 0, max: 100 });
  const now = useNow(2000);
  const values = useMemo(() => {
    const out: (number | null)[] = [];
    let k = 0;
    let last: number | null = null;
    for (let t = now - 600000; t <= now; t += 10000) {
      while (k < series.length && series[k].t <= t) last = series[k++].v;
      out.push(last);
    }
    return out;
  }, [series, now]);
  return <Sparkline values={values} tone={tone} domain={[0, 100]} className="h-6 w-full min-w-[64px]" ariaLabel="GPU utilization, last 10 minutes" />;
}

/* -------------------------------------------------------------------- row -------------------------------------------------------------------- */

function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <span className={cn('text-[11px] lg:hidden', fg3)}>{label}</span>
      {children}
    </div>
  );
}

interface RowProps {
  a: Agg;
  admin: boolean;
  open: boolean;
  onToggle: () => void;
  updatedAt: number | null;
  samples: Record<string, SeriesPoint[]>;
  now: number;
}

function ProjectRow({ a, admin, open, onToggle, updatedAt, samples, now }: RowProps) {
  const navigate = useNavigate();
  const p = a.project;
  const name = p?.name ?? 'Runs without a project';
  const gpuH24 = useAccrual(a.gpuH24, a.gpuHRate, updatedAt);
  const gpuH7d = useAccrual(a.gpuH7d, a.gpuHRate, updatedAt);
  const cost = useAccrual(a.cost7d, a.costRate, updatedAt);
  const server = useMemo(() => projectSeries(a.running, samples), [a.running, samples]);
  const dl = p?.deadline ? countdown(p.deadline, now) : null;
  const prio = p?.priority != null ? PRIORITY[p.priority] : null;
  const canExpand = admin && Boolean(p);
  const detailsId = `project-details-${a.id}`;

  return (
    <li className="border-b border-[var(--ec-line)] last:border-b-0">
      <div
        className={cn('grid cursor-pointer grid-cols-2 gap-x-4 gap-y-3 px-4 py-3.5 transition-colors hover:bg-[var(--ec-card-2)] sm:grid-cols-3 lg:items-center lg:gap-y-0', GRID, !a.active && 'opacity-70')}
        onClick={() => navigate('/runs')}
      >
        <div className="col-span-full flex min-w-0 flex-col gap-1.5 lg:col-span-1">
          <Link to="/runs" onClick={(e) => e.stopPropagation()} className={cn('truncate font-medium text-[var(--ec-fg-hi)] hover:underline', !p && 'italic text-[var(--ec-fg-2)]')} title={name}>
            {name}
          </Link>
          <div className="flex flex-wrap items-center gap-1.5">
            {prio && <Pill tone={prio.tone}>{prio.label}</Pill>}
            {dl && (
              <Pill tone={dl.tone} title={p?.deadline ? `Deadline ${new Date(p.deadline).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : undefined}>
                <Clock className="size-3" aria-hidden />
                {dl.text === 'Passed' ? 'Deadline passed' : `${dl.text} to deadline`}
              </Pill>
            )}
            {a.idleJobs > 0 && (
              <Pill tone="bad" dot title={`${a.idleJobs} of ${a.running.length} running job${a.running.length === 1 ? '' : 's'} under ${IDLE_UTIL}% GPU utilization or flagged idle`}>
                {`Idle GPUs · ${a.idleJobs} job${a.idleJobs === 1 ? '' : 's'}`}
              </Pill>
            )}
          </div>
        </div>

        <Cell label="GPUs in use">
          <span className="text-[15px] font-medium tabular-nums text-[var(--ec-fg-hi)]">{a.gpus || <span className={fg3}>0</span>}</span>
          <span className={cn('truncate font-mono text-[11.5px]', fg2)} title={a.gpusByType.map(([t, n]) => `${n} × ${t}`).join(', ')}>
            {a.gpusByType.length ? a.gpusByType.map(([t, n]) => `${n}× ${shortGpu(t)}`).join(' · ') : '—'}
          </span>
          <span className={cn('text-[11.5px] tabular-nums', fg3)}>{`${a.cpus.toLocaleString('en-US')} CPU cores`}</span>
        </Cell>

        <Cell label="Jobs">
          <span className="flex items-center gap-1.5 tabular-nums">
            <span aria-hidden className={cn('size-1.5 rounded-full', a.running.length ? 'ec-pulse bg-[var(--ec-accent-hi)]' : 'bg-[var(--ec-fg-3)]')} />
            {`${a.running.length} running`}
          </span>
          <span className={cn('tabular-nums', a.queued.length ? 'text-[var(--ec-blue)]' : fg3)}>{`${a.queued.length} queued`}</span>
        </Cell>

        <Cell label="GPU utilization (10 min)" className="col-span-2 sm:col-span-1">
          {a.running.length && a.gpus ? (
            <div className="flex items-center gap-2.5">
              <div className="min-w-0 flex-1">
                <UtilSpark seed={a.id} server={server} tone={utilTone(a.utilNow)} />
              </div>
              <span className={cn('w-10 text-right text-[15px] font-medium tabular-nums', TONE_TEXT[utilTone(a.utilNow)])}>
                <LiveNumber value={a.utilNow} format={(v) => `${Math.round(v)}%`} />
              </span>
            </div>
          ) : (
            <span className={fg3}>No GPUs running</span>
          )}
        </Cell>

        <Cell label="GPU-hours">
          <span className="text-[15px] font-medium text-[var(--ec-fg-hi)]">
            <LiveNumber value={gpuH24} format={fmtGpuH} />
            <span className={cn('ml-1 text-[11.5px] font-normal', fg3)}>24 h</span>
          </span>
          <span className={cn('text-[11.5px]', fg2)}>
            <LiveNumber value={gpuH7d} format={fmtGpuH} />
            {' · 7 d'}
          </span>
        </Cell>

        <Cell label="Cost (7 d)">
          <span className="text-[15px] font-medium text-[var(--ec-fg-hi)]">
            <LiveNumber value={cost} format={(v) => formatUsd(v)} />
          </span>
          <span className={cn('text-[11.5px] tabular-nums', a.burnPerHour ? 'text-[var(--ec-accent-text,var(--ec-fg-2))]' : fg3)}>
            {a.burnPerHour ? `burning ${formatUsd(a.burnPerHour)}/h` : 'not burning'}
          </span>
        </Cell>

        <Cell label="Share of lab (7 d)">
          <span className="text-[13px] tabular-nums text-[var(--ec-fg)]">{formatPct100(a.share * 100)}</span>
          <ProgressBar value={a.share} tone={a.share >= 0.5 ? 'warn' : 'good'} ariaLabel={`${name}: share of lab GPU-hours, last 7 days`} className="max-w-[120px]" />
        </Cell>

        <div className="col-span-full flex justify-end lg:col-span-1">
          {canExpand ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={`${open ? 'Hide' : 'Show'} project details for ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="grid size-7 place-items-center rounded-md text-[var(--ec-fg-2)] hover:bg-[var(--ec-card)] hover:text-[var(--ec-fg-hi)]"
            >
              <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
            </button>
          ) : null}
        </div>
      </div>
      {canExpand && open && p ? <ProjectDetails id={detailsId} p={p} a={a} /> : null}
    </li>
  );
}

/** Admin mode only: what the project is about and which jobs are running for it. */
function ProjectDetails({ id, p, a }: { id: string; p: Project; a: Agg }) {
  const live = [...a.running, ...a.queued];
  const ended = a.jobs.filter((j) => j.state !== 'RUNNING' && j.state !== 'PENDING');
  const failed = ended.filter((j) => j.state && ['FAILED', 'TIMEOUT', 'OUT_OF_MEMORY', 'CANCELLED', 'PREEMPTED'].includes(j.state)).length;
  return (
    <div id={id} className="grid gap-4 border-t border-[var(--ec-line)] bg-[var(--ec-card-2)] px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <div className="flex min-w-0 flex-col gap-2 text-[13px]">
        <span className={cn('text-[11px] font-medium tracking-wide uppercase', fg3)}>Research</span>
        <p className="m-0 text-[var(--ec-fg)]">{p.description || 'No description on file.'}</p>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]">
          <dt className={fg3}>Deadline</dt>
          <dd className="m-0 text-[var(--ec-fg)]">
            {p.deadline ? `${p.deadlineLabel ? `${p.deadlineLabel} · ` : ''}${new Date(p.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : '—'}
          </dd>
          <dt className={fg3}>Workload</dt>
          <dd className="m-0 text-[var(--ec-fg)]">{p.workloadType ? WORKLOAD_LABEL[p.workloadType as WorkloadType] : '—'}</dd>
          <dt className={fg3}>Last 7 days</dt>
          <dd className="m-0 text-[var(--ec-fg)]">{`${ended.length} finished job${ended.length === 1 ? '' : 's'}${failed ? `, ${failed} failed or cancelled` : ''}`}</dd>
          <dt className={fg3}>Project id</dt>
          <dd className="m-0 font-mono text-[var(--ec-fg-2)]">{p.id}</dd>
        </dl>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <span className={cn('text-[11px] font-medium tracking-wide uppercase', fg3)}>{`Live jobs (${live.length})`}</span>
        {live.length ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-[var(--ec-line)] rounded-lg border border-[var(--ec-line)] p-0">
            {live.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12.5px]">
                <Link to={`/runs/${encodeURIComponent(j.id)}`} className="min-w-0 flex-1 truncate font-mono text-[var(--ec-fg-hi)] hover:underline" title={j.jobName ?? j.id}>
                  {j.jobName ?? j.id}
                </Link>
                <span className={fg2}>{j.user ?? '—'}</span>
                <span className={cn('font-mono', fg2)}>{`${j.clusterId ?? ''} · ${j.gpus ? `${j.gpus}× ${shortGpu(j.gpuTypeId ?? 'GPU')}` : `${j.cpus} cores`}`}</span>
                <span className={cn('w-10 text-right tabular-nums', j.util == null ? fg3 : TONE_TEXT[utilTone(j.util)])}>{j.state === 'RUNNING' ? formatPct100(j.util) : ''}</span>
                <JobStateBadge value={j.state} />
              </li>
            ))}
          </ul>
        ) : (
          <p className={cn('m-0 text-[13px]', fg3)}>No live jobs right now.</p>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- page -------------------------------------------------------------------- */

export default function Projects() {
  const shell = useAppShell();
  const labId = shell.labId ?? DEFAULT_LAB_ID;
  const admin = shell.role === 'UNIVERSITY_ADMIN';
  const now = useNow(30000);
  const [openId, setOpenId] = useState<string | null>(null);

  const slow = useC3Data(() => loadSlow(labId, admin), [labId, admin], SLOW_MS);
  const live = useLivePoll(() => loadLive(labId, admin), [labId, admin], { intervalMs: LIVE_MS });
  const snap: LiveSnapshot | null = live.data?.snap ?? null;

  // GPU-util samples per job: fetched history + every polled `latest` (so sparklines grow between slow reloads).
  const [polled, setPolled] = useState<Record<string, SeriesPoint[]>>({});
  useEffect(() => setPolled({}), [labId]);
  useEffect(() => {
    if (!snap?.jobs) return;
    setPolled((prev) => {
      const next = { ...prev };
      snap.jobs?.forEach((j) => {
        const t = ms(j.latest?.ts);
        if (t == null || j.latest?.gpuUtilPct == null) return;
        const arr = next[j.id] ?? [];
        if (!arr.length || arr[arr.length - 1].t < t) next[j.id] = [...arr.filter((p) => p.t > Date.now() - 15 * 60000), { t, v: j.latest.gpuUtilPct }];
      });
      return next;
    });
  }, [snap]);
  const samples = useMemo(() => {
    const by: Record<string, SeriesPoint[]> = {};
    (slow.data?.metrics ?? []).forEach((m) => {
      const id = m.job?.id;
      if (id && m.gpuUtilPct != null) (by[id] ??= []).push({ t: new Date(m.ts).getTime(), v: m.gpuUtilPct });
    });
    Object.entries(polled).forEach(([id, pts]) => (by[id] = [...(by[id] ?? []), ...pts]));
    Object.values(by).forEach((arr) => arr.sort((a, b) => a.t - b.t));
    return by;
  }, [slow.data, polled]);

  const rows = useMemo(() => {
    if (!slow.data) return null;
    const snapById = new Map((snap?.jobs ?? []).map((j) => [j.id, j]));
    const all = new Map<string, JobRow>();
    slow.data.jobs.forEach((j) => all.set(j.id, j));
    (live.data?.liveJobs ?? []).forEach((j) => all.set(j.id, { ...all.get(j.id), ...j }));
    const jobs = [...all.values()].map((j) => toJ(j, snapById.get(j.id)));
    return aggregate(slow.data.projects, jobs, live.updatedAt ?? Date.now());
  }, [slow.data, live.data, live.updatedAt, snap]);

  const activeRows = rows?.filter((r) => r.active) ?? [];
  const quiet = rows?.filter((r) => !r.active && r.project) ?? [];
  const projectRows = activeRows.filter((r) => r.project);

  // Lab totals (ticking between polls).
  const totals = useMemo(() => {
    const rs = rows ?? [];
    const sum = (f: (r: Agg) => number) => rs.reduce((x, r) => x + f(r), 0);
    const types = new Map<string, number>();
    rs.forEach((r) => r.gpusByType.forEach(([t, n]) => types.set(t, (types.get(t) ?? 0) + n)));
    return {
      gpus: sum((r) => r.gpus),
      types: [...types.entries()].sort((a, b) => b[1] - a[1]),
      gpuHToday: sum((r) => r.gpuHToday),
      gpuH7d: sum((r) => r.gpuH7d),
      gpuHRate: sum((r) => r.gpuHRate),
      burn: sum((r) => r.burnPerHour),
      costRate: sum((r) => r.costRate),
      cost7d: sum((r) => r.cost7d),
      running: sum((r) => r.running.length),
      idle: sum((r) => r.idleJobs),
    };
  }, [rows]);
  const gpuHToday = useAccrual(totals.gpuHToday, totals.gpuHRate, live.updatedAt);
  const cost7d = useAccrual(totals.cost7d, totals.costRate, live.updatedAt);
  const queued = snap?.counts?.pending ?? rows?.reduce((x, r) => x + r.queued.length, 0) ?? null;
  const soon = projectRows.filter((r) => {
    const d = ms(r.project?.deadline);
    return d != null && d > now && d - now < 30 * DAY_MS;
  }).length;

  const error = slow.error ?? (live.data ? null : live.error);
  const loading = (slow.loading && !slow.data) || (live.loading && !live.data);
  const labName = shell.lab?.name ?? labId;

  return (
    <PageFrame
      title="Projects"
      description={
        <span>
          {'Live compute use by project in '}
          <b className="font-semibold text-[var(--ec-fg-hi)]">{labName}</b>
          {'. GPUs, utilization, GPU-hours and spend update every few seconds.'}
        </span>
      }
      actions={<LiveIndicator updatedAt={live.updatedAt} live={live.live} />}
    >
      {error && <ErrorState message={`Could not load projects: ${error}`} onRetry={() => (slow.reload(), live.reload())} />}

      {loading || !rows ? (
        <KpiRowSkeleton count={5} />
      ) : (
        <KpiRow className="xl:grid-cols-5">
          <KpiTile label="Active projects" value={<LiveNumber value={projectRows.length} />} caption={`of ${rows.filter((r) => r.project).length} · ${soon} with a deadline in 30 d`} />
          <KpiTile
            label="GPUs in use now"
            value={<LiveNumber value={totals.gpus} />}
            caption={totals.types.length ? totals.types.map(([t, n]) => `${n}× ${shortGpu(t)}`).join(' · ') : 'Nothing running'}
            tone={totals.idle ? 'warn' : undefined}
            help={totals.idle ? `${totals.idle} running job${totals.idle === 1 ? ' is' : 's are'} underusing GPUs` : undefined}
          />
          <KpiTile label="GPU-hours today" value={<LiveNumber value={gpuHToday} format={fmtGpuH} />} caption={`${fmtGpuH(totals.gpuH7d)} in the last 7 days`} />
          <KpiTile label="Spend rate" value={<LiveNumber value={totals.burn} format={(v) => `${formatUsd(v)}/h`} />} caption={<span>{'7 d spend '}<LiveNumber value={cost7d} format={(v) => formatUsd(v)} /></span>} />
          <KpiTile label="Queued jobs" value={<LiveNumber value={queued} />} caption={`${totals.running} running`} tone={queued ? 'info' : undefined} />
        </KpiRow>
      )}

      {!admin && (
        <Note tone="info" icon={<Lock />}>
          Resource consumption only. Project descriptions, deadline details and job names are shown in admin mode.
        </Note>
      )}

      <SectionCard
        flush
        title="Active projects"
        subtitle={admin ? 'Expand a project for its research summary and live jobs. Click a row to open its runs.' : 'Click a row to open the lab’s runs.'}
        actions={<span className={cn('text-xs', fg3)}>GPU-hours and cost: last 24 h / 7 d</span>}
      >
        {loading || !rows ? (
          <TableSkeleton rows={4} />
        ) : !activeRows.length ? (
          <EmptyState icon={<FolderKanban />} title="No active projects" hint="Projects appear here when they have running or queued jobs, ran in the last 7 days, or have a deadline within 30 days." />
        ) : (
          <>
            <div className={cn('hidden gap-x-4 border-b border-[var(--ec-line)] px-4 py-2 text-xs font-medium lg:grid', GRID, fg3)}>
              <span>Project</span>
              <span>GPUs in use</span>
              <span>Jobs</span>
              <span>GPU util · 10 min</span>
              <span>GPU-hours</span>
              <span>Cost (7 d)</span>
              <span>Share of lab</span>
              <span />
            </div>
            <ul className="m-0 list-none p-0">
              {activeRows.map((a) => (
                <ProjectRow key={a.id} a={a} admin={admin} open={openId === a.id} onToggle={() => setOpenId((cur) => (cur === a.id ? null : a.id))} updatedAt={live.updatedAt} samples={samples} now={now} />
              ))}
            </ul>
          </>
        )}
      </SectionCard>

      {quiet.length > 0 && (
        <p className={cn('m-0 text-[13px]', fg3)}>
          {`No activity in the last 7 days: ${quiet.map((r) => r.project?.name).join(', ')}.`}
        </p>
      )}
    </PageFrame>
  );
}
