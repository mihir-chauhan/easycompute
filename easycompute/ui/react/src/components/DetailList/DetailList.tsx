/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface DetailItem {
  label: string;
  value: ReactNode;
}

/** Label / value grid used on detail pages. */
export default function DetailList({ items, columns = 2 }: { items: DetailItem[]; columns?: 1 | 2 | 3 }) {
  return (
    <dl
      className={cn(
        'grid grid-cols-1 gap-x-6 gap-y-4',
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 flex-col gap-1">
          <dt className="text-c3-regular-label-l3 text-[var(--c3-style-basic-fg-secondary)]">{item.label}</dt>
          <dd className="min-w-0 break-words text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">
            {item.value ?? '—'}
          </dd>
        </div>
      ))}
    </dl>
  );
}
