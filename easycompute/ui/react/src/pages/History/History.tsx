/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Lightbulb, Rocket, Settings2 } from 'lucide-react';

import EChart from '@/components/charts/EChart';
import PageFrame, { EmptyRows, ErrorState, LoadingState } from '@/components/PageFrame/PageFrame';
import { Button } from '@/components/ui/button';
import { Container } from '@/components/ui/container';
import { DataGrid, DataGridBody, DataGridCell, DataGridHead, DataGridHeader, DataGridRow } from '@/components/ui/data-grid';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchHistoryJobs } from '@/features/lab/api';
import { hBarOption } from '@/features/lab/charts';
import { EmptyBlock, Kpi, Meter, muted, utilAppearance } from '@/features/lab/components';
import { formatInt, formatPct100, formatUsd } from '@/features/lab/format';
import { gpuHours, groupStats, histogram, wastedGpuHours, wastePatterns, weekStart } from '@/features/lab/insights';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { useLoad } from '@/features/lab/useLoad';
import { chartColor, formatShortDate } from '@/lib/format';

const PERIODS = { '30': 30, '90': 90, all: Infinity } as const;
type Period = keyof typeof PERIODS;

const History: React.FC = () => {
  const navigate = useNavigate();
  const { labId, error: labError } = useCurrentLab();
  const [params, setParams] = useSearchParams();
  const period: Period = (Object.keys(PERIODS) as Period[]).find((p) => p === params.get('period')) ?? '90';

  const res = useLoad(() => (labId ? fetchHistoryJobs(labId) : null), [labId]);

  const jobs = useMemo(() => {
    const all = res.data ?? [];
    if (period === 'all' || all.length === 0) return all;
    // Window ends at the newest job so seeded history (which can be older than today) still shows.
    const newest = Math.max(...all.map((j) => new Date(j.endTime ?? j.startTime ?? 0).getTime()));
    const from = newest - PERIODS[period] * 86400000;
    return all.filter((j) => new Date(j.endTime ?? j.startTime ?? 0).getTime() >= from);
  }, [res.data, period]);

  const gpuJobs = useMemo(() => jobs.filter((j) => (j.allocGpus ?? 0) > 0), [jobs]);

  const totals = useMemo(() => {
    const gh = gpuJobs.reduce((s, j) => s + gpuHours(j), 0);
    const wasted = gpuJobs.reduce((s, j) => s + wastedGpuHours(j), 0);
    const cost = jobs.reduce((s, j) => s + (j.costUsd ?? 0), 0);
    const utilGh = gpuJobs.filter((j) => j.gpuUtilAvg != null).reduce((s, j) => s + gpuHours(j), 0);
    const util = utilGh ? gpuJobs.reduce((s, j) => s + (j.gpuUtilAvg ?? 0) * gpuHours(j), 0) / utilGh : null;
    const success = jobs.length ? jobs.filter((j) => j.state === 'COMPLETED').length / jobs.length : 0;
    const usdPerGh = gh ? gpuJobs.reduce((s, j) => s + (j.costUsd ?? 0), 0) / gh : 0;
    return { gh, wasted, cost, util, success, wastedUsd: wasted * usdPerGh };
  }, [jobs, gpuJobs]);

  const patterns = useMemo(() => wastePatterns(gpuJobs), [gpuJobs]);
  const users = useMemo(() => groupStats(jobs, (j) => j.user ?? 'unknown'), [jobs]);
  const projects = useMemo(() => groupStats(gpuJobs, (j) => j.project?.id ?? 'none', (j) => j.project?.name ?? 'No project'), [gpuJobs]);

  const utilOption = useMemo(() => {
    const bins = histogram(gpuJobs.filter((j) => j.gpuUtilAvg != null).map((j) => j.gpuUtilAvg as number));
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: bins.map((b) => b.label), axisLabel: { interval: 1 } },
      yAxis: { type: 'value', name: 'jobs', splitNumber: 3 },
      series: [{ name: 'Jobs', type: 'bar', barCategoryGap: '12%', data: bins.map((b) => ({ value: b.count, itemStyle: { color: chartColor(utilAppearance(b.lo + 5)) } })) }],
    };
  }, [gpuJobs]);

  const weeklyOption = useMemo(() => {
    const by = new Map<string, { used: number; wasted: number }>();
    gpuJobs.forEach((j) => {
      const at = j.endTime ?? j.startTime;
      if (!at) return;
      const k = weekStart(at);
      const cur = by.get(k) ?? { used: 0, wasted: 0 };
      const w = wastedGpuHours(j);
      cur.used += gpuHours(j) - w;
      cur.wasted += w;
      by.set(k, cur);
    });
    const weeks = [...by.keys()].sort();
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: unknown) => (typeof v === 'number' ? `${formatInt(v)} GPU-h` : '—') },
      legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 4 },
      grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: weeks.map((w) => formatShortDate(w)) },
      yAxis: { type: 'value', splitNumber: 3, axisLabel: { formatter: (v: number) => formatInt(v) } },
      series: [
        { name: 'Productive', type: 'bar', stack: 'gh', barMaxWidth: 24, itemStyle: { color: chartColor('accent') }, data: weeks.map((w) => Math.round(by.get(w)?.used ?? 0)) },
        { name: 'Wasted', type: 'bar', stack: 'gh', barMaxWidth: 24, itemStyle: { color: chartColor('danger') }, data: weeks.map((w) => Math.round(by.get(w)?.wasted ?? 0)) },
      ],
    };
  }, [gpuJobs]);

  const projectOption = useMemo(
    () => hBarOption(projects.slice(0, 8).map((p) => ({ label: p.label, value: Math.round(p.wastedGpuHours), appearance: 'danger' as const })), (v) => `${formatInt(v)} GPU-h`),
    [projects],
  );

  const setPeriod = (p: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (p === '90') next.delete('period');
        else next.set('period', p);
        return next;
      },
      { replace: true },
    );

  const error = labError ?? res.error;
  const wastedShare = totals.gh ? totals.wasted / totals.gh : 0;

  return (
    <PageFrame
      title="History & Insights"
      description="How efficiently the lab used its compute, where GPU-hours were wasted, and what to change"
      actions={
        <Tabs value={period} onValueChange={setPeriod} variant="boxed" size="sm">
          <TabsList>
            <TabsTrigger value="30">30 days</TabsTrigger>
            <TabsTrigger value="90">90 days</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      {error && <ErrorState message={`Could not load history: ${error}`} onRetry={res.reload} />}
      {!res.data && !error && <LoadingState label="Loading job history…" />}

      {res.data && jobs.length === 0 && (
        <Container>
          <EmptyBlock label="No finished jobs in this period." action={<Button size="sm" leadingIcon={<Rocket />} onClick={() => navigate('/plan')}>Plan a run</Button>} />
        </Container>
      )}

      {res.data && jobs.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Finished jobs" value={formatInt(jobs.length)} caption={`${formatPct100(totals.success * 100)} completed successfully`} />
            <Kpi label="GPU-hours used" value={formatInt(totals.gh)} caption={`${formatUsd(totals.cost)} total spend`} />
            <Kpi
              label="Wasted GPU-hours"
              value={formatInt(totals.wasted)}
              tone={wastedShare > 0.25 ? 'danger' : wastedShare > 0.1 ? 'warning' : 'success'}
              caption={`${formatPct100(wastedShare * 100)} of GPU time · ≈ ${formatUsd(totals.wastedUsd)}`}
            />
            <Kpi label="GPU utilization" value={formatPct100(totals.util)} tone={totals.util != null && totals.util < 50 ? 'warning' : undefined} caption="Weighted by GPU-hours" />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Container className="xl:col-span-2" title="Top waste patterns" subtitle="Ranked by GPU-hours lost, with the fix that prevents each">
              {patterns.length === 0 ? (
                <EmptyBlock label="No waste patterns detected. Nice work." />
              ) : (
                <ul className="flex flex-col divide-y divide-[var(--c3-style-basic-border-primary)]">
                  {patterns.map((p) => (
                    <li key={p.key} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="text-c3-bold-body-p2 text-[var(--c3-style-basic-fg-primary)]">{p.label}</span>
                        <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
                          <span className="text-c3-bold-body-p2">{`${formatInt(p.wastedGpuHours)} GPU-h`}</span>
                          <span className={`w-16 text-right text-xs ${muted}`}>{formatUsd(p.wastedUsd)}</span>
                        </span>
                      </span>
                      <Meter value={patterns[0].wastedGpuHours ? p.wastedGpuHours / patterns[0].wastedGpuHours : 0} appearance="danger" label={`${p.label} share`} />
                      <span className={`flex items-start gap-2 text-c3-regular-body-p2 ${muted}`}>
                        <Lightbulb className="mt-0.5 size-4 shrink-0 text-[var(--c3-style-basic-fg-warning)]" aria-hidden />
                        <span>
                          <span className="text-[var(--c3-style-basic-fg-primary)]">{`${formatInt(p.jobs)} job${p.jobs === 1 ? '' : 's'}. `}</span>
                          {p.recommendation}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--c3-style-basic-border-primary)] pt-4">
                <Button variant="soft" appearance="accent" size="sm" leadingIcon={<Settings2 />} onClick={() => navigate('/context')}>
                  Tune Autopilot
                </Button>
                <Button variant="ghost" appearance="accent" size="sm" leadingIcon={<Rocket />} onClick={() => navigate('/plan')}>
                  Plan the next run right-sized
                </Button>
              </div>
            </Container>

            <Container title="GPU utilization distribution" subtitle="Finished GPU jobs by average utilization">
              <EChart ariaLabel="GPU utilization distribution" option={utilOption} className="h-72" />
            </Container>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Container className="xl:col-span-2" title="GPU-hours by week" subtitle="Productive vs wasted (failed runs + idle share of runs under 50% utilization)">
              <EChart ariaLabel="GPU-hours by week" option={weeklyOption} className="h-72" />
            </Container>
            <Container title="Waste by project" subtitle="Wasted GPU-hours">
              {projects.length === 0 ? <EmptyBlock label="No GPU jobs." /> : <EChart ariaLabel="Waste by project" option={projectOption} className="h-72" />}
            </Container>
          </div>

          <Container contentWidth="full-width" title="By user" subtitle="Pseudonymized usernames">
            <div className="overflow-x-auto">
              <DataGrid className="w-full">
                <DataGridHeader>
                  <DataGridRow>
                    <DataGridHead sortable={false} filterable={false}>User</DataGridHead>
                    <DataGridHead sortable={false} filterable={false} align="right">Jobs</DataGridHead>
                    <DataGridHead sortable={false} filterable={false} align="right">Success</DataGridHead>
                    <DataGridHead sortable={false} filterable={false} align="right">GPU-hours</DataGridHead>
                    <DataGridHead sortable={false} filterable={false}>Avg GPU util</DataGridHead>
                    <DataGridHead sortable={false} filterable={false} align="right">Wasted GPU-h</DataGridHead>
                    <DataGridHead sortable={false} filterable={false} align="right">Spend</DataGridHead>
                  </DataGridRow>
                </DataGridHeader>
                <DataGridBody>
                  {users.length === 0 && <EmptyRows colSpan={7} label="No jobs." />}
                  {users.map((u) => (
                    <DataGridRow key={u.key}>
                      <DataGridCell className="whitespace-nowrap font-mono">{u.label}</DataGridCell>
                      <DataGridCell align="right" className="tabular-nums">{formatInt(u.jobs)}</DataGridCell>
                      <DataGridCell align="right" className="tabular-nums">{formatPct100(u.successRate * 100)}</DataGridCell>
                      <DataGridCell align="right" className="tabular-nums">{formatInt(u.gpuHours)}</DataGridCell>
                      <DataGridCell className="min-w-40">
                        <span className="flex items-center gap-2">
                          <Meter value={(u.avgUtil ?? 0) / 100} appearance={utilAppearance(u.avgUtil)} label={`${u.label} GPU utilization`} className="w-24" />
                          <span className="text-xs tabular-nums">{formatPct100(u.avgUtil)}</span>
                        </span>
                      </DataGridCell>
                      <DataGridCell align="right" className="tabular-nums">
                        <span className={u.gpuHours && u.wastedGpuHours / u.gpuHours > 0.25 ? 'text-[var(--c3-style-basic-fg-danger)]' : undefined}>{formatInt(u.wastedGpuHours)}</span>
                      </DataGridCell>
                      <DataGridCell align="right" className="tabular-nums">{formatUsd(u.costUsd)}</DataGridCell>
                    </DataGridRow>
                  ))}
                </DataGridBody>
              </DataGrid>
            </div>
          </Container>
        </>
      )}
    </PageFrame>
  );
};

export default History;
