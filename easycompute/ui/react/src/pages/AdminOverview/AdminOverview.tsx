/*
 * Research Computing — University Overview (/admin).
 */

import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { RotateCw, TrendingUp } from 'lucide-react';

import {
  BILLING_BG,
  BILLING_LABEL,
  BillingTag,
  CardGrid,
  ChartLegend,
  CLUSTER_BG,
  ClusterTag,
  DataTable,
  EmptyState,
  ErrorState,
  KpiRow,
  KpiRowSkeleton,
  KpiTile,
  MetricChart,
  PageFrame,
  ProgressBar,
  SectionCard,
  StatusBadge,
  TableSkeleton,
  ToneBadge,
  barOption,
  clusterColor,
  ecColor,
  lineOption,
  toneColor,
  useC3Data,
  useThemeKey,
  utilTone,
  type Billing,
  type Column,
  type Tone,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { getUniversityOverview } from '@/features/admin/api';
import { Eyebrow, SegmentBar, StatRow, compact, frac, hours, num, pct, usd } from '@/features/admin/components';
import type { OverviewCluster, UniversityOverview } from '@/features/admin/types';

const BILLING_FILL: Record<Billing, string> = {
  IN_HOUSE_NODE_SHARE: 'fill-[var(--ec-billing-in-house)]',
  ACCESS_SU: 'fill-[var(--ec-billing-access)]',
  THIRD_PARTY_HOURLY: 'fill-[var(--ec-billing-third-party)]',
};

const PRESSURE_TONE: Record<string, Tone> = { HIGH: 'bad', MEDIUM: 'warn', LOW: 'good' };
const FAIR_TONE: Record<string, Tone> = { OVER: 'warn', UNDER: 'neutral', BALANCED: 'good' };

const weekLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export default function AdminOverview() {
  const navigate = useNavigate();
  const themeKey = useThemeKey();
  const { data, loading, error, reload } = useC3Data<UniversityOverview>(getUniversityOverview, []);

  const gpuClusters = useMemo(() => (data?.clusters ?? []).filter((c) => c.totalGpus > 0).sort((a, b) => b.gpuUtilizationPct - a.gpuUtilizationPct), [data]);

  const utilOption = useMemo(() => {
    if (!gpuClusters.length) return null;
    return barOption({
      categories: gpuClusters.map((c) => c.name),
      series: [{ name: 'GPU utilization', data: gpuClusters.map((c) => c.gpuUtilizationPct) }],
      itemColors: gpuClusters.map((c) => clusterColor(c.id)),
      horizontal: true,
      max: 100,
      valueFormat: (v) => `${Math.round(v)}%`,
      thresholds: [{ value: 70, label: 'Target 70%' }],
      barMaxWidth: 18,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpuClusters, themeKey]);

  const fairness = useMemo(() => [...(data?.fairness ?? [])].sort((a, b) => b.usageShare - a.usageShare), [data]);
  const fairOption = useMemo(() => {
    if (!fairness.length) return null;
    return barOption({
      categories: fairness.map((f) => f.name),
      series: [
        { name: 'Fair-share target', data: fairness.map((f) => +(f.fairShareTarget * 100).toFixed(1)), color: ecColor('--ec-ink-soft') },
        {
          name: 'Actual usage',
          data: fairness.map((f) => +(f.usageShare * 100).toFixed(1)),
          colors: fairness.map((f) => toneColor(FAIR_TONE[f.status] ?? 'neutral')),
        },
      ],
      horizontal: true,
      valueFormat: (v) => `${v.toFixed(0)}%`,
      barMaxWidth: 10,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fairness, themeKey]);
  const demand = data?.demand.weekly ?? [];
  const forecastFrom = demand.findIndex((w) => w.forecast);
  const demandOption = useMemo(() => {
    if (!demand.length) return null;
    const fi = forecastFrom < 0 ? demand.length : forecastFrom;
    return lineOption({
      x: demand.map((w) => weekLabel(w.week)),
      series: [
        { name: 'GPU-hours', data: demand.map((w, i) => (i < fi ? w.gpuHours : null)), area: true },
        // Forecast starts at the last actual point so the two lines join.
        { name: 'Forecast', data: demand.map((w, i) => (i >= fi - 1 ? w.gpuHours : null)), color: ecColor('--ec-accent'), dashed: true },
      ],
      valueFormat: (v) => compact(v),
      min: 0,
      forecastFrom: fi < demand.length ? fi : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demand, forecastFrom, themeKey]);

  const k = data?.kpis;
  const totalCost = (data?.costByBilling ?? []).reduce((s, b) => s + b.costUsd, 0);

  const clusterColumns: Column<OverviewCluster>[] = [
    { key: 'name', header: 'Cluster', render: (c) => <ClusterTag id={c.id} name={c.name} />, sortValue: (c) => c.name, className: 'font-medium' },
    { key: 'billing', header: 'Billing', render: (c) => <BillingTag billing={c.billing} />, sortValue: (c) => c.billing, hideBelow: 'md' },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge kind="clusterStatus" value={c.status} />, sortValue: (c) => c.status },
    {
      key: 'util',
      header: 'GPU utilization',
      render: (c) =>
        c.totalGpus > 0 ? (
          <span className="flex w-36 items-center gap-2">
            <ProgressBar value={c.gpuUtilizationPct / 100} tone={utilTone(c.gpuUtilizationPct)} className="flex-1" />
            <span className="w-9 text-right tabular-nums">{pct(c.gpuUtilizationPct)}</span>
          </span>
        ) : (
          <span className="text-[var(--c3-style-basic-fg-secondary)]">No GPUs</span>
        ),
      sortValue: (c) => (c.totalGpus > 0 ? c.gpuUtilizationPct : -1),
    },
    { key: 'gpus', header: 'GPUs busy', align: 'right', render: (c) => (c.totalGpus ? `${num(c.busyGpus)} / ${num(c.totalGpus)}` : '—'), sortValue: (c) => c.totalGpus, hideBelow: 'sm' },
    { key: 'queue', header: 'Queue', align: 'right', render: (c) => num(c.queueDepth), sortValue: (c) => c.queueDepth, hideBelow: 'md' },
    { key: 'wait', header: 'Avg wait', align: 'right', render: (c) => hours(c.avgWaitHours), sortValue: (c) => c.avgWaitHours, hideBelow: 'md' },
    { key: 'storage', header: 'Storage', align: 'right', render: (c) => (c.storageTb ? `${compact(c.storageTb)} TB` : '—'), sortValue: (c) => c.storageTb, hideBelow: 'lg' },
    { key: 'cost', header: 'Spend', align: 'right', render: (c) => usd(c.costUsd), sortValue: (c) => c.costUsd },
  ];

  return (
    <PageFrame
      title="University overview"
      description={
        data ? `GPUs, spend and fairness across ${k?.clusters ?? 0} clusters and ${k?.labs ?? 0} labs · updated ${new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : 'GPUs, spend and fairness across Purdue research computing'
      }
      breadcrumbs={[{ label: 'Research Computing' }, { label: 'Overview' }]}
      actions={
        <Button variant="outline" appearance="secondary" size="sm" leadingIcon={<RotateCw />} onClick={reload}>
          Refresh
        </Button>
      }
    >
      {error && !data ? <ErrorState message={`Could not load the university overview: ${error}`} onRetry={reload} /> : null}

      {loading && !data ? (
        <KpiRowSkeleton />
      ) : k ? (
        <KpiRow>
          <KpiTile
            label="GPU utilization"
            value={k.gpuUtilizationPct}
            unit="%"
            tone={utilTone(k.gpuUtilizationPct)}
            caption={`${num(k.busyGpus)} of ${num(k.totalGpus)} GPUs busy right now`}
            help="Busy GPUs / total GPUs across all online clusters, from live jobs and partition utilization."
          />
          <KpiTile
            label="Idle GPU-hours per day"
            value={compact(k.idleGpuHoursPerDay)}
            tone={k.idleGpuHoursPerDay > 500 ? 'warn' : 'neutral'}
            caption={`≈ ${usd(k.idleUsdPerDay)}/day of capacity · ${num(k.idleGpus)} GPUs idle now`}
            help="GPU-hours allocated to jobs but unused (low utilization) plus idle capacity, per day."
          />
          <KpiTile
            label="Spend to date"
            value={usd(k.totalCostUsd)}
            caption={`${compact(k.totalGpuHours)} GPU-hours · ${frac(k.totalGpuHours ? k.wastedGpuHours / k.totalGpuHours : 0)} wasted`}
            help="Shadow-priced cost of all jobs: in-house node shares, ACCESS SUs and third-party cloud, in USD."
          />
          <KpiTile
            label="Open alerts"
            value={num(k.openAlerts)}
            tone={k.criticalAlerts > 0 ? 'bad' : k.openAlerts > 0 ? 'warn' : 'good'}
            caption={`${num(k.criticalAlerts)} critical · ${num(k.runningJobs)} running, ${num(k.pendingJobs)} pending jobs`}
            onClick={() => navigate('/admin/labs')}
          />
        </KpiRow>
      ) : null}

      <CardGrid layout="two-one">
        <MetricChart
          title="GPU utilization by cluster"
          subtitle="Share of each cluster's GPUs busy now; dashed line is the 70% target"
          option={utilOption}
          loading={loading && !data}
          empty={Boolean(data) && gpuClusters.length === 0}
          ariaLabel="Horizontal bar chart of GPU utilization by cluster"
          onItemClick={(name) => {
            const c = gpuClusters.find((x) => x.name === name);
            if (c) navigate(`/admin/clusters/${c.id}`);
          }}
          legend={gpuClusters.map((c) => ({ label: c.name, swatchClass: CLUSTER_BG[c.id] ?? 'bg-[var(--ec-ink)]', value: `${num(c.busyGpus)}/${num(c.totalGpus)}` }))}
        />
        <SectionCard title="Spend by billing model" subtitle="In-house node shares vs NSF ACCESS vs third-party cloud">
          {loading && !data ? (
            <TableSkeleton rows={4} />
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-[28px] leading-9 font-semibold tabular-nums">{usd(totalCost)}</p>
                <p className="text-xs text-[var(--c3-style-basic-fg-secondary)]">all clusters, shadow-priced in USD</p>
              </div>
              <SegmentBar
                segments={(data?.costByBilling ?? []).map((b) => ({ key: b.billing, label: BILLING_LABEL[b.billing], value: b.costUsd, bgClass: BILLING_BG[b.billing], fillClass: BILLING_FILL[b.billing] }))}
              />
              <div className="flex flex-col">
                {(data?.costByBilling ?? []).map((b) => (
                  <StatRow key={b.billing} swatch={BILLING_BG[b.billing]} label={BILLING_LABEL[b.billing]} value={usd(b.costUsd)} sub={frac(b.pct)} />
                ))}
              </div>
              <div className="border-t border-[var(--c3-style-basic-border-border)] pt-3">
                <Eyebrow className="mb-1">By cluster</Eyebrow>
                {[...(data?.clusters ?? [])]
                  .filter((c) => c.costUsd > 0)
                  .sort((a, b) => b.costUsd - a.costUsd)
                  .map((c) => (
                    <StatRow key={c.id} swatch={CLUSTER_BG[c.id]} label={c.name} value={usd(c.costUsd)} sub={`${compact(c.gpuHours)} h`} onClick={() => navigate(`/admin/clusters/${c.id}`)} />
                  ))}
              </div>
            </div>
          )}
        </SectionCard>
      </CardGrid>

      <CardGrid layout="halves">
        <MetricChart
          title="Fair share: target vs actual usage"
          subtitle="Share of GPU-hours by lab against its fair-share target"
          option={fairOption}
          loading={loading && !data}
          heightClass="h-80"
          ariaLabel="Grouped bar chart of fair-share target and actual usage per lab"
          legend={[
            { label: 'Target', swatchClass: 'bg-[var(--ec-ink-soft)]' },
            { label: 'Balanced', swatchClass: 'bg-[var(--ec-good)]' },
            { label: 'Over target (>125%)', swatchClass: 'bg-[var(--ec-warn)]' },
            { label: 'Under target (<75%)', swatchClass: 'bg-[var(--ec-neutral)]' },
          ]}
          onItemClick={() => navigate('/admin/labs')}
        />
        <SectionCard title="Idle and unused GPUs" subtitle="Capacity that is allocated or available but not doing work">
          {loading && !data ? (
            <TableSkeleton rows={6} />
          ) : data ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-xl font-semibold tabular-nums">{num(data.idle.idleGpusNow)}</p>
                  <p className="text-xs text-[var(--c3-style-basic-fg-secondary)]">GPUs idle now</p>
                </div>
                <div>
                  <p className="text-xl font-semibold tabular-nums">{compact(data.idle.idleGpuHoursPerDay)}</p>
                  <p className="text-xs text-[var(--c3-style-basic-fg-secondary)]">idle GPU-h / day</p>
                </div>
                <div>
                  <p className="text-xl font-semibold tabular-nums">{compact(data.idle.wastedGpuHours)}</p>
                  <p className="text-xs text-[var(--c3-style-basic-fg-secondary)]">wasted GPU-h (history)</p>
                </div>
              </div>
              <div>
                <Eyebrow className="mb-1">Top offenders · wasted GPU-hours</Eyebrow>
                {data.idle.topWasteLabs.slice(0, 5).map((l) => (
                  <StatRow
                    key={l.labId}
                    label={l.name}
                    value={compact(l.wastedGpuHours)}
                    sub={<span className={l.wastePct >= 0.25 ? 'text-[var(--c3-style-basic-fg-danger)]' : undefined}>{frac(l.wastePct)}</span>}
                    onClick={() => navigate('/admin/labs')}
                  />
                ))}
              </div>
              {data.idle.idleLiveJobs.length > 0 ? (
                <div>
                  <Eyebrow className="mb-1">Running jobs holding idle GPUs</Eyebrow>
                  {data.idle.idleLiveJobs.slice(0, 4).map((j) => (
                    <StatRow
                      key={j.jobId}
                      label={
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-xs">{j.jobId}</span>
                          <span className="text-[var(--c3-style-basic-fg-secondary)]">{j.user}</span>
                        </span>
                      }
                      value={`${j.gpus} GPU · ${pct(j.gpuUtilPct)}`}
                      sub={<span className="text-[var(--c3-style-basic-fg-warning)]">{hours(j.idleMinutes / 60)}</span>}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </SectionCard>
      </CardGrid>

      <CardGrid layout="two-one">
        <MetricChart
          title="GPU demand and forecast"
          subtitle={data ? `Weekly GPU-hours across all clusters · trend ${data.demand.trendPctPerWeek >= 0 ? '+' : ''}${data.demand.trendPctPerWeek.toFixed(1)}% per week` : 'Weekly GPU-hours across all clusters'}
          option={demandOption}
          loading={loading && !data}
          ariaLabel="Line chart of weekly GPU-hours with a 4-week forecast"
          legend={[
            { label: 'Actual GPU-hours', swatchClass: 'bg-[var(--ec-ink)]' },
            { label: 'Forecast', swatchClass: '', dashed: true },
          ]}
        />
        <SectionCard title="Where more resources are needed" subtitle="Partitions under pressure, from queue depth, wait and forecast">
          {loading && !data ? (
            <TableSkeleton rows={4} />
          ) : (data?.demand.partitions ?? []).length === 0 ? (
            <EmptyState icon={<TrendingUp />} title="No partition under pressure" />
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--c3-style-basic-border-border)]">
              {[...(data?.demand.partitions ?? [])]
                .sort((a, b) => ['HIGH', 'MEDIUM', 'LOW'].indexOf(a.pressure) - ['HIGH', 'MEDIUM', 'LOW'].indexOf(b.pressure))
                .slice(0, 4)
                .map((d) => (
                  <li key={d.partitionId} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-2">
                      <button type="button" className="min-w-0 text-left text-sm font-medium hover:underline" onClick={() => navigate(`/admin/clusters/${d.clusterId}`)}>
                        <ClusterTag id={d.clusterId} name={`${data?.clusters.find((c) => c.id === d.clusterId)?.name ?? d.clusterId} · ${d.name}`} />
                      </button>
                      <ToneBadge tone={PRESSURE_TONE[d.pressure] ?? 'neutral'}>{d.pressure.charAt(0) + d.pressure.slice(1).toLowerCase()}</ToneBadge>
                    </div>
                    <p className="text-xs tabular-nums text-[var(--c3-style-basic-fg-secondary)]">
                      {d.gpuTypeId ?? 'CPU'} · {pct(d.utilizationPct)} busy → {pct(d.forecastUtilizationPct)} forecast · {num(d.queueDepth)} queued · {hours(d.avgWaitHours)} wait
                    </p>
                    {d.recommendation ? <p className="text-[13px] text-[var(--c3-style-basic-fg-primary)]">{d.recommendation}</p> : null}
                  </li>
                ))}
            </ul>
          )}
        </SectionCard>
      </CardGrid>

      <SectionCard
        flush
        title="Clusters and storage"
        subtitle="Capacity, load, wait and spend per cluster; select a row for partitions"
        actions={
          <Button variant="ghost" appearance="secondary" size="sm" onClick={() => navigate('/admin/clusters')}>
            All clusters
          </Button>
        }
      >
        <DataTable
          columns={clusterColumns}
          rows={data?.clusters ?? []}
          rowKey={(c) => c.id}
          loading={loading && !data}
          onRowClick={(c) => navigate(`/admin/clusters/${c.id}`)}
          emptyLabel="No clusters configured"
        />
        {data ? (
          <div className="border-t border-[var(--c3-style-basic-border-border)] px-5 py-3">
            <ChartLegend
              items={[
                { label: 'Total GPUs', swatchClass: 'bg-[var(--ec-ink)]', value: num(k?.totalGpus) },
                { label: 'Total cores', swatchClass: 'bg-[var(--ec-ink-soft)]', value: compact(k?.totalCores) },
                { label: 'Storage', swatchClass: 'bg-[var(--ec-accent)]', value: `${compact(k?.storageTb)} TB` },
              ]}
            />
          </div>
        ) : null}
      </SectionCard>
    </PageFrame>
  );
}
