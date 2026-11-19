/*
 * EasyCompute design system — loading skeletons, empty state, error state.
 * ErrorState / LoadingState / errorMessage live in PageFrame and are re-exported here so pages import one place.
 */

import React, { type ReactNode } from 'react';
import { Inbox } from 'lucide-react';

import { cn } from '@/lib/utils';

export { ErrorState, LoadingState, errorMessage } from '@/components/PageFrame/PageFrame';

/** Grey shimmering block; size it with Tailwind (`h-4 w-32`). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('ec-skeleton', className)} />;
}

/** Skeleton matching a KPI row of `count` tiles. */
export function KpiRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg bg-[var(--ec-card)] px-4 py-3.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-3 w-36" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton for a chart card body. */
export function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('flex h-72 items-end gap-3 px-2 pb-2', className)} aria-busy="true" aria-label="Loading chart">
      {[55, 80, 40, 92, 66, 74, 48, 85].map((h, i) => (
        <Skeleton key={i} className={cn('flex-1', ['h-[55%]', 'h-[80%]', 'h-[40%]', 'h-[92%]', 'h-[66%]', 'h-[74%]', 'h-[48%]', 'h-[85%]'][i])} />
      ))}
    </div>
  );
}

/** Skeleton rows for a table card body. */
export function TableSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col', className)} aria-busy="true" aria-label="Loading rows">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-4 border-b border-[var(--ec-line)] px-4 last:border-b-0">
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-3 w-1/6" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Centred icon, one-line title, muted hint and optional action ("Clear filters"). */
export function EmptyState({ icon, title, hint, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
      <span className="mb-1 inline-flex size-10 items-center justify-center rounded-full bg-[var(--ec-card-2)] text-[var(--ec-fg-2)] [&_svg]:size-5">
        {icon ?? <Inbox aria-hidden />}
      </span>
      <p className="text-sm font-medium text-[var(--ec-fg-hi)]">{title}</p>
      {hint ? <p className="max-w-sm text-[13px] text-[var(--c3-style-basic-fg-secondary)]">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
