/*
 * EasyCompute design system — cluster identity dot + name, billing chip.
 */

import React from 'react';

import { cn } from '@/lib/utils';

import { BILLING_BG, BILLING_SHORT, CLUSTER_BG, type Billing } from './tone';

/** Cluster colour dot followed by its name: `<ClusterTag id="gilbreth" name="Gilbreth" />`. */
export function ClusterTag({ id, name, className }: { id?: string | null; name?: string | null; className?: string }) {
  if (!id && !name) return <span className="text-[var(--c3-style-basic-fg-secondary)]">—</span>;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', (id && CLUSTER_BG[id]) || 'bg-[var(--ec-ink)]')} />
      <span className="truncate">{name ?? id}</span>
    </span>
  );
}

/** Billing model chip (In-house / ACCESS / Third-party) with its swatch. */
export function BillingTag({ billing, className }: { billing?: string | null; className?: string }) {
  if (!billing || !(billing in BILLING_SHORT)) return <span className="text-[var(--c3-style-basic-fg-secondary)]">—</span>;
  const b = billing as Billing;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded border border-[var(--c3-style-basic-border-border)] px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-[var(--c3-style-basic-fg-primary)]',
        className,
      )}
    >
      <span aria-hidden className={cn('inline-block size-2 rounded-[2px]', BILLING_BG[b])} />
      {BILLING_SHORT[b]}
    </span>
  );
}
