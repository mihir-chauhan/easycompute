/*
 * Research Computing — Cluster detail (/admin/clusters/:id): partitions with limits, GPU types, queue, wait, load.
 */

import React, { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Server } from 'lucide-react';

import {
  BillingTag,
  CardGrid,
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
  ToneBadge,
  useC3Data,
  barOption,
  toneColor,
  LiveIndicator,
  useLivePoll,
  useThemeKey,
  utilTone,
  type Column,
  type Tone,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { getClusterDetail, getLiveSnapshot, getUniversityOverview, listPolicies, mergeLiveClusters, mergeLivePartitions } from '@/features/admin/api';
import { compact, hours, num, pct, unitPrice, usd } from '@/features/admin/components';
import type { ComputeCluster, JobLite, OverviewCluster, Partition, Policy } from '@/features/admin/types';

interface Detail {
  cluster: ComputeCluster | null;
  partitions: Partition[];
  liveJobs: JobLite[];
  live?: OverviewCluster;
  policies: Policy[];
}

const waitTone = (h?: number): Tone => (h == null ? 'neutral' : h >= 6 ? 'bad' : h >= 2 ? 'warn' : 'good');

export default function AdminClusterDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const themeKey = useThemeKey();

  // Live: partitions (queue, wait, utilization), live jobs and cluster load every 8 s; policies are static.
  const { data: policyRows } = useC3Data(listPolicies, []);
  const { data, loading, error, reload, updatedAt, live: polling } = useLivePoll<Detail>(
    async () => {
      const [detail, overview, snap] = await Promise.all([getClusterDetail(id), getUniversityOverview(), getLiveSnapshot().catch(() => null)]);
      // Live jobs straight from the snapshot (state, nodes, elapsed, latest GPU util) when it is available.
      const names = new Map(detail.liveJobs.map((j) => [j.id, j]));
      const partName = new Map(detail.partitions.map((p) => [p.id, p.name]));
      const liveJobs = snap?.jobs
        ? snap.jobs
            .filter((j) => j.clusterId === id)
            .map((j) => ({
              id: j.id,
              jobName: j.jobName,
              user: j.user,
              lab: names.get(j.id)?.lab ?? (j.labId ? { id: j.labId } : undefined),
              partition: { id: j.partitionId ?? '', name: (j.partitionId && partName.get(j.partitionId)) || j.partitionId },
              state: j.state,
              allocGpus: j.gpus,
              gpuUtilAvg: j.latest?.gpuUtilPct ?? undefined,
              elapsedHours: j.elapsedHours,
              timelimitHours: j.timelimitHours,
            }))
        : detail.liveJobs;
      return {
        ...detail,
        liveJobs,
        partitions: mergeLivePartitions(detail.partitions, snap),
        live: mergeLiveClusters(overview.clusters, snap).find((c) => c.id === id),
        policies: [],
      };
    },
    [id],
    { intervalMs: 8000 },
  );
  const policies = useMemo(
    () => (policyRows ?? []).filter((p) => p.cluster?.id === id || (data?.partitions ?? []).some((x) => x.id === p.partition?.id)),
    [policyRows, data, id],
  );

  const c = data?.cluster;
  const live = data?.live;
  const parts = useMemo(() => data?.partitions ?? [], [data]);

  const waitOption = useMemo(() => {
    if (!parts.length) return null;
    const sorted = [...parts].sort((a, b) => (b.avgWaitHours ?? 0) - (a.avgWaitHours ?? 0));
    return barOption({
      categories: sorted.map((p) => p.name),
      series: [{ name: 'Average wait', data: sorted.map((p) => +(p.avgWaitHours ?? 0).toFixed(1)), colors: sorted.map((p) => toneColor(waitTone(p.avgWaitHours))) }],
      horizontal: true,
      valueFormat: (v) => `${v} h`,
      barMaxWidth: 16,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts, themeKey]);

  const partitionColumns: Column<Partition>[] = [
    {
      key: 'name',
      header: 'Partition',
      render: (p) => (
        <span className="flex flex-col">
          <span className="font-medium">{c?.name && p.name.startsWith(`${c.name} `) ? p.name.slice(c.name.length + 1) : p.name}</span>
          <span className="font-mono text-xs text-[var(--c3-style-basic-fg-secondary)]">-p {p.slurmPartition ?? p.name}{p.qos && p.qos !== 'normal' ? ` --qos=${p.qos}` : ''}</span>
        </span>
      ),
      sortValue: (p) => p.name,
    },
    { key: 'gpu', header: 'GPU type', render: (p) => p.gpuType?.name ?? p.gpuType?.id ?? <span className="text-[var(--c3-style-basic-fg-secondary)]">CPU only</span>, sortValue: (p) => p.gpuType?.id ?? '' },
    {
      key: 'shape',
      header: 'Nodes × GPUs',
      align: 'right',
      render: (p) => `${p.nodeCount != null ? num(p.nodeCount) : '—'} × ${p.gpusPerNode ?? 0}`,
      sortValue: (p) => (p.nodeCount ?? 0) * (p.gpusPerNode ?? 0),
      hideBelow: 'xl',
    },
    { key: 'wall', header: 'Max walltime', align: 'right', render: (p) => hours(p.maxWalltimeHours), sortValue: (p) => p.maxWalltimeHours },
    {
      key: 'limits',
      header: 'Per-job limits',
      render: (p) => (
        <span className="text-[13px] tabular-nums text-[var(--c3-style-basic-fg-secondary)]">
          <span className="text-[var(--c3-style-basic-fg-primary)]">{num(p.maxGpusPerJob)}</span> GPUs · {num(p.maxNodesPerJob)} nodes · {num(p.maxJobsPerUser)} jobs/user
        </span>
      ),
      sortValue: (p) => p.maxGpusPerJob,
      hideBelow: 'xl',
    },
    {
      key: 'charge',
      header: 'Charge',
      align: 'right',
      render: (p) => (
        <span className="inline-flex items-center gap-1.5">
          {p.preemptible ? <ToneBadge tone="warn">Preemptible</ToneBadge> : null}
          {p.chargeFactor != null ? `${p.chargeFactor}×` : '—'}
        </span>
      ),
      sortValue: (p) => p.chargeFactor,
      hideBelow: 'md',
    },
    { key: 'queue', header: 'Queue', align: 'right', render: (p) => num(p.currentQueueDepth), sortValue: (p) => p.currentQueueDepth },
    {
      key: 'wait',
      header: 'Avg wait',
      align: 'right',
      render: (p) => <span className={waitTone(p.avgWaitHours) === 'bad' ? 'text-[var(--c3-style-basic-fg-danger)]' : undefined}>{hours(p.avgWaitHours)}</span>,
      sortValue: (p) => p.avgWaitHours,
    },
    {
      key: 'util',
      header: 'Utilization',
      render: (p) => (
        <span className="flex w-28 items-center gap-2">
          <ProgressBar value={(p.utilizationPct ?? 0) / 100} tone={utilTone(p.utilizationPct)} className="flex-1" />
          <span className="w-9 text-right tabular-nums">{pct(p.utilizationPct)}</span>
        </span>
      ),
      sortValue: (p) => p.utilizationPct,
    },
  ];

  const jobColumns: Column<JobLite>[] = [
    { key: 'id', header: 'Job', render: (j) => <span className="font-mono text-xs">{j.id}</span>, sortValue: (j) => j.id },
    { key: 'name', header: 'Name', render: (j) => j.jobName ?? '—', className: 'max-w-48 truncate', hideBelow: 'md' },
    { key: 'lab', header: 'Lab', render: (j) => j.lab?.name ?? '—', sortValue: (j) => j.lab?.name, className: 'max-w-48 truncate' },
    { key: 'part', header: 'Partition', render: (j) => j.partition?.name ?? '—', hideBelow: 'md' },
    { key: 'state', header: 'State', render: (j) => <StatusBadge kind="jobState" value={j.state} />, sortValue: (j) => j.state },
    { key: 'gpus', header: 'GPUs', align: 'right', render: (j) => num(j.allocGpus), sortValue: (j) => j.allocGpus },
    {
      key: 'util',
      header: 'GPU util',
      align: 'right',
      render: (j) => (j.gpuUtilAvg == null ? '—' : <span className={utilTone(j.gpuUtilAvg) === 'bad' ? 'text-[var(--c3-style-basic-fg-danger)]' : undefined}>{pct(j.gpuUtilAvg)}</span>),
      sortValue: (j) => j.gpuUtilAvg,
    },
    { key: 'elapsed', header: 'Elapsed / limit', align: 'right', render: (j) => `${hours(j.elapsedHours)} / ${hours(j.timelimitHours)}`, hideBelow: 'sm' },
  ];

  const notFound = !loading && data && !c;

  return (
    <PageFrame
      title={c?.name ?? (loading ? 'Cluster' : id)}
      description={c ? <span className="line-clamp-2" title={c.description}>{`${c.operator ?? ''}${c.description ? ` · ${c.description}` : ''}`}</span> : undefined}
      breadcrumbs={[{ label: 'Research Computing', href: '#/admin' }, { label: 'Clusters', href: '#/admin/clusters' }, { label: c?.name ?? id }]}
      badges={
        c ? (
          <span className="flex items-center gap-2">
            <StatusBadge kind="clusterStatus" value={c.status} />
            <BillingTag billing={c.billing} />
          </span>
        ) : undefined
      }
      actions={
        <>
          <LiveIndicator updatedAt={updatedAt} live={polling} />
          <Button variant="outline" appearance="secondary" size="sm" leadingIcon={<ArrowLeft />} onClick={() => navigate('/admin/clusters')}>
            All clusters
          </Button>
        </>
      }
    >
      {error ? <ErrorState message={`Could not load cluster ${id}: ${error}`} onRetry={reload} /> : null}
      {notFound ? (
        <EmptyState icon={<Server />} title={`No cluster "${id}"`} action={<Button size="sm" onClick={() => navigate('/admin/clusters')}>Back to clusters</Button>} />
      ) : (
        <>
          {loading && !data ? (
            <KpiRowSkeleton />
          ) : c ? (
            <KpiRow>
              <KpiTile
                label="GPU utilization"
                value={(c.totalGpus ?? 0) > 0 && live ? live.gpuUtilizationPct : '—'}
                unit={(c.totalGpus ?? 0) > 0 && live ? '%' : undefined}
                tone={(c.totalGpus ?? 0) > 0 ? utilTone(live?.gpuUtilizationPct) : undefined}
                caption={(c.totalGpus ?? 0) > 0 ? `${num(live?.busyGpus)} of ${num(c.totalGpus)} GPUs busy` : 'CPU-only cluster'}
              />
              <KpiTile
                label="Queue"
                value={num(live?.queueDepth)}
                unit="jobs"
                tone={waitTone(live?.avgWaitHours)}
                caption={`${hours(live?.avgWaitHours)} average wait · ${compact(live?.pendingGpuHours)} GPU-h pending`}
              />
              <KpiTile label="Capacity" value={compact(c.totalCores)} unit="cores" caption={`${num(c.totalNodes)} nodes · ${c.storageTb ? `${compact(c.storageTb)} TB storage` : 'no storage'}`} />
              <KpiTile
                label="Spend to date"
                value={usd(live?.costUsd)}
                caption={c.unitName === 'USD' ? 'on-demand, billed hourly in USD' : `${unitPrice(c.usdPerUnit)} per ${c.unitName} · ${compact(live?.gpuHours)} GPU-h`}
              />
            </KpiRow>
          ) : null}

          <SectionCard flush title="Partitions" subtitle="Slurm partitions with their limits, charge factor, queue and load">
            <DataTable
              columns={partitionColumns}
              rows={parts}
              rowKey={(p) => p.id}
              loading={loading && !data}
              initialSort={{ key: 'util', dir: 'desc' }}
              emptyLabel="No partitions on this cluster"
            />
          </SectionCard>

          <CardGrid layout="halves">
            <MetricChart
              title="Average queue wait by partition"
              subtitle="Green under 2 h, amber 2-6 h, red over 6 h"
              option={waitOption}
              loading={loading && !data}
              empty={Boolean(data) && parts.length === 0}
              heightClass="h-64"
              ariaLabel="Bar chart of average queue wait by partition"
              legend={[
                { label: '< 2 h', swatchClass: 'bg-[var(--ec-good)]' },
                { label: '2-6 h', swatchClass: 'bg-[var(--ec-warn)]' },
                { label: '> 6 h', swatchClass: 'bg-[var(--ec-bad)]' },
              ]}
            />
            <SectionCard flush title="Rules on this cluster" subtitle="Cluster and partition policies checked before every run">
              {policies.length === 0 && data ? (
                <EmptyState title="No cluster-specific rules" hint="University-wide rules still apply." />
              ) : (
                <ul className="divide-y divide-[var(--c3-style-basic-border-border)]">
                  {policies.slice(0, 8).map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => navigate(`/admin/policies?rule=${encodeURIComponent(p.id)}`)} className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-[var(--c3-style-basic-bg-hover)]">
                        <span className="w-16 shrink-0 font-mono text-xs text-[var(--c3-style-basic-fg-secondary)]">{p.id}</span>
                        <span className="min-w-0 flex-1 truncate text-sm">{p.title}</span>
                        <StatusBadge kind="ruleSeverity" value={p.severity} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </CardGrid>

          <SectionCard flush title="Live jobs" subtitle="Simulated running and pending jobs on this cluster">
            <DataTable
              columns={jobColumns}
              rows={data?.liveJobs ?? []}
              rowKey={(j) => j.id}
              loading={loading && !data}
              initialSort={{ key: 'gpus', dir: 'desc' }}
              pageSize={10}
              emptyLabel="No live jobs on this cluster"
            />
          </SectionCard>
        </>
      )}
    </PageFrame>
  );
}
