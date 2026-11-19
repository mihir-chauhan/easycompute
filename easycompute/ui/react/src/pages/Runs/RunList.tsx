/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Rocket } from 'lucide-react';

import {
  ClearFilters,
  useAppShell,
  DataTable,
  ErrorState,
  PageFrame,
  ProgressBar,
  ResultCount,
  SearchBox,
  SectionCard,
  Segmented,
  Sparkline,
  ToneBadge,
  utilTone,
  TONE_TEXT,
  type Column,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { fetchLiveMetrics, fetchOpenAlerts, fetchRecentJobs } from '@/features/lab/api';
import { AlertTypeBadge, CliHint, JobStateBadge, Mono, muted } from '@/features/lab/components';
import { whereLabel, formatDuration, formatPct100, formatRelative, formatUsd } from '@/features/lab/format';
import type { Alert, Job, JobMetric } from '@/features/lab/types';
import { queueStatus, useTelemetry, type TelemetryJob } from '@/features/lab/telemetry';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { LIVE_POLL_MS, LiveBadge, liveJob, mergeSnap, SimNote, useLiveSnapshot, useNow, withLatest } from '@/features/lab/live';
import { useLabRole } from '@/features/lab/useLabRole';
import { useLoad } from '@/features/lab/useLoad';
import { cn } from '@/lib/utils';

type View = 'all' | 'running' | 'queued' | 'approval' | 'completed' | 'failed';
const VIEWS: View[] = ['all', 'running', 'queued', 'approval', 'completed', 'failed'];
const FAILED = ['FAILED', 'TIMEOUT', 'OUT_OF_MEMORY', 'CANCELLED', 'PREEMPTED'];

/** Running job's GPU util: streaming sparkline (last 5 min) and the current value. */
function LiveUtil({ job, server }: { job: TelemetryJob; server: JobMetric[] }) {
  const series = useTelemetry(job, server, { windowMs: 5 * 60_000, points: 30 });
  const u = [...series].reverse().find((p) => p.gpuUtilPct != null)?.gpuUtilPct ?? null;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <Sparkline values={series.map((p) => p.gpuUtilPct)} tone="accent" domain={[0, 100]} area={false} className="h-6 w-16" ariaLabel="GPU utilization, last 5 minutes" />
      <span className={cn('w-9 tabular-nums', TONE_TEXT[utilTone(u)])}>{formatPct100(u)}</span>
    </span>
  );
}

const RunList: React.FC = () => {
  const navigate = useNavigate();
  const { labId, error: labError } = useCurrentLab();
  const [params, setParams] = useSearchParams();
  const view: View = VIEWS.find((v) => v === params.get('view')) ?? 'all';
  const [q, setQ] = useState('');

  // Live list: background refresh every 30 s while the page is open.
  const data = useLoad(() => (labId ? Promise.all([fetchRecentJobs(labId), fetchOpenAlerts(labId), fetchLiveMetrics(labId)]) : null), [labId], LIVE_POLL_MS);
  const now = useNow(1000);
  const snap = useLiveSnapshot(labId);
  const [allJobs, alerts, metrics] = data.data ?? [[], [], []];
  const lr = useLabRole();
  const { clusterId } = useAppShell();
  const mineOnly = lr.isMember && Boolean(lr.user);
  const jobs = useMemo(
    () => allJobs.filter((j) => (!clusterId || j.cluster?.id === clusterId) && (!mineOnly || lr.isOwn(j.user))).map((j) => {
        const m = mergeSnap(j, snap.byJob[j.id]);
        return liveJob(m, snap.byJob[j.id] ? snap.updatedAt : data.updatedAt, now, m.progressPerRealSec);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allJobs, clusterId, mineOnly, lr.user, now, data.updatedAt, snap],
  );

  const alertsByJob = useMemo(() => {
    const by: Record<string, Alert[]> = {};
    alerts.forEach((a) => {
      if (a.job?.id) (by[a.job.id] ??= []).push(a);
    });
    return by;
  }, [alerts]);

  const utilNow = useMemo(() => {
    const by: Record<string, number> = {};
    metrics.forEach((m) => {
      if (m.job?.id && m.gpuUtilPct != null && by[m.job.id] == null) by[m.job.id] = m.gpuUtilPct;
    });
    return by;
  }, [metrics]);

  const metricsByJob = useMemo(() => {
    const by: Record<string, JobMetric[]> = {};
    metrics.forEach((m) => {
      if (m.job?.id) (by[m.job.id] ??= []).push(m);
    });
    Object.values(by).forEach((l) => l.reverse());
    return by;
  }, [metrics]);

  const needsApproval = (j: Job) => j.state === 'RUNNING' && (alertsByJob[j.id] ?? []).some((a) => a.severity === 'CRITICAL' && a.status === 'OPEN');
  const inView = (j: Job, v: View) =>
    v === 'all' ||
    (v === 'running' && j.state === 'RUNNING') ||
    (v === 'queued' && j.state === 'PENDING') ||
    (v === 'approval' && needsApproval(j)) ||
    (v === 'completed' && j.state === 'COMPLETED') ||
    (v === 'failed' && FAILED.includes(j.state ?? ''));

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return jobs
      .filter((j) => inView(j, view))
      .filter((j) => !needle || [j.jobName, j.user, j.cluster?.name, j.slurmJobId, j.project?.name, j.partition?.name].some((v) => v?.toLowerCase().includes(needle)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, view, q, alertsByJob]);

  const count = (v: View) => jobs.filter((j) => inView(j, v)).length;
  const running = count('running');
  const queued = count('queued');


  const setView = (v: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'all') next.delete('view');
        else next.set('view', v);
        return next;
      },
      { replace: true },
    );

  const status = (j: Job) => {
    if (needsApproval(j)) return <ToneBadge tone="warn">Needs approval</ToneBadge>;
    return <JobStateBadge value={j.state} />;
  };

  const progress = (j: Job) => {
    if (j.state === 'RUNNING') {
      const frac = j.timelimitHours ? (j.elapsedHours ?? 0) / j.timelimitHours : 0;
      return (
        <div className="flex w-36 flex-col gap-1">
          <ProgressBar value={frac} tone={frac > 0.9 ? 'bad' : 'good'} ariaLabel="Walltime used" />
          <span className={cn('text-xs', muted)}>{`${formatDuration(j.elapsedHours)} of ${formatDuration(j.timelimitHours)}`}</span>
        </div>
      );
    }
    if (j.state === 'PENDING') {
      const qs = queueStatus(j as Job & { queuePosition?: number | null; etaStartAt?: string | null }, now);
      if (qs.etaMs == null) return <span className={muted}>{`${qs.position != null ? `Queue #${qs.position}` : 'Waiting'} · queued ${formatRelative(j.submitTime)}`}</span>;
      return (
        <div className="flex w-36 flex-col gap-1">
          <ProgressBar value={qs.progress} tone="info" ariaLabel="Queue wait elapsed" />
          <span className={cn('text-xs tabular-nums', muted)}>{qs.label}</span>
        </div>
      );
    }
    const top = alertsByJob[j.id]?.[0];
    if (top) return <AlertTypeBadge type={top.alertType} severity={top.severity} />;
    return <span className={muted}>{formatDuration(j.elapsedHours)}</span>;
  };

  const columns: Column<Job>[] = [
    {
      key: 'run',
      header: 'Run',
      sortValue: (j) => j.jobName ?? '',
      render: (j) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-mono font-medium text-[var(--c3-style-basic-fg-primary)]" title={j.jobName}>
            {j.jobName ?? j.id}
          </span>
          <Mono className={muted}>{`${j.cluster?.id ?? ''} ${j.slurmJobId ?? ''}`}</Mono>
        </div>
      ),
    },
    { key: 'owner', header: 'Owner', hideBelow: 'md', sortValue: (j) => j.user ?? '', render: (j) => j.user ?? '—' },
    { key: 'cl', header: 'Cluster · QOS', hideBelow: 'lg', render: (j) => whereLabel(j) },
    { key: 'gpus', header: 'GPUs', align: 'right', hideBelow: 'sm', sortValue: (j) => j.allocGpus ?? 0, render: (j) => `${j.allocGpus ?? 0} × ${j.gpuType?.id?.split('-')[0] ?? 'CPU'}` },
    { key: 'st', header: 'Status', sortValue: (j) => j.state ?? '', render: status },
    { key: 'prog', header: 'Progress', hideBelow: 'md', render: progress },
    {
      key: 'util',
      header: 'GPU util',
      align: 'right',
      hideBelow: 'sm',
      sortValue: (j) => utilNow[j.id] ?? j.gpuUtilAvg ?? -1,
      render: (j) => {
        if (j.state === 'RUNNING') return <LiveUtil job={j} server={withLatest(metricsByJob[j.id] ?? [], snap.byJob[j.id]?.latest)} />;
        const u = j.gpuUtilAvg;
        return u == null ? <span className={muted}>–</span> : <span className={TONE_TEXT[utilTone(u)]}>{formatPct100(u)}</span>;
      },
    },
    { key: 'cost', header: 'Charged', align: 'right', hideBelow: 'sm', sortValue: (j) => j.costUsd ?? 0, render: (j) => formatUsd(j.costUsd) },
  ];

  const error = labError ?? data.error;

  return (
    <PageFrame
      title="Runs"
      description={
        <span>
          {'There are '}
          <b className="font-semibold text-[var(--c3-style-basic-fg-primary)]">{running}</b>
          {` run${running === 1 ? '' : 's'} live and `}
          <b className="font-semibold text-[var(--c3-style-basic-fg-primary)]">{queued}</b>
          {` queued${mineOnly ? ' of yours' : ''} on `}
          <b className="font-semibold text-[var(--c3-style-basic-fg-primary)]">{clusterId ? (allJobs.find((j) => j.cluster?.id === clusterId)?.cluster?.name ?? clusterId) : 'all clusters'}</b>.
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <LiveBadge updatedAt={snap.updatedAt ?? data.updatedAt} />
          <Button leadingIcon={<Rocket />} onClick={() => navigate('/plan')}>
            Plan a run
          </Button>
        </div>
      }
      toolbar={
        <div className="flex w-full flex-col gap-3">
          <Segmented
            label="Run status"
            value={view}
            onChange={setView}
            options={[
              { value: 'all', label: 'All', count: count('all') },
              { value: 'running', label: 'Running', count: running },
              { value: 'queued', label: 'Queued', count: queued },
              { value: 'approval', label: 'Needs approval', count: count('approval') },
              { value: 'completed', label: 'Completed', count: count('completed') },
              { value: 'failed', label: 'Failed', count: count('failed') },
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchBox label="Search runs" placeholder="Search runs, job IDs, owners" value={q} onChange={setQ} />
            {q && <ClearFilters onClick={() => setQ('')} />}
            <ResultCount>{`${rows.length} ${rows.length === 1 ? 'run' : 'runs'}`}</ResultCount>
          </div>
        </div>
      }
    >
      {error && <ErrorState message={`Could not load runs: ${error}`} onRetry={data.reload} />}

      <SectionCard flush>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(j) => j.id}
          onRowClick={(j) => navigate(`/runs/${encodeURIComponent(j.id)}`)}
          loading={data.loading && !data.data}
          pageSize={15}
          emptyLabel={q ? 'No runs match this search' : 'No runs in this view'}
          emptyHint={view === 'all' && !q ? 'Plan a run and it appears here with live GPU, memory and cost tracking.' : undefined}
          emptyAction={
            q ? (
              <ClearFilters onClick={() => setQ('')} />
            ) : (
              <Button size="sm" leadingIcon={<Rocket />} onClick={() => navigate('/plan')}>
                Plan a run
              </Button>
            )
          }
        />
      </SectionCard>
      <CliHint command={`easycompute runs list --lab ${labId ?? '<lab>'} --status running,queued --format table`} />
      <SimNote />
    </PageFrame>
  );
};

export default RunList;
