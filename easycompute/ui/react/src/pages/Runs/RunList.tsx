/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FastForward, FilterX, Rocket } from 'lucide-react';

import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import PageFrame, { EmptyRows, errorMessage, ErrorState } from '@/components/PageFrame/PageFrame';
import { EnumBadge } from '@/components/StatusBadges/StatusBadges';
import { Button } from '@/components/ui/button';
import { Container } from '@/components/ui/container';
import { DataGrid, DataGridBody, DataGridCell, DataGridHead, DataGridHeader, DataGridRow } from '@/components/ui/data-grid';
import { InputSearch } from '@/components/ui/input-search';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchLiveJobs, fetchLiveMetrics, fetchOpenAlerts, monitorTick } from '@/features/lab/api';
import { JobStateBadge, Kpi, muted, Sparkline, utilAppearance } from '@/features/lab/components';
import {
  ALERT_SEVERITY_APPEARANCE,
  ALERT_TYPE_LABEL,
  formatDuration,
  formatInt,
  formatPct100,
  formatRelative,
  formatUsd,
  walltimeLeft,
} from '@/features/lab/format';
import type { Alert, AlertSeverity } from '@/features/lab/types';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { useLoad } from '@/features/lab/useLoad';

type View = 'active' | 'alerts' | 'ended';
const SEVERITY_RANK: Record<AlertSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };
const POLL_MS = 30000;

const RunList: React.FC = () => {
  const navigate = useNavigate();
  const { reportError } = useErrorBoundary();
  const { labId, error: labError } = useCurrentLab();
  const [params, setParams] = useSearchParams();
  const view = (['active', 'alerts', 'ended'].includes(params.get('view') ?? '') ? params.get('view') : 'active') as View;
  const [q, setQ] = useState('');
  const [ticking, setTicking] = useState(false);
  const [tickNote, setTickNote] = useState<string | null>(null);
  const [tickError, setTickError] = useState<string | null>(null);

  const data = useLoad(
    () => (labId ? Promise.all([fetchLiveJobs(labId), fetchOpenAlerts(labId), fetchLiveMetrics(labId)]) : null),
    [labId],
  );
  const { reload } = data;

  // Live view: refresh every 30 s while the page is open.
  useEffect(() => {
    const t = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(t);
  }, [reload]);

  const [jobs, alerts, metrics] = data.data ?? [[], [], []];

  const alertsByJob = useMemo(() => {
    const by: Record<string, Alert[]> = {};
    alerts.forEach((a) => {
      if (a.job?.id) (by[a.job.id] ??= []).push(a);
    });
    Object.values(by).forEach((list) => list.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]));
    return by;
  }, [alerts]);

  const sparkByJob = useMemo(() => {
    const by: Record<string, number[]> = {};
    [...metrics].reverse().forEach((m) => {
      if (m.job?.id) (by[m.job.id] ??= []).push(m.gpuUtilPct ?? 0);
    });
    Object.keys(by).forEach((k) => {
      by[k] = by[k].slice(-24);
    });
    return by;
  }, [metrics]);

  const counts = useMemo(
    () => ({
      active: jobs.filter((j) => j.state === 'RUNNING' || j.state === 'PENDING').length,
      alerts: jobs.filter((j) => (alertsByJob[j.id] ?? []).length > 0).length,
      ended: jobs.filter((j) => j.state !== 'RUNNING' && j.state !== 'PENDING').length,
    }),
    [jobs, alertsByJob],
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return jobs
      .filter((j) =>
        view === 'active'
          ? j.state === 'RUNNING' || j.state === 'PENDING'
          : view === 'alerts'
            ? (alertsByJob[j.id] ?? []).length > 0
            : j.state !== 'RUNNING' && j.state !== 'PENDING',
      )
      .filter((j) => !needle || [j.jobName, j.user, j.cluster?.name, j.slurmJobId].some((v) => v?.toLowerCase().includes(needle)))
      .sort((a, b) => {
        const sa = alertsByJob[a.id]?.[0] ? SEVERITY_RANK[alertsByJob[a.id][0].severity] : 9;
        const sb = alertsByJob[b.id]?.[0] ? SEVERITY_RANK[alertsByJob[b.id][0].severity] : 9;
        return sa - sb || (b.submitTime ?? '').localeCompare(a.submitTime ?? '');
      });
  }, [jobs, view, q, alertsByJob]);

  const running = jobs.filter((j) => j.state === 'RUNNING');
  const gpus = running.reduce((s, j) => s + (j.allocGpus ?? 0), 0);
  const weightedUtil = gpus ? running.reduce((s, j) => s + (j.gpuUtilAvg ?? 0) * (j.allocGpus ?? 0), 0) / gpus : null;
  const burnPerHour = running.reduce((s, j) => s + (j.elapsedHours ? (j.costUsd ?? 0) / j.elapsedHours : 0), 0);
  const critical = alerts.filter((a) => a.severity === 'CRITICAL').length;

  const simulate = async () => {
    setTicking(true);
    setTickError(null);
    try {
      const res = await monitorTick();
      setTickNote(
        `Simulated 15 min: ${formatInt(Number(res?.metricsAdded ?? 0))} samples, ${formatInt(Number(res?.alertsRaised ?? 0))} new alerts, ${formatInt(Number(res?.actionsTaken ?? 0))} autopilot actions.`,
      );
      reload();
    } catch (err) {
      setTickError(errorMessage(err));
      reportError(err);
    } finally {
      setTicking(false);
    }
  };

  const setView = (v: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'active') next.delete('view');
        else next.set('view', v);
        return next;
      },
      { replace: true },
    );

  const error = labError ?? data.error;

  return (
    <PageFrame
      title="Live Runs"
      description="Running and queued jobs with live health, walltime and spend. Refreshes every 30 seconds."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" appearance="secondary" leadingIcon={<FastForward />} loading={ticking} onClick={simulate}>
            Simulate next 15 min
          </Button>
          <Button leadingIcon={<Rocket />} onClick={() => navigate('/plan')}>
            Plan a run
          </Button>
        </div>
      }
    >
      {error && <ErrorState message={`Could not load runs: ${error}`} onRetry={reload} />}
      {tickError && <ErrorState message={`Simulation failed: ${tickError}`} onRetry={simulate} />}
      {tickNote && !tickError && (
        <div role="status" className={`rounded-sm border border-[var(--c3-style-basic-border-primary)] bg-[var(--c3-style-basic-bg-primary)] px-4 py-2 text-c3-regular-body-p2 ${muted}`}>
          {tickNote}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Running" value={formatInt(running.length)} caption={`${formatInt(jobs.filter((j) => j.state === 'PENDING').length)} pending in queue`} />
        <Kpi label="GPUs in use" value={formatInt(gpus)} caption={`Weighted utilization ${formatPct100(weightedUtil)}`} tone={weightedUtil != null && weightedUtil < 40 ? 'warning' : undefined} />
        <Kpi label="Burn rate" value={`${formatUsd(burnPerHour)}/h`} caption="Across running jobs, USD equivalent" />
        <Kpi
          label="Open alerts"
          value={formatInt(alerts.length)}
          caption={critical ? `${critical} critical` : 'None critical'}
          tone={critical ? 'danger' : alerts.length ? 'warning' : 'success'}
          onClick={() => setView('alerts')}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={view} onValueChange={setView} variant="boxed" size="sm">
          <TabsList>
            <TabsTrigger value="active">{`Active (${counts.active})`}</TabsTrigger>
            <TabsTrigger value="alerts">{`With alerts (${counts.alerts})`}</TabsTrigger>
            <TabsTrigger value="ended">{`Recently ended (${counts.ended})`}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="w-full md:w-72">
          <InputSearch size="sm" aria-label="Search runs" placeholder="Search job, user, cluster" value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ('')} />
        </div>
        {q && (
          <Button variant="ghost" appearance="secondary" size="sm" leadingIcon={<FilterX />} onClick={() => setQ('')}>
            Clear
          </Button>
        )}
        <span className={`ml-auto flex items-center gap-2 text-c3-regular-body-p2 tabular-nums ${muted}`}>
          {data.loading && <Spinner size="sm" />}
          {`${rows.length} ${rows.length === 1 ? 'run' : 'runs'}`}
        </span>
      </div>

      <Container contentWidth="full-width">
        <div className="overflow-x-auto">
          <DataGrid className="app-table w-full">
            <DataGridHeader>
              <DataGridRow>
                <DataGridHead sortable={false} filterable={false}>Job</DataGridHead>
                <DataGridHead sortable={false} filterable={false}>State</DataGridHead>
                <DataGridHead sortable={false} filterable={false}>Resources</DataGridHead>
                <DataGridHead sortable={false} filterable={false}>GPU util (2 h)</DataGridHead>
                <DataGridHead sortable={false} filterable={false} align="right">Walltime left</DataGridHead>
                <DataGridHead sortable={false} filterable={false} align="right">Cost so far</DataGridHead>
                <DataGridHead sortable={false} filterable={false}>Alerts</DataGridHead>
              </DataGridRow>
            </DataGridHeader>
            <DataGridBody>
              {!data.loading && !error && rows.length === 0 && (
                <EmptyRows
                  colSpan={7}
                  label={q ? 'No runs match this search.' : view === 'alerts' ? 'No runs have open alerts.' : 'No runs here yet.'}
                  action={
                    view === 'active' && !q ? (
                      <Button size="sm" leadingIcon={<Rocket />} onClick={() => navigate('/plan')}>
                        Plan a run
                      </Button>
                    ) : undefined
                  }
                />
              )}
              {data.loading && !data.data && <EmptyRows colSpan={7} label="Loading runs…" />}
              {rows.map((j) => {
                const left = walltimeLeft(j);
                const frac = j.timelimitHours ? (j.elapsedHours ?? 0) / j.timelimitHours : 0;
                const spark = sparkByJob[j.id] ?? [];
                const jobAlerts = alertsByJob[j.id] ?? [];
                return (
                  <DataGridRow key={j.id} className="cursor-pointer" onClick={() => navigate(`/runs/${encodeURIComponent(j.id)}`)}>
                    <DataGridCell className="max-w-72">
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium text-[var(--c3-style-basic-fg-accent)]" title={j.jobName}>
                          {j.jobName ?? j.id}
                        </span>
                        <span className={`truncate text-xs ${muted}`}>
                          #{j.slurmJobId} · {j.user} · {j.project?.name ?? 'No project'}
                        </span>
                      </div>
                    </DataGridCell>
                    <DataGridCell className="whitespace-nowrap">
                      <div className="flex flex-col items-start gap-0.5">
                        <JobStateBadge value={j.state} />
                        <span className={`text-xs ${muted}`}>{j.state === 'PENDING' ? `queued ${formatRelative(j.submitTime)}` : j.qos}</span>
                      </div>
                    </DataGridCell>
                    <DataGridCell className="whitespace-nowrap">
                      <div className="flex flex-col">
                        <span>{`${j.allocGpus ?? 0}× ${j.gpuType?.id ?? 'CPU'}`}</span>
                        <span className={`text-xs ${muted}`}>
                          {j.cluster?.name ?? j.cluster?.id} / {j.partition?.name ?? j.partition?.id}
                        </span>
                      </div>
                    </DataGridCell>
                    <DataGridCell className="whitespace-nowrap">
                      <span className="flex items-center gap-2">
                        <Sparkline values={spark} appearance={utilAppearance(spark.length ? spark.slice(-6).reduce((a, b) => a + b, 0) / Math.min(6, spark.length) : null)} label={`${j.jobName} GPU utilization`} />
                        <span className="w-9 text-right text-xs tabular-nums">{formatPct100(spark.at(-1))}</span>
                      </span>
                    </DataGridCell>
                    <DataGridCell align="right" className="whitespace-nowrap tabular-nums">
                      <div className="flex flex-col items-end">
                        <span className={frac > 0.9 && j.state === 'RUNNING' ? 'text-[var(--c3-style-basic-fg-danger)]' : undefined}>{formatDuration(left)}</span>
                        <span className={`text-xs ${muted}`}>of {formatDuration(j.timelimitHours)}</span>
                      </div>
                    </DataGridCell>
                    <DataGridCell align="right" className="whitespace-nowrap tabular-nums">
                      {formatUsd(j.costUsd)}
                    </DataGridCell>
                    <DataGridCell className="whitespace-nowrap">
                      {jobAlerts.length === 0 ? (
                        <span className={muted}>—</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <EnumBadge value={ALERT_TYPE_LABEL[jobAlerts[0].alertType] ?? jobAlerts[0].alertType} appearance={ALERT_SEVERITY_APPEARANCE[jobAlerts[0].severity]} />
                          {jobAlerts.length > 1 && <span className={`text-xs ${muted}`}>+{jobAlerts.length - 1}</span>}
                        </span>
                      )}
                    </DataGridCell>
                  </DataGridRow>
                );
              })}
            </DataGridBody>
          </DataGrid>
        </div>
      </Container>
    </PageFrame>
  );
};

export default RunList;
