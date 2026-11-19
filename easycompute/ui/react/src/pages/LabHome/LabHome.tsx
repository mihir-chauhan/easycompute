/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, FileText, Rocket, ShieldCheck, User } from 'lucide-react';

import {
  DataTable,
  EmptyState,
  ErrorState,
  KpiRow,
  KpiRowSkeleton,
  KpiTile,
  MetricChart,
  PageFrame,
  SectionCard,
  Sparkline,
  TableSkeleton,
  TONE_TEXT,
  utilTone,
  ToneBadge,
  TONE_BG,
  errorMessage,
  lineOption,
  toneColor,
  useThemeKey,
  provenanceFor,
  type Column,
  type Tone,
} from '@/components/app';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { applyJobAction, fetchLabActions, fetchLiveJobs, fetchLiveMetrics, fetchMembers, fetchOpenAlerts, getLabSummary } from '@/features/lab/api';
import { ActivityRow, CheckRow, HeadNote, JobStateBadge, muted } from '@/features/lab/components';
import { ACTION_LABEL, ALERT_TYPE_LABEL, whereLabel, formatShortDateTime, formatInt, formatPct100, formatUsd } from '@/features/lab/format';
import type { Alert, Job, JobMetric, SummaryAllocation, SummaryDeadline } from '@/features/lab/types';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { alertModel, ModelProvenance } from '@/features/lab/models';
import { LIVE_POLL_MS, LiveBadge, SimNote, useNow } from '@/features/lab/live';
import { buildTelemetry, fleetUtil, TELEMETRY_TICK_MS } from '@/features/lab/telemetry';
import { useLabRole } from '@/features/lab/useLabRole';
import { useLoad } from '@/features/lab/useLoad';
import { formatDate, formatShortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Attention {
  key: string;
  kind: 'bad' | 'warn' | 'info';
  glyph: string;
  title: React.ReactNode;
  detail?: React.ReactNode;
  action?: { label: string; primary?: boolean; run: () => void };
}

const isUsd = (a: SummaryAllocation) => (a.unitName ?? '').toUpperCase() === 'USD';
const isGpuHours = (a: SummaryAllocation) => /gpu/i.test(a.unitName ?? '');

/** Deadline status from days left and whether any allocation runs out first. */
const deadlineStatus = (d: SummaryDeadline, allocations: SummaryAllocation[]): [Tone, string] => {
  const runOut = allocations.find((a) => a.projectedRunOut && new Date(a.projectedRunOut) < new Date(d.deadline));
  if (runOut) return ['bad', 'Budget risk'];
  const days = d.daysLeft ?? (new Date(d.deadline).getTime() - Date.now()) / 86400000;
  if (days < 7) return ['warn', 'Tight'];
  return ['good', 'On track'];
};

const LabHome: React.FC = () => {
  const navigate = useNavigate();
  const themeKey = useThemeKey();
  const { reportError } = useErrorBoundary();
  const { lab, labId, error: labError } = useCurrentLab();
  const lr = useLabRole();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const summary = useLoad(() => (labId ? getLabSummary(labId) : null), [labId], LIVE_POLL_MS);
  const live = useLoad(
    () => (labId ? Promise.all([fetchLiveJobs(labId), fetchOpenAlerts(labId), fetchLiveMetrics(labId), fetchLabActions(labId, 8), fetchMembers(labId)]) : null),
    [labId],
    LIVE_POLL_MS,
  );
  const [jobs, alerts, metrics, actions, members] = live.data ?? [[], [], [], [], []];
  const s = summary.data;
  const allocations = s?.allocations ?? [];
  const deadlines = s?.deadlines ?? [];

  const usd = allocations.filter(isUsd).sort((a, b) => (b.totalUnits ?? 0) - (a.totalUnits ?? 0))[0];
  const gpuAlloc = allocations.filter(isGpuHours).sort((a, b) => (b.totalUnits ?? 0) - (a.totalUnits ?? 0))[0];
  const running = jobs.filter((j) => j.state === 'RUNNING');
  const queued = jobs.filter((j) => j.state === 'PENDING');
  const liveGpus = running.reduce((n, j) => n + (j.allocGpus ?? 0), 0);
  const liveClusters = new Set(running.map((j) => j.cluster?.id)).size;
  const next = deadlines[0];
  const clusterNames = [...new Set(allocations.map((a) => a.clusterName ?? a.clusterId).filter(Boolean))];

  /** Fleet-average GPU utilization across the lab's running jobs, streaming (server samples + live profile). */
  const tick = useNow(TELEMETRY_TICK_MS);
  const metricsByJob = useMemo(() => {
    const by: Record<string, JobMetric[]> = {};
    metrics.forEach((m) => {
      if (m.job?.id) (by[m.job.id] ??= []).push(m);
    });
    Object.values(by).forEach((l) => l.reverse());
    return by;
  }, [metrics]);
  const perJob = useMemo(
    () => Object.fromEntries(running.map((j) => [j.id, buildTelemetry(j, metricsByJob[j.id] ?? [], tick, { windowMs: 30 * 60_000, points: 60 })])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobs, metricsByJob, tick],
  );
  const fleet = useMemo(() => fleetUtil(Object.values(perJob), tick), [perJob, tick]);
  const nowUtil = [...fleet.v].reverse().find((v) => v != null) ?? null;
  const utilOption = useMemo(() => {
    if (fleet.v.filter((v) => v != null).length < 2) return null;
    return lineOption({
      x: fleet.t.map((t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })),
      series: [{ name: 'Avg GPU util', data: fleet.v, area: true, color: toneColor('good') }],
      valueFormat: (v) => `${Math.round(v)}%`,
      min: 0,
      max: 100,
      thresholds: [{ value: 70, label: 'Target 70%' }],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, themeKey]);

  const runAction = async (a: Alert) => {
    if (!a.job || !a.recommendedAction) return;
    setBusy(a.id);
    setActionError(null);
    try {
      await applyJobAction(a.job.id, a.recommendedAction, lr.actor);
      live.reload();
      summary.reload();
    } catch (err) {
      setActionError(errorMessage(err));
      reportError(err);
    } finally {
      setBusy(null);
    }
  };

  const attention: Attention[] = useMemo(() => {
    const items: Attention[] = alerts
      .filter((a) => a.status === 'OPEN')
      .sort((a, b) => (a.severity === 'CRITICAL' ? 0 : 1) - (b.severity === 'CRITICAL' ? 0 : 1))
      .slice(0, 4)
      .map((a) => ({
        key: a.id,
        kind: a.severity === 'CRITICAL' ? 'bad' : 'warn',
        glyph: '!',
        title: (
          <span>
            {`${ALERT_TYPE_LABEL[a.alertType] ?? a.alertType} in `}
            <button type="button" className="text-[var(--c3-style-basic-fg-accent)] hover:underline" onClick={() => a.job && navigate(`/runs/${encodeURIComponent(a.job.id)}`)}>
              {a.job?.jobName ?? a.job?.name ?? a.job?.id}
            </button>
          </span>
        ),
        detail: (
          <>
            {a.message}
            <span className="mt-1 block">
              <ModelProvenance name={alertModel(a.alertType)} provenance={provenanceFor(a, alertModel(a.alertType))} />
            </span>
          </>
        ),
        action: a.recommendedAction && lr.canActOn(a.job?.user) ? { label: ACTION_LABEL[a.recommendedAction], primary: a.severity === 'CRITICAL', run: () => runAction(a) } : undefined,
      }));
    allocations
      .filter((a) => a.runsOutBeforeEnd && a.projectedRunOut)
      .forEach((a) =>
        items.push({
          key: `runout-${a.id}`,
          kind: 'warn',
          glyph: '$',
          title: `At this pace, ${a.grantName ?? a.name ?? a.clusterName} runs out ${formatShortDate(a.projectedRunOut)}`,
          detail: (
            <>
              {`${formatInt(a.remainingUnits)} ${a.unitName ?? ''} left, burning ${formatInt(a.burnPerDay)} per day; the allocation ends ${formatDate(a.endDate)}.`}
              <span className="mt-1 block">
                <ModelProvenance name="AllocationBurnForecaster" />
              </span>
            </>
          ),
          action: { label: 'Review usage', run: () => navigate('/history') },
        }),
      );
    allocations
      .filter((a) => !a.runsOutBeforeEnd && (a.daysLeft ?? 999) <= 45 && (a.pctUsed ?? 1) < 0.9)
      .forEach((a) =>
        items.push({
          key: `expire-${a.id}`,
          kind: 'info',
          glyph: 'i',
          title: `${formatInt(a.remainingUnits)} ${a.unitName ?? ''} on ${a.clusterName ?? a.clusterId} expire ${formatShortDate(a.endDate)}`,
          detail: `${a.grantName ?? 'This allocation'} does not carry over. The launch planner prefers it for runs that fit.`,
          action: { label: `Plan on ${a.clusterName ?? a.clusterId}`, run: () => navigate('/plan') },
        }),
      );
    return items.slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts, allocations, lr.role, lr.user]);

  const recentColumns: Column<Job>[] = [
    {
      key: 'run',
      header: 'Run',
      render: (j) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-mono font-medium text-[var(--c3-style-basic-fg-primary)]">{j.jobName ?? j.id}</span>
          <span className={cn('truncate text-xs', muted)}>{[j.user, j.project?.name].filter(Boolean).join(' · ')}</span>
        </div>
      ),
    },
    { key: 'cl', header: 'Cluster', hideBelow: 'md', render: (j) => whereLabel(j) },
    { key: 'gpus', header: 'GPUs', align: 'right', render: (j) => formatInt(j.allocGpus) },
    { key: 'st', header: 'Status', render: (j) => (alerts.some((a) => a.job?.id === j.id && a.severity === 'CRITICAL' && a.status === 'OPEN') ? <ToneBadge tone="warn">Needs approval</ToneBadge> : <JobStateBadge value={j.state} />) },
    {
      key: 'util',
      header: 'GPU util',
      align: 'right',
      hideBelow: 'sm',
      render: (j) => {
        const sr = perJob[j.id];
        if (!sr?.length) return <span className={muted}>–</span>;
        const u = [...sr].reverse().find((p) => p.gpuUtilPct != null)?.gpuUtilPct ?? null;
        return (
          <span className="inline-flex items-center justify-end gap-2">
            <Sparkline values={sr.slice(-45).map((p) => p.gpuUtilPct)} tone="accent" domain={[0, 100]} area={false} className="h-6 w-16" ariaLabel="GPU utilization trend" />
            <span className={cn('w-9 tabular-nums', TONE_TEXT[utilTone(u)])}>{formatPct100(u)}</span>
          </span>
        );
      },
    },
    { key: 'cost', header: 'Cost', align: 'right', render: (j) => formatUsd(j.costUsd) },
  ];

  const error = labError ?? summary.error;

  return (
    <PageFrame
      title={lab?.name ?? 'Overview'}
      description={[lab?.piName && `PI ${lab.piName}`, members.length ? `${members.length} members` : null, clusterNames.join(' · ')].filter(Boolean).join(' · ') || 'Budget, deadlines and live runs'}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <LiveBadge updatedAt={live.updatedAt} />
          <Button variant="outline" appearance="secondary" leadingIcon={<FileText />} onClick={() => navigate('/context')}>
            Update lab context
          </Button>
          <Button leadingIcon={<Rocket />} onClick={() => navigate('/plan')}>
            Plan a run
          </Button>
        </div>
      }
    >
      {error && <ErrorState message={`Could not load the lab overview: ${error}`} onRetry={summary.reload} />}
      {actionError && <ErrorState message={actionError} />}

      {!s && !error ? (
        <KpiRowSkeleton />
      ) : s ? (
        <KpiRow>
          <KpiTile
            label={usd ? 'Grant compute remaining' : 'Compute remaining'}
            value={formatUsd(usd ? usd.remainingUnits : s.kpis.allocationRemainingUsd)}
            unit={usd ? `of ${formatUsd(usd.totalUnits)}` : 'USD equivalent'}
            caption={usd ? `${usd.grantName ?? usd.name ?? ''} · ends ${formatDate(usd.endDate)}` : 'All allocations'}
            onClick={() => navigate('/history')}
          />
          <KpiTile
            label={gpuAlloc ? `${gpuAlloc.clusterName ?? gpuAlloc.clusterId} GPU-hours` : 'GPU-hours (30 d)'}
            value={gpuAlloc ? `${formatInt(gpuAlloc.remainingUnits)} h` : formatInt(s.kpis.gpuHours30d)}
            unit={gpuAlloc ? 'left' : undefined}
            caption={gpuAlloc ? `${formatInt(gpuAlloc.usedUnits)} of ${formatInt(gpuAlloc.totalUnits)} used · ends ${formatShortDate(gpuAlloc.endDate)}` : `${formatUsd(s.kpis.costUsd30d)} spent in 30 days`}
          />
          <KpiTile
            label="Live runs"
            tone={running.length ? 'good' : 'neutral'}
            value={formatInt(running.length || s.kpis.runningJobs)}
            unit={`${formatInt(queued.length || s.kpis.pendingJobs)} queued`}
            caption={`${formatInt(liveGpus || s.kpis.runningGpus)} GPUs in use across ${liveClusters || 0} cluster${liveClusters === 1 ? '' : 's'}`}
            onClick={() => navigate('/runs')}
          />
          <KpiTile
            label="Next deadline"
            value={next ? (next.deadlineLabel ?? next.name) : 'None'}
            unit={next ? formatShortDate(next.deadline) : undefined}
            caption={next ? `${formatInt(next.daysLeft)} days · ${next.name}` : 'Add deadlines in Lab context'}
            onClick={() => navigate('/context')}
          />
        </KpiRow>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <SectionCard title="Needs your attention" actions={attention.length ? <ToneBadge tone="warn">{`${attention.length} open`}</ToneBadge> : undefined}>
          {(live.loading && !live.data) || (!s && !error) ? (
            <TableSkeleton rows={3} />
          ) : attention.length === 0 ? (
            <EmptyState icon={<ShieldCheck />} title="Nothing needs you right now" hint="Guardrails watch every live run; budget and expiry warnings land here." />
          ) : (
            <ul className="flex flex-col">
              {attention.map((it) => (
                <CheckRow
                  key={it.key}
                  kind={it.kind}
                  glyph={it.glyph}
                  title={it.title}
                  detail={it.detail}
                  right={
                    it.action ? (
                      <Button size="sm" variant={it.action.primary ? 'solid' : 'outline'} appearance={it.action.primary ? 'accent' : 'secondary'} loading={busy === it.key} onClick={it.action.run}>
                        {it.action.label}
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Deadlines" actions={<HeadNote>From lab context</HeadNote>}>
          {!s ? (
            <TableSkeleton rows={4} />
          ) : deadlines.length === 0 ? (
            <EmptyState title="No upcoming deadlines" hint="Add projects with deadlines in Lab context." />
          ) : (
            <ul className="flex flex-col">
              {deadlines.slice(0, 5).map((d) => {
                const [tone, label] = deadlineStatus(d, allocations);
                return (
                  <li key={d.projectId} className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-2.5 border-b border-[var(--c3-style-basic-border-border)] py-3 first:pt-0 last:border-b-0 last:pb-0">
                    <span aria-hidden className={cn('mt-1.5 size-2.5 rounded-full', TONE_BG[tone])} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">{d.deadlineLabel ?? d.name}</div>
                      <div className={cn('text-[13px]', muted)}>{`${formatShortDate(d.deadline)} · ${d.name} · ${formatInt(d.daysLeft)} days`}</div>
                    </div>
                    <ToneBadge tone={tone}>{label}</ToneBadge>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      </div>

      <MetricChart
        title="Lab GPU utilization"
        subtitle={nowUtil != null ? `Average SM utilization across the lab's live GPUs · now ${formatPct100(nowUtil)} · 30-day average ${formatPct100(s?.kpis.avgGpuUtil)}` : 'Average SM utilization across the lab’s live GPUs'}
        option={utilOption}
        loading={live.loading && !live.data}
        error={live.error}
        onRetry={live.reload}
        empty={Boolean(live.data) && !utilOption}
        emptyLabel="No live GPU jobs right now"
        ariaLabel="Lab GPU utilization"
        heightClass="h-64"
        live
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <SectionCard
          flush
          title="Live and queued runs"
          actions={
            <Button variant="outline" appearance="secondary" size="sm" onClick={() => navigate('/runs')}>
              View all
            </Button>
          }
        >
          <DataTable
            columns={recentColumns}
            rows={[...running, ...queued].slice(0, 6)}
            rowKey={(j) => j.id}
            onRowClick={(j) => navigate(`/runs/${encodeURIComponent(j.id)}`)}
            loading={live.loading && !live.data}
            emptyLabel="No runs live"
            emptyHint="Plan a run and it shows up here with live health."
          />
        </SectionCard>

        <SectionCard title="Agent activity" actions={<HeadNote>Latest</HeadNote>}>
          {live.loading && !live.data ? (
            <TableSkeleton rows={4} />
          ) : actions.length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <ul className="flex flex-col">
              {actions.map((e) => (
                <ActivityRow
                  key={e.id}
                  time={formatShortDateTime(e.actedAt)}
                  icon={e.actor === 'AUTOPILOT' ? <Bot /> : <User />}
                  title={`${ACTION_LABEL[e.actionType] ?? e.actionType}${e.job ? ` · ${e.job.jobName ?? e.job.name ?? e.job.id}` : ''}`}
                  detail={e.detail}
                />
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
      <SimNote />
    </PageFrame>
  );
};

export default LabHome;
