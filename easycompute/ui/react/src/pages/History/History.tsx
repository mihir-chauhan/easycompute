/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Lightbulb, Rocket, Settings2 } from 'lucide-react';

import {
  barOption,
  burnTone,
  DataTable,
  EmptyState,
  ErrorState,
  KpiRow,
  KpiRowSkeleton,
  KpiTile,
  lineOption,
  MetricChart,
  PageFrame,
  ProgressBar,
  SectionCard,
  Segmented,
  Sparkline,
  TableSkeleton,
  ToneBadge,
  TONE_BG,
  toneColor,
  useThemeKey,
  utilTone,
  type Column,
  type Tone,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { fetchHistoryJobs, getLabSummary } from '@/features/lab/api';
import { CliHint, HeadNote, Mono, muted } from '@/features/lab/components';
import { formatInt, formatPct100, formatUsd, titleCase } from '@/features/lab/format';
import { gpuHours, type GroupStats, groupStats, histogram, wastedGpuHours, wastePatterns, weekStart } from '@/features/lab/insights';
import type { SummaryAllocation } from '@/features/lab/types';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { useLoad } from '@/features/lab/useLoad';
import { formatDate, formatShortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const PERIODS = { '30': 30, '90': 90, all: Infinity } as const;
type Period = keyof typeof PERIODS;
const MEMBER_TONES: Tone[] = ['good', 'info', 'pink', 'warn'];

const elapsedFrac = (a: SummaryAllocation): number | null => {
  if (!a.startDate || !a.endDate) return null;
  const s = new Date(a.startDate).getTime();
  const e = new Date(a.endDate).getTime();
  return e > s ? Math.min(1, Math.max(0, (Date.now() - s) / (e - s))) : null;
};

/** Weeks that have fully elapsed (the current ISO week is partial and would understate the burn rate). */
const completeWeeks = <T extends { week: string }>(weekly: T[], asOf?: string): T[] => {
  const now = asOf ? new Date(asOf).getTime() : Date.now();
  return weekly.filter((w) => new Date(w.week).getTime() + 7 * 86400000 <= now);
};

const History: React.FC = () => {
  const navigate = useNavigate();
  const themeKey = useThemeKey();
  const { lab, labId, error: labError } = useCurrentLab();
  const [params, setParams] = useSearchParams();
  const period: Period = (Object.keys(PERIODS) as Period[]).find((p) => p === params.get('period')) ?? '90';

  const summary = useLoad(() => (labId ? getLabSummary(labId) : null), [labId]);
  const res = useLoad(() => (labId ? fetchHistoryJobs(labId) : null), [labId]);
  const s = summary.data;
  const allocations = s?.allocations ?? [];

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
    const gh = gpuJobs.reduce((n, j) => n + gpuHours(j), 0);
    const wasted = gpuJobs.reduce((n, j) => n + wastedGpuHours(j), 0);
    const cost = jobs.reduce((n, j) => n + (j.costUsd ?? 0), 0);
    const utilGh = gpuJobs.filter((j) => j.gpuUtilAvg != null).reduce((n, j) => n + gpuHours(j), 0);
    const util = utilGh ? gpuJobs.reduce((n, j) => n + (j.gpuUtilAvg ?? 0) * gpuHours(j), 0) / utilGh : null;
    const success = jobs.length ? jobs.filter((j) => j.state === 'COMPLETED').length / jobs.length : 0;
    const usdPerGh = gh ? gpuJobs.reduce((n, j) => n + (j.costUsd ?? 0), 0) / gh : 0;
    return { gh, wasted, cost, util, success, wastedUsd: wasted * usdPerGh };
  }, [jobs, gpuJobs]);

  const patterns = useMemo(() => wastePatterns(gpuJobs), [gpuJobs]);
  const users = useMemo(() => groupStats(jobs, (j) => j.user ?? 'unknown'), [jobs]);

  /** Weekly GPU-hours per member (top 3 + others), for the stacked chart and the member sparklines. */
  const memberWeeks = useMemo(() => {
    const top = users.slice(0, 3).map((u) => u.key);
    const by = new Map<string, Record<string, number>>();
    gpuJobs.forEach((j) => {
      const at = j.endTime ?? j.startTime;
      if (!at) return;
      const w = weekStart(at);
      const k = top.includes(j.user ?? '') ? (j.user as string) : 'others';
      const row = by.get(w) ?? {};
      row[k] = (row[k] ?? 0) + gpuHours(j);
      row[`u:${j.user}`] = (row[`u:${j.user}`] ?? 0) + gpuHours(j);
      by.set(w, row);
    });
    const weeks = [...by.keys()].sort();
    return { top, weeks, by };
  }, [gpuJobs, users]);

  const memberOption = useMemo(() => {
    const { top, weeks, by } = memberWeeks;
    if (!weeks.length) return null;
    return barOption({
      categories: weeks.map((w) => formatShortDate(w)),
      series: [...top, 'others'].map((k, i) => ({ name: k, stack: 'm', color: toneColor(MEMBER_TONES[i]), data: weeks.map((w) => Math.round(by.get(w)?.[k] ?? 0)) })),
      valueFormat: (v) => formatInt(v),
      barMaxWidth: 22,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberWeeks, themeKey]);

  /** Cumulative spend by week with a straight-line forecast at the last 4 weeks' pace. */
  const forecast = useMemo(() => {
    const weekly = s?.weekly ?? [];
    if (weekly.length < 2) return null;
    let cum = 0;
    const actual = weekly.map((w) => (cum += w.costUsd));
    const full = completeWeeks(weekly, s?.asOf);
    const pace = full.length ? full.slice(-4).reduce((n, w) => n + w.costUsd, 0) / Math.min(4, full.length) : 0;
    const budget = cum + allocations.reduce((n, a) => n + (a.remainingUsd ?? 0), 0);
    const ahead = 12;
    const fx = Array.from({ length: ahead }, (_, i) => cum + pace * (i + 1));
    const lastWeek = new Date(weekly[weekly.length - 1].week);
    const x = [
      ...weekly.map((w) => formatShortDate(w.week)),
      ...fx.map((_, i) => formatShortDate(new Date(lastWeek.getTime() + (i + 1) * 7 * 86400000).toISOString())),
    ];
    const outWeek = fx.findIndex((v) => v > budget);
    return {
      pace,
      budget,
      spent: cum,
      outLabel: outWeek >= 0 ? x[weekly.length + outWeek] : null,
      option: lineOption({
        x,
        series: [
          { name: 'Charged', data: [...actual, ...fx.map(() => null)], area: true, color: toneColor('good') },
          { name: 'Current pace', data: [...actual.map((v, i) => (i === actual.length - 1 ? v : null)), ...fx], dashed: true, color: toneColor('bad') },
        ],
        valueFormat: (v) => formatUsd(v),
        min: 0,
        max: budget > 0 ? Math.ceil((Math.max(budget, fx[fx.length - 1]) * 1.08) / 1000) * 1000 : undefined,
        thresholds: budget > 0 ? [{ value: Math.round(budget), label: `All allocations ${formatUsd(budget)}`, tone: 'bad' }] : [],
        forecastFrom: weekly.length,
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, themeKey]);

  const utilOption = useMemo(() => {
    const bins = histogram(gpuJobs.filter((j) => j.gpuUtilAvg != null).map((j) => j.gpuUtilAvg as number));
    return barOption({
      categories: bins.map((b) => b.label),
      series: [{ name: 'Jobs', data: bins.map((b) => b.count) }],
      itemColors: bins.map((b) => toneColor(utilTone(b.lo + 5))),
      valueFormat: (v) => formatInt(v),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpuJobs, themeKey]);

  const allocColumns: Column<SummaryAllocation>[] = [
    {
      key: 'a',
      header: 'Allocation',
      render: (a) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-[var(--c3-style-basic-fg-primary)]">{a.grantName ?? a.name ?? a.id}</span>
          <span className={cn('truncate text-xs', muted)}>{titleCase(a.source ?? '')}</span>
        </div>
      ),
    },
    { key: 'c', header: 'Cluster', hideBelow: 'md', render: (a) => a.clusterName ?? a.clusterId },
    { key: 'u', header: 'Unit', hideBelow: 'lg', render: (a) => a.unitName },
    { key: 'g', header: 'Granted', align: 'right', render: (a) => formatInt(a.totalUnits) },
    { key: 'used', header: 'Used', align: 'right', hideBelow: 'sm', render: (a) => formatInt(a.usedUnits) },
    {
      key: 'r',
      header: 'Remaining',
      align: 'right',
      sortValue: (a) => a.pctUsed ?? 0,
      render: (a) => (
        <div className="flex w-28 flex-col items-end gap-1">
          <span>{formatInt(a.remainingUnits)}</span>
          <ProgressBar value={a.pctUsed ?? 0} tone={burnTone(a.pctUsed ?? 0, elapsedFrac(a))} marker={elapsedFrac(a)} ariaLabel="Used vs period elapsed" />
        </div>
      ),
    },
    {
      key: 'e',
      header: 'Ends / runs out',
      render: (a) =>
        a.runsOutBeforeEnd && a.projectedRunOut ? (
          <ToneBadge tone="bad">{`Runs out ${formatShortDate(a.projectedRunOut)}`}</ToneBadge>
        ) : (a.daysLeft ?? 999) <= 45 ? (
          <ToneBadge tone="warn">{formatDate(a.endDate)}</ToneBadge>
        ) : (
          formatDate(a.endDate)
        ),
    },
    { key: 'b', header: 'Burn / day', align: 'right', hideBelow: 'lg', render: (a) => <Mono>{`${formatInt(a.burnPerDay)} ${a.unitName ?? ''}`}</Mono> },
  ];

  const memberColumns: Column<GroupStats>[] = [
    { key: 'user', header: 'Member', sortValue: (u) => u.label, render: (u) => <span className="font-mono text-[var(--c3-style-basic-fg-primary)]">{u.label}</span> },
    { key: 'gh', header: 'GPU-h', align: 'right', sortValue: (u) => u.gpuHours, render: (u) => formatInt(u.gpuHours) },
    {
      key: 'trend',
      header: 'Trend',
      hideBelow: 'sm',
      render: (u) => (
        <span className="block w-24">
          <Sparkline values={memberWeeks.weeks.map((w) => memberWeeks.by.get(w)?.[`u:${u.key}`] ?? 0)} tone={MEMBER_TONES[Math.min(3, users.indexOf(u))]} ariaLabel={`${u.label} weekly GPU-hours`} />
        </span>
      ),
    },
    {
      key: 'util',
      header: 'Util',
      align: 'right',
      sortValue: (u) => u.avgUtil ?? -1,
      render: (u) => <span className={cn(u.avgUtil != null && utilTone(u.avgUtil) === 'bad' && 'text-[var(--c3-style-basic-fg-danger)]')}>{formatPct100(u.avgUtil)}</span>,
    },
  ];

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

  const error = labError ?? summary.error ?? res.error;
  const wastedShare = totals.gh ? totals.wasted / totals.gh : 0;
  const tiles = [...allocations].sort((a, b) => (b.remainingUsd ?? 0) - (a.remainingUsd ?? 0)).slice(0, 2);
  const fullWeeks = completeWeeks(s?.weekly ?? [], s?.asOf);
  const lastWeekCost = fullWeeks.at(-1)?.costUsd;

  return (
    <PageFrame
      title={
        <span>
          {lab?.name ? <span className={muted}>{`${lab.name} / `}</span> : null}
          Allocations &amp; usage
        </span>
      }
      description="Where the lab's compute money goes, how fast it burns, and where GPU-hours were wasted."
      actions={
        <Segmented
          label="Period"
          value={period}
          onChange={setPeriod}
          options={[
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
            { value: 'all', label: 'All' },
          ]}
        />
      }
    >
      {error && <ErrorState message={`Could not load usage: ${error}`} onRetry={() => { summary.reload(); res.reload(); }} />}

      {s && (
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-lg font-medium text-[var(--c3-style-basic-fg-primary)]">{`Total charged: ${formatUsd(s.kpis.costUsd)}`}</span>
          <span className={cn('text-sm', muted)}>{`${formatInt(s.kpis.jobs)} jobs · ${formatInt(s.kpis.gpuHours)} GPU-hours`}</span>
        </div>
      )}
      <CliHint command={`easycompute usage report --lab ${labId ?? '<lab>'} --period ${period === 'all' ? 'all' : `${period}d`} --csv > report.csv`} />

      {!s && !error ? (
        <KpiRowSkeleton />
      ) : s ? (
        <KpiRow>
          {tiles.map((a) => (
            <KpiTile
              key={a.id}
              label={`${a.grantName ?? a.name} · ${a.clusterName ?? a.clusterId}`}
              value={(a.unitName ?? '').toUpperCase() === 'USD' ? formatUsd(a.remainingUnits) : formatInt(a.remainingUnits)}
              unit={`of ${formatInt(a.totalUnits)} ${(a.unitName ?? '').toUpperCase() === 'USD' ? '' : (a.unitName ?? '')}`.trim()}
              tone={burnTone(a.pctUsed ?? 0, elapsedFrac(a))}
              caption={a.runsOutBeforeEnd && a.projectedRunOut ? `Runs out ${formatShortDate(a.projectedRunOut)}, before it ends` : `${formatPct100((a.pctUsed ?? 0) * 100)} used · ends ${formatShortDate(a.endDate)}`}
            />
          ))}
          <KpiTile
            label="Burn rate"
            value={formatUsd(lastWeekCost ?? forecast?.pace)}
            unit="/ week"
            caption={forecast && lastWeekCost != null ? `Last full week · ${lastWeekCost >= forecast.pace ? '+' : ''}${formatPct100(((lastWeekCost - forecast.pace) / (forecast.pace || 1)) * 100)} vs 4-week average` : 'Last full week'}
          />
          <KpiTile label="GPU-hours (30 d)" value={formatInt(s.kpis.gpuHours30d)} caption={`${formatUsd(s.kpis.costUsd30d)} charged · ${formatPct100(s.kpis.avgGpuUtil)} avg GPU util`} />
          {tiles.length < 2 && (
            <KpiTile
              label="Wasted GPU-hours"
              value={formatInt(s.kpis.wastedGpuHours)}
              tone={(s.kpis.wastePct ?? 0) > 0.25 ? 'bad' : (s.kpis.wastePct ?? 0) > 0.1 ? 'warn' : 'good'}
              caption={`${formatPct100((s.kpis.wastePct ?? 0) * 100)} of all GPU time · ${formatInt(s.kpis.failedJobs)} failed jobs`}
            />
          )}
        </KpiRow>
      ) : null}

      <MetricChart
        title="Spend forecast"
        subtitle={forecast ? (forecast.outLabel ? `At the current pace (${formatUsd(forecast.pace)}/week) every allocation is used up by ${forecast.outLabel}` : `At the current pace (${formatUsd(forecast.pace)}/week) the allocations last past the next 12 weeks`) : 'Cumulative charged across all allocations'}
        option={forecast?.option ?? null}
        loading={!s && !summary.error}
        error={summary.error}
        empty={Boolean(s) && !forecast}
        emptyLabel="Not enough weekly history yet"
        legend={[
          { label: 'Charged', swatchClass: TONE_BG.good },
          { label: 'Current pace', swatchClass: TONE_BG.bad, dashed: true },
        ]}
        ariaLabel="Spend forecast"
        footer={
          forecast?.outLabel ? (
            <div className="flex flex-wrap items-center gap-3 rounded-[var(--ec-card-radius,8px)] border border-[var(--c3-style-basic-border-accent)] bg-[var(--c3-style-basic-bg-success)] px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">Stretch the budget</div>
                <div className={cn('text-[13px]', muted)}>Move sweeps to preemptible QOS (0.25× charge), spend expiring ACCESS SUs first and turn on idle-GPU guardrails.</div>
              </div>
              <Button size="sm" onClick={() => navigate('/guardrails')}>
                Review guardrails
              </Button>
            </div>
          ) : undefined
        }
      />

      <SectionCard flush title="Allocations" actions={<HeadNote>Bar marker = share of the allocation period elapsed</HeadNote>}>
        <DataTable columns={allocColumns} rows={allocations} rowKey={(a) => a.id} loading={!s && !summary.error} emptyLabel="No allocations recorded" />
      </SectionCard>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <MetricChart
          title="Weekly GPU-hours by member"
          option={memberOption}
          loading={!res.data && !res.error}
          error={res.error}
          empty={Boolean(res.data) && !memberOption}
          ariaLabel="Weekly GPU-hours by member"
          legend={[...memberWeeks.top, 'others'].map((k, i) => ({ label: k, swatchClass: TONE_BG[MEMBER_TONES[i]] }))}
        />
        <SectionCard flush title="Members" actions={<HeadNote>{period === 'all' ? 'All time' : `Last ${period} days`}</HeadNote>}>
          <DataTable columns={memberColumns} rows={users} rowKey={(u) => u.key} loading={!res.data && !res.error} initialSort={{ key: 'gh', dir: 'desc' }} pageSize={8} emptyLabel="No jobs" />
        </SectionCard>
      </div>

      {!res.data && !res.error ? (
        <TableSkeleton rows={4} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <SectionCard
            title="Where GPU-hours were wasted"
            actions={<ToneBadge tone={wastedShare > 0.25 ? 'bad' : wastedShare > 0.1 ? 'warn' : 'good'}>{`${formatInt(totals.wasted)} GPU-h · ${formatPct100(wastedShare * 100)}`}</ToneBadge>}
          >
            {patterns.length === 0 && !(s?.recommendations ?? []).length ? (
              <EmptyState title="No waste patterns detected" hint="Every finished GPU job used its GPUs well." />
            ) : (
              <ul className="flex flex-col">
                {patterns.map((p) => (
                  <li key={p.key} className="flex flex-col gap-2 border-b border-[var(--c3-style-basic-border-border)] py-3 first:pt-0 last:border-b-0 last:pb-0">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">{p.label}</span>
                      <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
                        <span className="text-sm font-semibold">{`${formatInt(p.wastedGpuHours)} GPU-h`}</span>
                        <span className={cn('w-16 text-right text-xs', muted)}>{formatUsd(p.wastedUsd)}</span>
                      </span>
                    </span>
                    <ProgressBar value={patterns[0].wastedGpuHours ? p.wastedGpuHours / patterns[0].wastedGpuHours : 0} tone="bad" ariaLabel={`${p.label} share`} />
                    <span className={cn('flex items-start gap-2 text-[13px]', muted)}>
                      <Lightbulb className="mt-0.5 size-4 shrink-0 text-[var(--c3-style-basic-fg-warning)]" aria-hidden />
                      <span>
                        <span className="text-[var(--c3-style-basic-fg-primary)]">{`${formatInt(p.jobs)} job${p.jobs === 1 ? '' : 's'}. `}</span>
                        {p.recommendation}
                      </span>
                    </span>
                  </li>
                ))}
                {(s?.recommendations ?? []).slice(0, 4).map((r) => (
                  <li key={`${r.kind}-${r.title}`} className="flex flex-col gap-1 border-b border-[var(--c3-style-basic-border-border)] py-3 last:border-b-0 last:pb-0">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">{r.title}</span>
                      {r.impact && <ToneBadge tone="good">{r.impact}</ToneBadge>}
                    </span>
                    {r.detail && <span className={cn('text-[13px]', muted)}>{r.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--c3-style-basic-border-border)] pt-4">
              <Button variant="outline" appearance="secondary" size="sm" leadingIcon={<Settings2 />} onClick={() => navigate('/guardrails')}>
                Tune guardrails
              </Button>
              <Button variant="ghost" appearance="secondary" size="sm" leadingIcon={<Rocket />} onClick={() => navigate('/plan')}>
                Plan the next run right-sized
              </Button>
            </div>
          </SectionCard>

          <MetricChart
            title="GPU utilization of finished jobs"
            subtitle={`${formatPct100(totals.util)} GPU-hour weighted · ${formatPct100(totals.success * 100)} of ${formatInt(jobs.length)} jobs completed`}
            option={utilOption}
            empty={gpuJobs.length === 0}
            emptyLabel="No finished GPU jobs in this period"
            ariaLabel="GPU utilization distribution"
            legend={[
              { label: '≥ 70%', swatchClass: TONE_BG.good },
              { label: '40-70%', swatchClass: TONE_BG.warn },
              { label: '< 40%', swatchClass: TONE_BG.bad },
            ]}
          />
        </div>
      )}
    </PageFrame>
  );
};

export default History;
