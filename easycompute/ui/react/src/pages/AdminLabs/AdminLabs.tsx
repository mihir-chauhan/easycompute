/*
 * Research Computing — Labs (/admin/labs): allocation burn, efficiency, fair share and alerts per lab, with a
 * jump into that lab's own view.
 */

import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';

import {
  BudgetBurn,
  ClearFilters,
  DataTable,
  ErrorState,
  KpiRow,
  KpiRowSkeleton,
  KpiTile,
  ModelComputing,
  ModelProvenance,
  PageFrame,
  ResultCount,
  SearchBox,
  SectionCard,
  Segmented,
  ToneBadge,
  TONE_TEXT,
  burnTone,
  useAppShell,
  useC3Data,
  utilTone,
  type Column,
  type Tone,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { getUniversityOverview, listLabSummaries } from '@/features/admin/api';
import { compact, frac, num, pct, usd } from '@/features/admin/components';
import type { FairnessRow, LabSummaryLite } from '@/features/admin/types';

interface LabRow {
  id: string;
  name: string;
  piName?: string;
  department?: string;
  used: number;
  elapsed: number | null;
  burn: Tone;
  runsOut: boolean;
  avgGpuUtil: number;
  wastePct: number;
  gpuHours30d: number;
  costUsd30d: number;
  openAlerts: number;
  criticalAlerts: number;
  liveJobs: number;
  fair?: FairnessRow;
}

const elapsedOf = (start?: string, end?: string): number | null => {
  if (!start || !end) return null;
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
  return Math.max(0, Math.min(1, (Date.now() - s) / (e - s)));
};

const FAIR_TONE: Record<string, Tone> = { OVER: 'warn', UNDER: 'info', BALANCED: 'good' };
const FAIR_LABEL: Record<string, string> = { OVER: 'Over share', UNDER: 'Under share', BALANCED: 'Balanced' };

function toRow(s: LabSummaryLite, fairness: FairnessRow[]): LabRow {
  // Allocations are in different units (SU, GPU-hour, USD), so burn is the mean used fraction across them.
  const allocs = s.allocations ?? [];
  const used = allocs.reduce((a, x) => a + (x.totalUnits ? x.usedUnits / x.totalUnits : 0), 0);
  const usedFrac = allocs.length ? used / allocs.length : 0;
  const elapsedList = allocs.map((a) => elapsedOf(a.startDate, a.endDate)).filter((v): v is number => v != null);
  const elapsed = elapsedList.length ? elapsedList.reduce((a, b) => a + b, 0) / elapsedList.length : null;
  return {
    id: s.lab.id,
    name: s.lab.name,
    piName: s.lab.piName,
    department: s.lab.department,
    used: usedFrac,
    elapsed,
    burn: allocs.length ? burnTone(usedFrac, elapsed) : 'neutral',
    runsOut: allocs.some((a) => a.runsOutBeforeEnd),
    avgGpuUtil: s.kpis.avgGpuUtil,
    wastePct: s.kpis.wastePct,
    gpuHours30d: s.kpis.gpuHours30d,
    costUsd30d: s.kpis.costUsd30d,
    openAlerts: s.kpis.openAlerts,
    criticalAlerts: s.kpis.criticalAlerts,
    liveJobs: s.kpis.liveJobs,
    fair: fairness.find((f) => f.labId === s.lab.id),
  };
}

export default function AdminLabs() {
  const navigate = useNavigate();
  const { setLabId } = useAppShell();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('ALL');

  const { data, loading, error, reload } = useC3Data<LabRow[]>(async () => {
    const [summaries, overview] = await Promise.all([listLabSummaries(), getUniversityOverview()]);
    return summaries.map((s) => toRow(s, overview.fairness));
  }, []);

  const all = useMemo(() => data ?? [], [data]);
  const matches = (r: LabRow, f: string) =>
    f === 'ALL' ||
    (f === 'AT_RISK' && (r.burn === 'bad' || r.burn === 'warn' || r.runsOut)) ||
    (f === 'ALERTS' && r.openAlerts > 0) ||
    (f === 'INEFFICIENT' && utilTone(r.avgGpuUtil) !== 'good');
  const rows = useMemo(
    () =>
      all.filter(
        (r) => matches(r, filter) && (!q || `${r.name} ${r.piName} ${r.department}`.toLowerCase().includes(q.toLowerCase())),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, filter, q],
  );
  const filtered = filter !== 'ALL' || Boolean(q);
  const clear = () => {
    setQ('');
    setFilter('ALL');
  };

  const openLab = (id: string) => {
    setLabId(id);
    navigate('/');
  };

  const columns: Column<LabRow>[] = [
    {
      key: 'name',
      header: 'Lab',
      render: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{r.name}</span>
          <span className="truncate text-xs text-[var(--c3-style-basic-fg-secondary)]">{[r.piName && `PI ${r.piName}`, r.department].filter(Boolean).join(' · ')}</span>
        </span>
      ),
      sortValue: (r) => r.name,
      className: 'max-w-64',
    },
    {
      key: 'burn',
      header: 'Allocation burn',
      render: (r) => (
        <span className="flex w-40 flex-col gap-1">
          <BudgetBurn used={r.used} total={1} elapsed={r.elapsed} compact />
          <span className="flex justify-between text-xs tabular-nums">
            <span className={TONE_TEXT[r.burn === 'neutral' ? 'neutral' : r.burn]}>{frac(r.used)} used</span>
            <span className="text-[var(--c3-style-basic-fg-secondary)]">{r.elapsed != null ? `${frac(r.elapsed)} of period` : ''}</span>
          </span>
        </span>
      ),
      sortValue: (r) => r.used - (r.elapsed ?? 0),
    },
    {
      key: 'util',
      header: 'Avg GPU util',
      align: 'right',
      render: (r) => <span className={TONE_TEXT[utilTone(r.avgGpuUtil) === 'good' ? 'neutral' : utilTone(r.avgGpuUtil)]}>{pct(r.avgGpuUtil)}</span>,
      sortValue: (r) => r.avgGpuUtil,
    },
    {
      key: 'waste',
      header: 'Wasted',
      align: 'right',
      render: (r) => <span className={r.wastePct >= 0.25 ? 'text-[var(--c3-style-basic-fg-danger)]' : undefined}>{frac(r.wastePct)}</span>,
      sortValue: (r) => r.wastePct,
      hideBelow: 'md',
    },
    { key: 'gpuh', header: 'GPU-h (30 d)', align: 'right', render: (r) => compact(r.gpuHours30d), sortValue: (r) => r.gpuHours30d, hideBelow: 'lg' },
    { key: 'cost', header: 'Spend (30 d)', align: 'right', render: (r) => usd(r.costUsd30d), sortValue: (r) => r.costUsd30d, hideBelow: 'lg' },
    {
      key: 'fair',
      header: 'Fair share',
      render: (r) =>
        r.fair ? (
          <span className="flex items-center gap-2">
            <ToneBadge tone={FAIR_TONE[r.fair.status] ?? 'neutral'}>{FAIR_LABEL[r.fair.status] ?? r.fair.status}</ToneBadge>
            <span className="text-xs tabular-nums text-[var(--c3-style-basic-fg-secondary)]">
              {frac(r.fair.usageShare)} / {frac(r.fair.fairShareTarget)}
            </span>
          </span>
        ) : (
          '—'
        ),
      sortValue: (r) => r.fair?.ratio,
      hideBelow: 'lg',
    },
    {
      key: 'alerts',
      header: 'Alerts',
      render: (r) =>
        r.openAlerts === 0 ? (
          <span className="text-[var(--c3-style-basic-fg-secondary)]">None</span>
        ) : (
          <ToneBadge tone={r.criticalAlerts > 0 ? 'bad' : 'warn'}>
            {r.criticalAlerts > 0 ? `${r.criticalAlerts} critical · ${r.openAlerts} open` : `${r.openAlerts} open`}
          </ToneBadge>
        ),
      sortValue: (r) => r.criticalAlerts * 100 + r.openAlerts,
    },
    {
      key: 'open',
      header: '',
      align: 'right',
      render: (r) => (
        <Button
          variant="ghost"
          appearance="secondary"
          size="sm"
          trailingIcon={<ArrowUpRight />}
          aria-label={`Open ${r.name} in the lab view`}
          onClick={(e) => {
            e.stopPropagation();
            openLab(r.id);
          }}
        >
          Open
        </Button>
      ),
    },
  ];

  const atRisk = all.filter((r) => r.burn === 'bad' || r.runsOut).length;
  const over = all.filter((r) => r.fair?.status === 'OVER').length;
  const critical = all.filter((r) => r.criticalAlerts > 0).length;
  const avgUtil = all.length ? all.reduce((s, r) => s + r.avgGpuUtil, 0) / all.length : 0;

  return (
    <PageFrame
      title="Labs"
      description="Allocation burn, efficiency, fair share and alerts for every lab; open a lab to see its own view"
      breadcrumbs={[{ label: 'Research Computing', href: '#/admin' }, { label: 'Labs' }]}
      toolbar={
        <>
          <SearchBox value={q} onChange={setQ} label="Search labs" placeholder="Search labs, PIs, departments" />
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'ALL', label: 'All', count: all.length },
              { value: 'AT_RISK', label: 'Budget at risk', count: all.filter((r) => matches(r, 'AT_RISK')).length },
              { value: 'ALERTS', label: 'With alerts', count: all.filter((r) => matches(r, 'ALERTS')).length },
              { value: 'INEFFICIENT', label: 'Low GPU util', count: all.filter((r) => matches(r, 'INEFFICIENT')).length },
            ]}
          />
          {filtered ? <ClearFilters onClick={clear} /> : null}
          <ResultCount>{`${rows.length} ${rows.length === 1 ? 'lab' : 'labs'}`}</ResultCount>
        </>
      }
    >
      {error ? <ErrorState message={`Could not load labs: ${error}`} onRetry={reload} /> : null}

      {loading && !data ? (
        <KpiRowSkeleton />
      ) : data ? (
        <KpiRow>
          <KpiTile label="Labs" value={num(all.length)} caption={`${num(all.reduce((s, r) => s + r.liveJobs, 0))} live jobs across all labs`} />
          <KpiTile label="Allocations at risk" value={num(atRisk)} tone={atRisk ? 'bad' : 'good'} caption="burning faster than time or projected to run out" onClick={() => setFilter('AT_RISK')} />
          <KpiTile label="Over fair share" value={num(over)} tone={over ? 'warn' : 'good'} caption="using > 125% of their target share" />
          <KpiTile label="Average GPU utilization" value={Math.round(avgUtil)} unit="%" tone={utilTone(avgUtil)} caption={`${num(critical)} labs with critical alerts`} onClick={() => setFilter('INEFFICIENT')} />
        </KpiRow>
      ) : null}

      <SectionCard
        flush
        title="Labs"
        actions={
          loading && !data ? (
            <ModelComputing component="AllocationBurnForecaster" verb="is projecting run-out dates" />
          ) : (
            <span className="flex gap-2">
              <ModelProvenance component="AllocationBurnForecaster" compact />
              <ModelProvenance component="LabFairShareAllocator" compact />
            </span>
          )
        }
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading && !data}
          onRowClick={(r) => openLab(r.id)}
          initialSort={{ key: 'alerts', dir: 'desc' }}
          emptyLabel={filtered ? 'No labs match these filters' : 'No labs yet'}
          emptyAction={filtered ? <ClearFilters onClick={clear} /> : undefined}
        />
      </SectionCard>
    </PageFrame>
  );
}
