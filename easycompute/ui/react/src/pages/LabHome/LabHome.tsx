/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CalendarClock, Rocket, RefreshCw, ShieldCheck } from 'lucide-react';

import EChart from '@/components/charts/EChart';
import PageFrame, { EmptyRows, ErrorState, LoadingState } from '@/components/PageFrame/PageFrame';
import { EnumBadge } from '@/components/StatusBadges/StatusBadges';
import { Button } from '@/components/ui/button';
import { Container } from '@/components/ui/container';
import { DataGrid, DataGridBody, DataGridCell, DataGridHead, DataGridHeader, DataGridRow } from '@/components/ui/data-grid';
import { MetricCardDelta } from '@/components/ui/metric-card';
import {
  fetchAllocations,
  fetchLiveJobs,
  fetchLiveMetrics,
  fetchOpenAlerts,
  fetchProjects,
  getLabSummary,
} from '@/features/lab/api';
import { timeSeriesOption } from '@/features/lab/charts';
import { AlertTypeBadge, EmptyBlock, JobStateBadge, Kpi, Meter, muted, Sparkline, utilAppearance } from '@/features/lab/components';
import {
  ACTION_LABEL,
  countdown,
  formatDuration,
  formatInt,
  formatPct100,
  formatRelative,
  formatUsd,
  walltimeLeft,
} from '@/features/lab/format';
import type { JobMetric } from '@/features/lab/types';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { useLoad } from '@/features/lab/useLoad';
import { formatCompactCurrency, formatDate } from '@/lib/format';

const LabHome: React.FC = () => {
  const navigate = useNavigate();
  const { lab, labId, error: labError } = useCurrentLab();

  const summary = useLoad(() => (labId ? getLabSummary(labId) : null), [labId]);
  const lists = useLoad(
    () =>
      labId
        ? Promise.all([fetchLiveJobs(labId), fetchOpenAlerts(labId), fetchProjects(labId), fetchAllocations(labId), fetchLiveMetrics(labId)])
        : null,
    [labId],
  );

  const [jobs, alerts, projects, allocations, metrics] = lists.data ?? [[], [], [], [], []];
  const s = summary.data;

  const sparkByJob = useMemo(() => {
    const by: Record<string, number[]> = {};
    [...(metrics as JobMetric[])].reverse().forEach((m) => {
      const id = m.job?.id;
      if (!id) return;
      (by[id] ??= []).push(m.gpuUtilPct ?? 0);
    });
    Object.keys(by).forEach((k) => {
      by[k] = by[k].slice(-24);
    });
    return by;
  }, [metrics]);

  const upcoming = useMemo(
    () => projects.filter((p) => p.deadline && new Date(p.deadline).getTime() > Date.now()).slice(0, 5),
    [projects],
  );

  const burnOption = useMemo(() => {
    const burn = s?.burn ?? [];
    return timeSeriesOption({
      series: [
        { name: 'Spent (cumulative)', appearance: 'accent', area: true, points: burn.map((b) => [new Date(b.date).getTime(), b.usedUsd]) },
        { name: 'Planned burn', appearance: 'secondary', dashed: true, points: burn.map((b) => [new Date(b.date).getTime(), b.planUsd ?? null]) },
      ],
      yFormatter: (v) => formatCompactCurrency(v),
      thresholds: s?.allocationUsd ? [{ value: s.allocationUsd, label: `Allocation ${formatCompactCurrency(s.allocationUsd)}`, appearance: 'danger' }] : [],
      yMax: s?.allocationUsd ? Math.ceil((s.allocationUsd * 1.05) / 10000) * 10000 : undefined,
    });
  }, [s]);

  const usedPct = s?.allocationUsd ? (s.usedUsd ?? 0) / s.allocationUsd : 0;
  const exhaust = s?.projectedExhaustDate;
  const nextDeadline = upcoming[0]?.deadline;
  const exhaustBeforeDeadline = exhaust && nextDeadline && new Date(exhaust) < new Date(nextDeadline);
  const effDelta = s?.efficiencyScore != null && s?.efficiencyScorePrev != null ? s.efficiencyScore - s.efficiencyScorePrev : null;

  const reload = () => {
    summary.reload();
    lists.reload();
  };

  const actions = (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" appearance="secondary" leadingIcon={<RefreshCw />} onClick={reload} loading={summary.loading && Boolean(s)}>
        Refresh
      </Button>
      <Button leadingIcon={<Rocket />} onClick={() => navigate('/plan')}>
        Plan a run
      </Button>
    </div>
  );

  const error = labError ?? summary.error ?? lists.error;

  return (
    <PageFrame
      title={lab?.name ?? 'Lab Home'}
      description={lab ? [lab.piName, lab.department].filter(Boolean).join(' · ') || 'Budget, deadlines and live runs' : 'Budget, deadlines and live runs'}
      actions={actions}
    >
      {error && <ErrorState message={`Could not load lab overview: ${error}`} onRetry={reload} />}
      {!error && !s && <LoadingState label="Loading lab overview…" />}

      {s && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi
              label="Budget remaining"
              value={formatUsd(s.remainingUsd)}
              tone={usedPct > 0.9 ? 'danger' : usedPct > 0.75 ? 'warning' : undefined}
              caption={`${formatPct100(usedPct * 100)} of ${formatCompactCurrency(s.allocationUsd)} used`}
            >
              <Meter value={usedPct} appearance={usedPct > 0.9 ? 'danger' : usedPct > 0.75 ? 'warning' : 'accent'} label="Allocation used" className="my-1" />
            </Kpi>
            <Kpi
              label="Live jobs"
              value={formatInt((s.runningJobs ?? 0) + (s.pendingJobs ?? 0))}
              caption={`${formatInt(s.runningJobs)} running · ${formatInt(s.pendingJobs)} pending · ${formatInt(s.liveGpus)} GPUs`}
              onClick={() => navigate('/runs')}
            />
            <Kpi
              label="Open alerts"
              value={formatInt(s.openAlerts)}
              tone={(s.criticalAlerts ?? 0) > 0 ? 'danger' : (s.openAlerts ?? 0) > 0 ? 'warning' : 'success'}
              caption={(s.criticalAlerts ?? 0) > 0 ? `${s.criticalAlerts} critical need action` : 'No critical alerts'}
              onClick={() => navigate('/runs')}
            />
            <Kpi
              label="Efficiency score"
              value={
                <span className="flex items-baseline gap-2">
                  {formatInt(s.efficiencyScore)}
                  <span className={`text-sm font-normal ${muted}`}>/ 100</span>
                  {effDelta != null && (
                    <MetricCardDelta tone={effDelta >= 0 ? 'positive' : 'negative'}>{`${effDelta >= 0 ? '+' : ''}${effDelta} vs last 30 d`}</MetricCardDelta>
                  )}
                </span>
              }
              tone={(s.efficiencyScore ?? 0) < 50 ? 'danger' : undefined}
              caption={`${formatInt(s.wastedGpuHours30d)} of ${formatInt(s.gpuHours30d)} GPU-h wasted in 30 d`}
              onClick={() => navigate('/history')}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Container
              className="xl:col-span-2"
              title="Budget burn vs allocation"
              subtitle={
                exhaust
                  ? `At ${formatUsd(s.burnRateUsdPerDay)}/day the allocation runs out ${formatDate(exhaust)}${exhaustBeforeDeadline ? ` — before ${upcoming[0]?.deadlineLabel ?? 'the next deadline'}` : ''}`
                  : 'Cumulative spend across all allocations, USD equivalent'
              }
            >
              {(s.burn ?? []).length > 0 ? (
                <EChart ariaLabel="Budget burn vs allocation" option={burnOption} className="h-72" />
              ) : (
                <EmptyBlock label="No spend recorded yet." />
              )}
              {allocations.length > 0 && (
                <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 border-t border-[var(--c3-style-basic-border-primary)] pt-4 md:grid-cols-2">
                  {allocations.map((a) => {
                    const frac = a.totalUnits ? (a.usedUnits ?? 0) / a.totalUnits : 0;
                    const left = (a.totalUnits ?? 0) - (a.usedUnits ?? 0);
                    return (
                      <li key={a.id} className="flex min-w-0 flex-col gap-1">
                        <span className="flex items-baseline justify-between gap-2 text-c3-regular-body-p2">
                          <span className="truncate font-medium text-[var(--c3-style-basic-fg-primary)]" title={a.grantName}>
                            {a.cluster?.name ?? a.cluster?.id} · {a.grantName ?? a.source}
                          </span>
                          <span className={`shrink-0 tabular-nums text-xs ${muted}`}>
                            {formatInt(left)} {a.unitName} left
                          </span>
                        </span>
                        <Meter value={frac} appearance={frac > 0.9 ? 'danger' : frac > 0.75 ? 'warning' : 'accent'} label={`${a.grantName} used`} />
                        <span className={`text-xs ${muted}`}>Ends {formatDate(a.endDate)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Container>

            <Container
              title="Upcoming deadlines"
              subtitle="Projects the planner schedules against"
              actions={
                <Button variant="ghost" appearance="accent" size="sm" onClick={() => navigate('/context')}>
                  Manage
                </Button>
              }
            >
              {lists.loading && !lists.data ? (
                <LoadingState />
              ) : upcoming.length === 0 ? (
                <EmptyBlock icon={<CalendarClock className="size-6" aria-hidden />} label="No upcoming deadlines." />
              ) : (
                <ul className="flex flex-col divide-y divide-[var(--c3-style-basic-border-primary)]">
                  {upcoming.map((p) => {
                    const c = countdown(p.deadline);
                    return (
                      <li key={p.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate text-c3-bold-body-p2 text-[var(--c3-style-basic-fg-primary)]">{p.deadlineLabel ?? p.name}</span>
                          <span className={`truncate text-xs ${muted}`}>
                            {p.name} · {formatDate(p.deadline)}
                          </span>
                        </div>
                        <EnumBadge value={c.text} appearance={c.tone} />
                      </li>
                    );
                  })}
                </ul>
              )}
              <Button className="mt-4 w-full" variant="soft" appearance="accent" leadingIcon={<Rocket />} onClick={() => navigate('/plan')}>
                Plan a run against a deadline
              </Button>
            </Container>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Container
              className="xl:col-span-2"
              contentWidth="full-width"
              title="Running jobs"
              subtitle="GPU utilization over the last 2 hours"
              actions={
                <Button variant="ghost" appearance="accent" size="sm" trailingIcon={<ArrowRight />} onClick={() => navigate('/runs')}>
                  Live runs
                </Button>
              }
            >
              <div className="overflow-x-auto">
                <DataGrid className="w-full">
                  <DataGridHeader>
                    <DataGridRow>
                      <DataGridHead sortable={false} filterable={false}>Job</DataGridHead>
                      <DataGridHead sortable={false} filterable={false}>State</DataGridHead>
                      <DataGridHead sortable={false} filterable={false}>GPU util</DataGridHead>
                      <DataGridHead sortable={false} filterable={false} align="right">Walltime left</DataGridHead>
                      <DataGridHead sortable={false} filterable={false} align="right">Cost</DataGridHead>
                    </DataGridRow>
                  </DataGridHeader>
                  <DataGridBody>
                    {!lists.loading && jobs.length === 0 && <EmptyRows colSpan={5} label="No jobs running. Plan one to get started." />}
                    {jobs.slice(0, 6).map((j) => {
                      const left = walltimeLeft(j);
                      return (
                        <DataGridRow key={j.id} className="cursor-pointer" onClick={() => navigate(`/runs/${encodeURIComponent(j.id)}`)}>
                          <DataGridCell className="max-w-64">
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate font-medium text-[var(--c3-style-basic-fg-accent)]">{j.jobName ?? j.id}</span>
                              <span className={`truncate text-xs ${muted}`}>
                                {j.cluster?.name ?? j.cluster?.id} · {j.allocGpus}× {j.gpuType?.id ?? 'CPU'} · {j.user}
                              </span>
                            </div>
                          </DataGridCell>
                          <DataGridCell className="whitespace-nowrap">
                            <JobStateBadge value={j.state} />
                          </DataGridCell>
                          <DataGridCell className="whitespace-nowrap">
                            <span className="flex items-center gap-2">
                              <Sparkline values={sparkByJob[j.id] ?? []} appearance={utilAppearance(j.gpuUtilAvg)} label={`${j.jobName} GPU utilization`} />
                              <span className="w-9 text-right tabular-nums text-xs">{formatPct100((sparkByJob[j.id] ?? []).at(-1))}</span>
                            </span>
                          </DataGridCell>
                          <DataGridCell align="right" className="whitespace-nowrap tabular-nums">
                            <span className={left != null && j.timelimitHours && left / j.timelimitHours < 0.1 ? 'text-[var(--c3-style-basic-fg-danger)]' : undefined}>
                              {formatDuration(left)}
                            </span>
                          </DataGridCell>
                          <DataGridCell align="right" className="whitespace-nowrap tabular-nums">{formatUsd(j.costUsd)}</DataGridCell>
                        </DataGridRow>
                      );
                    })}
                  </DataGridBody>
                </DataGrid>
              </div>
            </Container>

            <Container title="Open alerts" subtitle={`${alerts.length} need attention`}>
              {alerts.length === 0 ? (
                <EmptyBlock icon={<ShieldCheck className="size-6" aria-hidden />} label="All runs healthy." />
              ) : (
                <ul className="flex flex-col divide-y divide-[var(--c3-style-basic-border-primary)]">
                  {alerts.slice(0, 5).map((a) => (
                    <li key={a.id} className="py-3 first:pt-0 last:pb-0">
                      <button
                        type="button"
                        className="flex w-full flex-col gap-1 rounded-sm text-left hover:opacity-80"
                        onClick={() => a.job && navigate(`/runs/${encodeURIComponent(a.job.id)}`)}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <AlertTypeBadge type={a.alertType} severity={a.severity} />
                          <span className={`text-xs ${muted}`}>{formatRelative(a.detectedAt)}</span>
                        </span>
                        <span className="line-clamp-2 text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">{a.message}</span>
                        <span className={`text-xs ${muted}`}>
                          {a.job?.jobName ?? a.job?.name ?? a.job?.id}
                          {a.recommendedAction ? ` · Suggested: ${ACTION_LABEL[a.recommendedAction]}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Container>
          </div>
        </>
      )}
    </PageFrame>
  );
};

export default LabHome;
