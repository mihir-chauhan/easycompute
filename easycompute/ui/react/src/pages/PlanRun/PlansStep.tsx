/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useMemo } from 'react';
import { ArrowLeft, ArrowRight, CircleCheck, CircleX, Gauge, PiggyBank, Scale, Zap } from 'lucide-react';

import EChart from '@/components/charts/EChart';
import { EnumBadge } from '@/components/StatusBadges/StatusBadges';
import { Button } from '@/components/ui/button';
import { Container } from '@/components/ui/container';
import { hBarOption } from '@/features/lab/charts';
import { EmptyBlock, muted, Stat } from '@/features/lab/components';
import { formatDuration, formatInt, formatUsd } from '@/features/lab/format';
import type { RunPlan } from '@/features/lab/types';
import { chartColor } from '@/lib/format';
import { cn } from '@/lib/utils';

const LABEL_ICON: Record<string, React.ReactNode> = {
  Fastest: <Zap className="size-4" aria-hidden />,
  Cheapest: <PiggyBank className="size-4" aria-hidden />,
  Balanced: <Scale className="size-4" aria-hidden />,
};

interface Props {
  plans: RunPlan[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  deadline?: string;
  onBack: () => void;
  onNext: () => void;
}

export default function PlansStep({ plans, selectedId, onSelect, deadline, onBack, onNext }: Props) {
  const deadlineH = deadline ? (new Date(deadline).getTime() - Date.now()) / 3600000 : null;
  const recommended = plans.find((p) => p.label === 'Balanced')?.id ?? plans[0]?.id;

  const timelineOption = useMemo(() => {
    const names = plans.map((p) => p.label ?? `Plan ${p.rank}`);
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? formatDuration(v) : '—'),
      },
      legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 4 },
      grid: { left: 8, right: 24, top: 32, bottom: 8, containLabel: true },
      xAxis: { type: 'value', name: 'hours from now', nameLocation: 'end', nameGap: 4, nameTextStyle: { align: 'right', verticalAlign: 'top', padding: [24, 0, 0, 0] }, axisLabel: { formatter: (v: number) => `${v}h` } },
      yAxis: { type: 'category', inverse: true, data: names, axisTick: { show: false } },
      series: [
        { name: 'Queue wait', type: 'bar', stack: 't', barMaxWidth: 18, itemStyle: { color: chartColor('secondary') }, data: plans.map((p) => +(p.estWaitHours ?? 0).toFixed(2)) },
        {
          name: 'Run',
          type: 'bar',
          stack: 't',
          barMaxWidth: 18,
          data: plans.map((p) => ({ value: +(p.estDurationHours ?? 0).toFixed(2), itemStyle: { color: chartColor(p.meetsDeadline === false ? 'danger' : 'accent'), borderRadius: [0, 2, 2, 0] } })),
          markLine:
            deadlineH != null && deadlineH > 0
              ? {
                  symbol: 'none',
                  silent: true,
                  data: [{ xAxis: +deadlineH.toFixed(1), label: { formatter: 'Deadline', position: 'end', color: chartColor('danger') }, lineStyle: { color: chartColor('danger'), type: 'dashed' } }],
                }
              : undefined,
        },
      ],
    };
  }, [plans, deadlineH]);

  const costOption = useMemo(
    () => hBarOption(plans.map((p) => ({ label: p.label ?? `Plan ${p.rank}`, value: p.estCostUsd ?? 0, appearance: p.id === selectedId ? 'accent' : 'secondary' })), (v) => formatUsd(v)),
    [plans, selectedId],
  );

  if (plans.length === 0) {
    return (
      <Container>
        <EmptyBlock
          label="No feasible plan satisfies the blocking rules. Relax the walltime, GPU count or deadline and try again."
          action={
            <Button variant="outline" appearance="secondary" leadingIcon={<ArrowLeft />} onClick={onBack}>
              Back to rule checks
            </Button>
          }
        />
      </Container>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Recommended plans" className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {plans.map((p) => {
          const selected = p.id === selectedId;
          const finishH = (p.estWaitHours ?? 0) + (p.estDurationHours ?? 0);
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelect(p.id)}
              className={cn(
                'flex flex-col gap-4 rounded-[var(--c3-style-border-radius-8)] border bg-[var(--c3-style-basic-bg-primary)] p-5 text-left shadow-[0_1px_2px_rgb(0_0_0/5%)] transition-colors',
                selected
                  ? 'border-[var(--c3-style-basic-border-accent)] ring-1 ring-[var(--c3-style-basic-border-accent)]'
                  : 'border-[var(--c3-style-basic-border-primary)] hover:border-[var(--c3-style-basic-border-accent)]',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-c3-bold-body-p1 text-[var(--c3-style-basic-fg-primary)]">
                  <span className="text-[var(--c3-style-basic-fg-accent)]">{LABEL_ICON[p.label ?? ''] ?? <Gauge className="size-4" aria-hidden />}</span>
                  {p.label ?? `Plan ${p.rank}`}
                </span>
                <span className="flex gap-1">
                  {p.id === recommended && <EnumBadge value="Recommended" appearance="accent" />}
                  {p.meetsDeadline != null && (
                    <EnumBadge value={p.meetsDeadline ? 'Meets deadline' : 'Misses deadline'} appearance={p.meetsDeadline ? 'success' : 'danger'} />
                  )}
                </span>
              </span>

              <span className="flex flex-col">
                <span className="text-xl font-semibold text-[var(--c3-style-basic-fg-primary)]">
                  {p.cluster?.name ?? p.cluster?.id} <span className={`font-normal ${muted}`}>/ {p.partition?.name ?? p.partition?.id}</span>
                </span>
                <span className={`text-c3-regular-body-p2 ${muted}`}>
                  {`${p.gpus ?? 0}× ${p.gpuType?.id ?? 'CPU'} · ${p.nodes ?? 1} node${(p.nodes ?? 1) > 1 ? 's' : ''} · ${formatDuration(p.walltimeHours)} walltime`}
                </span>
              </span>

              <span className="grid grid-cols-3 gap-3 border-y border-[var(--c3-style-basic-border-primary)] py-3">
                <Stat label="Starts in" value={formatDuration(p.estWaitHours)} />
                <Stat label="Runs for" value={formatDuration(p.estDurationHours)} />
                <Stat label="Done in" value={formatDuration(finishH)} />
                <Stat label="Cost" value={formatUsd(p.estCostUsd)} sub={p.estCostUnits != null ? `${formatInt(p.estCostUnits)} units` : undefined} className="col-span-2" />
                <Stat label="Score" value={p.score != null ? formatInt(p.score * 100) : '—'} />
              </span>

              {p.rationale && <span className={`text-c3-regular-body-p2 ${muted}`}>{p.rationale}</span>}

              <span className={cn('mt-auto flex items-center gap-2 text-c3-bold-body-p2', selected ? 'text-[var(--c3-style-basic-fg-accent)]' : muted)}>
                {selected ? <CircleCheck className="size-4" aria-hidden /> : <CircleX className="size-4 opacity-0" aria-hidden />}
                {selected ? 'Selected' : 'Select this plan'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Container className="xl:col-span-2" title="Time to results" subtitle="Queue wait plus predicted runtime against the deadline">
          <EChart ariaLabel="Plan timeline comparison" option={timelineOption} className="h-56" />
        </Container>
        <Container title="Cost" subtitle="USD equivalent incl. QOS charge factor">
          <EChart ariaLabel="Plan cost comparison" option={costOption} className="h-56" />
        </Container>
      </div>

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" appearance="secondary" leadingIcon={<ArrowLeft />} onClick={onBack}>
          Rule checks
        </Button>
        <Button trailingIcon={<ArrowRight />} disabled={!selectedId} onClick={onNext}>
          Review &amp; submit
        </Button>
      </div>
    </div>
  );
}
