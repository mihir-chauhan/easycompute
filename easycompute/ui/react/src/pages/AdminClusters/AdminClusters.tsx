/*
 * Research Computing — Clusters (/admin/clusters): one card per cluster with capacity, load and billing.
 */

import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Server } from 'lucide-react';

import {
  BILLING_SHORT,
  BillingTag,
  ClearFilters,
  CLUSTER_BG,
  EmptyState,
  ErrorState,
  PageFrame,
  ProgressBar,
  ResultCount,
  SearchBox,
  Segmented,
  Skeleton,
  StatusBadge,
  useC3Data,
  utilTone,
  type Billing,
} from '@/components/app';
import { getUniversityOverview, listClusters } from '@/features/admin/api';
import { compact, hours, num, pct, unitPrice, usd } from '@/features/admin/components';
import type { ComputeCluster, OverviewCluster } from '@/features/admin/types';
import { cn } from '@/lib/utils';

type Row = ComputeCluster & { live?: OverviewCluster };

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-[var(--c3-style-basic-fg-secondary)]">{label}</p>
      <p className="truncate text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export default function AdminClusters() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [billing, setBilling] = useState('ALL');

  const { data, loading, error, reload } = useC3Data<Row[]>(async () => {
    const [clusters, overview] = await Promise.all([listClusters(), getUniversityOverview()]);
    return clusters.map((c) => ({ ...c, live: overview.clusters.find((o) => o.id === c.id) }));
  }, []);

  const rows = useMemo(
    () =>
      (data ?? []).filter(
        (c) =>
          (billing === 'ALL' || c.billing === billing) &&
          (!q || `${c.name} ${c.operator} ${c.description}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [data, q, billing],
  );
  const count = (b: string) => (data ?? []).filter((c) => b === 'ALL' || c.billing === b).length;
  const filtered = Boolean(q) || billing !== 'ALL';

  return (
    <PageFrame
      title="Clusters"
      description="Purdue community clusters, NSF ACCESS and third-party cloud: capacity, load and how each is billed"
      breadcrumbs={[{ label: 'Research Computing', href: '#/admin' }, { label: 'Clusters' }]}
      toolbar={
        <>
          <SearchBox value={q} onChange={setQ} label="Search clusters" placeholder="Search clusters" />
          <Segmented
            label="Billing model"
            value={billing}
            onChange={setBilling}
            options={[
              { value: 'ALL', label: 'All', count: count('ALL') },
              ...(['IN_HOUSE_NODE_SHARE', 'ACCESS_SU', 'THIRD_PARTY_HOURLY'] as Billing[]).map((b) => ({ value: b, label: BILLING_SHORT[b], count: count(b) })),
            ]}
          />
          {filtered ? (
            <ClearFilters
              onClick={() => {
                setQ('');
                setBilling('ALL');
              }}
            />
          ) : null}
          <ResultCount>{`${rows.length} ${rows.length === 1 ? 'cluster' : 'clusters'}`}</ResultCount>
        </>
      }
    >
      {error ? <ErrorState message={`Could not load clusters: ${error}`} onRetry={reload} /> : null}

      {loading && !data ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex flex-col gap-3 rounded-[var(--ec-card-radius)] border border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-primary)] p-5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-56" />
              <Skeleton className="h-2 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 && data ? (
        <EmptyState
          icon={<Server />}
          title={filtered ? 'No clusters match these filters' : 'No clusters configured'}
          action={filtered ? <ClearFilters onClick={() => { setQ(''); setBilling('ALL'); }} /> : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((c) => {
            const live = c.live;
            const hasGpus = (c.totalGpus ?? 0) > 0;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => navigate(`/admin/clusters/${c.id}`)}
                className={cn(
                  'group flex min-w-0 flex-col gap-4 rounded-[var(--ec-card-radius)] border border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-primary)] p-5 text-left shadow-[var(--ec-card-shadow)] transition-colors',
                  'hover:border-[var(--c3-style-basic-border-accent)] focus-visible:ring-[3px] focus-visible:ring-[var(--c3-style-opacity-accent-30)] focus-visible:outline-none',
                  c.status === 'MAINTENANCE' && 'opacity-75',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-[15px] font-semibold">
                      <span aria-hidden className={cn('inline-block size-2.5 rounded-full', CLUSTER_BG[c.id] ?? 'bg-[var(--ec-ink)]')} />
                      {c.name}
                    </p>
                    <p className="mt-0.5 line-clamp-2 min-h-10 text-[13px] text-[var(--c3-style-basic-fg-secondary)]">{c.description ?? c.operator}</p>
                  </div>
                  <StatusBadge kind="clusterStatus" value={c.status} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-[var(--c3-style-basic-fg-secondary)]">GPU utilization</span>
                    <span className="font-medium tabular-nums">
                      {hasGpus && live ? `${pct(live.gpuUtilizationPct)} · ${num(live.busyGpus)}/${num(c.totalGpus)} GPUs` : hasGpus ? `${num(c.totalGpus)} GPUs` : 'CPU only'}
                    </span>
                  </div>
                  <ProgressBar value={hasGpus && live ? live.gpuUtilizationPct / 100 : 0} tone={utilTone(live?.gpuUtilizationPct)} />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <Metric label="Queue / wait" value={live ? `${num(live.queueDepth)} · ${hours(live.avgWaitHours)}` : '—'} />
                  <Metric label="Cores" value={compact(c.totalCores)} />
                  <Metric label="Storage" value={c.storageTb ? `${compact(c.storageTb)} TB` : '—'} />
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-[var(--c3-style-basic-border-border)] pt-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <BillingTag billing={c.billing} />
                    <span className="truncate text-xs text-[var(--c3-style-basic-fg-secondary)] tabular-nums">
                      {c.unitName === 'USD' ? 'on-demand USD' : `${unitPrice(c.usdPerUnit)}/${c.unitName}`} · {usd(live?.costUsd)} spent
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-[var(--c3-style-basic-fg-secondary)] transition-transform group-hover:translate-x-0.5" aria-hidden />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </PageFrame>
  );
}
