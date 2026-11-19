/*
 * EasyCompute design system — SectionCard (the one card style) and the dashboard Grid helper.
 */

import React, { type ReactNode } from 'react';

import { Container } from '@/components/ui/container';
import { cn } from '@/lib/utils';

interface SectionCardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Body flush to the card edges (tables, lists). Header/footer keep padding and get dividers. */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

/** White card, 1px border, 8px radius, 20px padding, 15px semibold title + muted subtitle. */
export function SectionCard({ title, subtitle, actions, footer, flush, className, children }: SectionCardProps) {
  return (
    <Container
      title={title}
      subtitle={subtitle}
      actions={actions}
      footer={footer}
      contentWidth={flush ? 'full-width' : 'contained'}
      className={cn('min-w-0', className)}
    >
      {children}
    </Container>
  );
}

type Layout = 'halves' | 'thirds' | 'two-one' | 'one-two' | 'quarters';

const LAYOUT: Record<Layout, string> = {
  halves: 'lg:grid-cols-2',
  thirds: 'lg:grid-cols-3',
  'two-one': 'lg:grid-cols-3 lg:[&>*:first-child]:col-span-2',
  'one-two': 'lg:grid-cols-3 lg:[&>*:last-child]:col-span-2',
  quarters: 'sm:grid-cols-2 xl:grid-cols-4',
};

/** Dashboard row: stacks below 1024px; `two-one` = 2/3 + 1/3. Cards in a row stretch to equal height. */
export function CardGrid({ layout = 'halves', className, children }: { layout?: Layout; className?: string; children: ReactNode }) {
  return <div className={cn('grid grid-cols-1 items-stretch gap-4', LAYOUT[layout], className)}>{children}</div>;
}
