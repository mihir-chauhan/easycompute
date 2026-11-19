/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React from 'react';

export interface BarListItem {
  key: string;
  label: string;
  value: number;
  /** Bar color (a resolved CSS color, e.g. from `chartColor()`). */
  color: string;
}

interface BarListProps {
  items: BarListItem[];
  /** Formats the value column. */
  format?: (value: number) => string;
  /** Show each item's share of the total next to the value. */
  showShare?: boolean;
  onItemClick?: (item: BarListItem) => void;
}

/** Ranked list of label, value and a thin proportional bar: a quieter alternative to a donut or bar chart. */
export default function BarList({ items, format = (v) => v.toLocaleString('en-US'), showShare = true, onItemClick }: BarListProps) {
  const total = items.reduce((sum, i) => sum + i.value, 0);
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => {
        const body = (
          <>
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">{item.label}</span>
              <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
                <span className="text-c3-bold-body-p2 text-[var(--c3-style-basic-fg-primary)]">{format(item.value)}</span>
                {showShare && (
                  <span className="w-9 text-right text-xs text-[var(--c3-style-basic-fg-secondary)]">
                    {total > 0 ? `${Math.round((item.value / total) * 100)}%` : '—'}
                  </span>
                )}
              </span>
            </span>
            <span className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-[var(--c3-style-basic-bg-secondary)]">
              <span className="block h-full rounded-full" style={{ width: `${(item.value / max) * 100}%`, backgroundColor: item.color }} />
            </span>
          </>
        );
        return (
          <li key={item.key}>
            {onItemClick ? (
              <button type="button" className="block w-full rounded-sm text-left hover:opacity-80" onClick={() => onItemClick(item)}>
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
