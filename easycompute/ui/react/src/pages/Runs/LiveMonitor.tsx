/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, Rocket, ShieldCheck } from 'lucide-react';

import {
  EmptyState,
  ErrorState,
  KpiRowSkeleton,
  KpiTile,
  PageFrame,
  Pill,
  ProgressBar,
  SectionCard,
  SeverityBadge,
  Skeleton,
  Sparkline,
  TONE_TEXT,
  useAppShell,
  utilTone,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { fetchLiveJobs, fetchLiveMetrics, fetchOpenAlerts } from '@/features/lab/api';
import { HeadNote, JobStateBadge, Mono, muted } from '@/features/lab/components';
import { ALERT_TYPE_LABEL, formatDuration, formatPct100, formatRelative, formatUsd, walltimeLeft } from '@/features/lab/format';
import { LIVE_POLL_MS, LiveBadge, liveJob, mergeSnap, snapToJob, useLiveSnapshot, useNow, withLatest } from '@/features/lab/live';
import { buildTelemetry, TELEMETRY_TICK_MS, type TelemetryPoint } from '@/features/lab/telemetry';
import type { Alert, JobMetric, SnapJob } from '@/features/lab/types';
import { useLoad } from '@/features/lab/useLoad';
import { cn } from '@/lib/utils';

type LiveJob = ReturnType<typeof mergeSnap>;

const SEV_RANK: Record<string, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };
const CARD_WINDOW_MS = 10 * 60_000;

const lastOf = (pts: TelemetryPoint[], k: 'gpuUtilPct' | 'gpuMemPct') => [...pts].reverse().find((p) => p[k] != null)?.[k] ?? null;

function JobCard({ job, series, alerts, onOpen }: { job: LiveJob; series: TelemetryPoint[]; alerts: Alert[]; onOpen: () => void }) {
  const running = job.state === 'RUNNING';
  const util = lastOf(series, 'gpuUtilPct');
  const mem = lastOf(series, 'gpuMemPct');
  const left = walltimeLeft(job);
  const frac = job.timelimitHours ? (job.elapsedHours ?? 0) / job.timelimitHours : 0;
  const worst = [...alerts].sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))[0];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-[var(--ec-card-radius,8px)] border bg-[var(--ec-card,transparent)] p-4 text-left transition-colors hover:border-[var(--ec-line-2)] focus-visible:outline-2 focus-visible:outline-[var(--ec-accent-hi)]',
        worst?.severity === 'CRITICAL' ? 'border-[var(--c3-style-basic-border-danger)]' : 'border-[var(--ec-line)]',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-medium text-[var(--ec-fg-hi)]" title={job.jobName}>
            {job.jobName ?? job.id}
          </div>
          <div className={cn('truncate text-xs', muted)}>
            {[job.user, job.cluster?.name ?? job.cluster?.id, `${job.allocGpus ?? 0} × ${job.gpuType?.id?.split('-')[0] ?? 'GPU'}`, job.nodeList].filter(Boolean).join(' · ')}
          </div>
        </div>
        {running ? (
          <Pill tone="accent" dot pulse>
            Running
          </Pill>
        ) : (
          <JobStateBadge value={job.state} />
        )}
      </div>

      {running ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <div className="flex items-baseline justify-between text-xs">
                <span className={muted}>GPU util</span>
                <span className={cn('font-medium tabular-nums', TONE_TEXT[utilTone(util)])}>{formatPct100(util)}</span>
              </div>
              <Sparkline values={series.map((p) => p.gpuUtilPct)} tone="accent" domain={[0, 100]} className="h-10" ariaLabel="GPU utilization, last 10 minutes" />
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline justify-between text-xs">
                <span className={muted}>GPU memory</span>
                <span className={cn('font-medium tabular-nums', mem != null && mem >= 95 ? TONE_TEXT.bad : 'text-[var(--ec-fg-hi)]')}>{formatPct100(mem)}</span>
              </div>
              <Sparkline values={series.map((p) => p.gpuMemPct)} tone="pink" domain={[0, 100]} className="h-10" ariaLabel="GPU memory, last 10 minutes" />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <ProgressBar value={frac} tone={frac > 0.9 ? 'bad' : frac > 0.75 ? 'warn' : 'good'} ariaLabel="Walltime used" />
            <div className="flex justify-between text-xs tabular-nums">
              <span className={muted}>{`${formatDuration(left)} walltime left`}</span>
              <span className="text-[var(--ec-fg-hi)]">{`${formatUsd(job.costUsd)} charged`}</span>
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className={cn('text-xs', muted)}>{`Submitted ${formatRelative(job.submitTime)} · ${formatDuration(job.timelimitHours)} limit`}</div>
        </div>
      )}

      {alerts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {alerts.slice(0, 3).map((a) => (
            <Pill key={a.id} tone={a.severity === 'CRITICAL' ? 'bad' : a.severity === 'WARNING' ? 'warn' : 'info'} dot>
              {ALERT_TYPE_LABEL[a.alertType] ?? a.alertType}
            </Pill>
          ))}
          {alerts.length > 3 && <span className={cn('text-xs', muted)}>{`+${alerts.length - 3} more`}</span>}
        </div>
      )}
    </button>
  );
}

/** Live monitor: every running job of the current lab, streaming. */
const LiveMonitor: React.FC = () => {
  const navigate = useNavigate();
  const { labId, clusterId } = useAppShell();
  const data = useLoad(() => (labId ? Promise.all([fetchLiveJobs(labId), fetchOpenAlerts(labId), fetchLiveMetrics(labId)]) : null), [labId], LIVE_POLL_MS);
  const snap = useLiveSnapshot(labId ?? null);
  const now = useNow(1000);
  const tick = useNow(TELEMETRY_TICK_MS);
  const [fetched, alerts, liveMetrics] = data.data ?? [[], [], []];

  const jobs = useMemo(() => {
    const seen = new Set(fetched.map((j) => j.id));
    const extra = (snap.snap?.jobs ?? []).filter((s: SnapJob) => !seen.has(s.id)).map(snapToJob);
    return [...fetched, ...extra]
      .map((j) => mergeSnap(j, snap.byJob[j.id]))
      .filter((j) => j.state === 'RUNNING' && (!clusterId || j.cluster?.id === clusterId));
  }, [fetched, snap, clusterId]);

  const metricsByJob = useMemo(() => {
    const by: Record<string, JobMetric[]> = {};
    liveMetrics.forEach((m) => {
      if (m.job?.id) (by[m.job.id] ??= []).push(m);
    });
    Object.keys(by).forEach((k) => by[k].reverse());
    return by;
  }, [liveMetrics]);

  const series = useMemo(() => {
    const out: Record<string, TelemetryPoint[]> = {};
    jobs.forEach((j) => {
      if (j.state === 'RUNNING') out[j.id] = buildTelemetry(j, withLatest(metricsByJob[j.id] ?? [], j.latest), tick, { windowMs: CARD_WINDOW_MS, points: 60 });
    });
    return out;
  }, [jobs, metricsByJob, tick]);

  const alertsByJob = useMemo(() => {
    const by: Record<string, Alert[]> = {};
    alerts.forEach((a) => {
      if (a.job?.id) (by[a.job.id] ??= []).push(a);
    });
    return by;
  }, [alerts]);

  const readAt = snap.updatedAt ?? data.updatedAt;
  const shown = jobs.map((j) => liveJob(j, readAt, now, j.progressPerRealSec) as LiveJob);
  const running = shown.filter((j) => j.state === 'RUNNING');
  const ordered = running.sort((a, b) => Math.min(9, ...(alertsByJob[a.id] ?? []).map((x) => SEV_RANK[x.severity] ?? 9)) - Math.min(9, ...(alertsByJob[b.id] ?? []).map((x) => SEV_RANK[x.severity] ?? 9)) || (b.allocGpus ?? 0) - (a.allocGpus ?? 0));
  const gpus = running.reduce((n, j) => n + (j.allocGpus ?? 0), 0);
  const utils = running.map((j) => lastOf(series[j.id] ?? [], 'gpuUtilPct')).filter((v): v is number => v != null);
  const avgUtil = utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : null;
  const fleetTrend = useMemo(() => {
    const lists = Object.values(series).filter((s) => s.length);
    if (!lists.length) return undefined;
    const n = Math.min(...lists.map((s) => s.length), 30);
    return Array.from({ length: n }, (_, i) => lists.reduce((a, s) => a + (s[s.length - n + i].gpuUtilPct ?? 0), 0) / lists.length);
  }, [series]);
  const openAlerts = alerts.filter((a) => a.status === 'OPEN');
  const critical = openAlerts.filter((a) => a.severity === 'CRITICAL').length;
  const burn = running.reduce((s, j) => s + (j.elapsedHours ? (j.costUsd ?? 0) / j.elapsedHours : 0), 0);
  const spent = running.reduce((s, j) => s + (j.costUsd ?? 0), 0);
  const feed = [...alerts].sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) || (b.detectedAt ?? '').localeCompare(a.detectedAt ?? ''));

  const loading = data.loading && !data.data;

  return (
    <PageFrame
      title="Live monitor"
      description="Every running job in your lab, streaming GPU, memory, walltime and cost."
      badges={<LiveBadge updatedAt={readAt} />}
      actions={
        <Button leadingIcon={<Rocket />} onClick={() => navigate('/plan')}>
          Plan a run
        </Button>
      }
    >
      {data.error && <ErrorState message={`Could not load live runs: ${data.error}`} onRetry={data.reload} />}

      {loading ? (
        <KpiRowSkeleton />
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          <KpiTile label="Running" value={running.length} tone={running.length ? 'good' : 'neutral'} caption={`${new Set(running.map((j) => j.cluster?.id)).size} clusters`} onClick={() => navigate('/runs?view=running')} />
          <KpiTile label="GPUs in use" value={gpus} caption={`across ${running.length} run${running.length === 1 ? '' : 's'}`} />
          <KpiTile label="Avg GPU util" value={formatPct100(avgUtil)} tone={avgUtil == null ? undefined : utilTone(avgUtil)} trend={fleetTrend} trendTone={utilTone(avgUtil)} caption="live, across running jobs" />
          <KpiTile label="Open alerts" value={openAlerts.length} tone={critical ? 'bad' : openAlerts.length ? 'warn' : 'good'} caption={critical ? `${critical} critical` : 'none critical'} />
          <KpiTile label="Spend rate" value={`${formatUsd(burn)}/h`} caption={`${formatUsd(spent)} charged so far`} />
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <SectionCard title="Live jobs" actions={<HeadNote>{`${running.length} running`}</HeadNote>}>
          {loading ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-40" />
              ))}
            </div>
          ) : ordered.length === 0 ? (
            <EmptyState
              icon={<Activity />}
              title="No running jobs"
              hint="Launch a run and it appears here with live GPU, memory, walltime and cost."
              action={
                <Button size="sm" leadingIcon={<Rocket />} onClick={() => navigate('/plan')}>
                  Plan a run
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {ordered.map((j) => (
                <JobCard key={j.id} job={j} series={series[j.id] ?? []} alerts={alertsByJob[j.id] ?? []} onOpen={() => navigate(`/runs/${encodeURIComponent(j.id)}`)} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Alerts" actions={feed.length ? <HeadNote>{`${feed.length} open`}</HeadNote> : undefined} flush>
          {loading ? (
            <div className="p-5">
              <Skeleton className="h-24" />
            </div>
          ) : feed.length === 0 ? (
            <EmptyState icon={<ShieldCheck />} title="All clear" hint="Idle GPUs, OOM risk, walltime, checkpoints and budget are checked continuously." className="py-8" />
          ) : (
            <ul className="flex flex-col">
              {feed.slice(0, 20).map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => a.job?.id && navigate(`/runs/${encodeURIComponent(a.job.id)}`)}
                    className="flex w-full flex-col gap-1 border-b border-[var(--ec-line)] px-5 py-3 text-left last:border-b-0 hover:bg-[var(--ec-card-2)]"
                  >
                    <span className="flex items-center gap-2">
                      <SeverityBadge value={a.severity} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--ec-fg-hi)]">{ALERT_TYPE_LABEL[a.alertType] ?? a.alertType}</span>
                      <span className={cn('shrink-0 text-xs', muted)}>{formatRelative(a.detectedAt)}</span>
                    </span>
                    <Mono className={cn('truncate text-xs', muted)}>{`${a.job?.jobName ?? a.job?.id ?? ''}${a.job?.user ? ` · ${a.job.user}` : ''}`}</Mono>
                    {a.message && <span className={cn('line-clamp-2 text-[13px]', muted)}>{a.message}</span>}
                    {a.status === 'ACKED' && <span className={cn('text-xs', muted)}>Acknowledged</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </PageFrame>
  );
};

export default LiveMonitor;
