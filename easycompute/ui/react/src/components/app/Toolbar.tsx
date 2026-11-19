/*
 * EasyCompute design system — one-row filter toolbar pieces: search box, segmented filter, result count.
 * Pass them to `<PageFrame toolbar={...}>`. No filter cards.
 */

import React, { type ReactNode } from 'react';
import { FilterX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { InputSearch } from '@/components/ui/input-search';
import { cn } from '@/lib/utils';

export function SearchBox({ value, onChange, placeholder = 'Search', label }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string }) {
  return (
    <div className="w-full sm:w-72">
      <InputSearch size="sm" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} onClear={() => onChange('')} />
    </div>
  );
}

export interface SegmentOption {
  value: string;
  label: string;
  count?: number;
}

/** Compact segmented control (filters such as All / Block / Warn / Info). */
export function Segmented({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: SegmentOption[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md bg-[var(--c3-style-basic-bg-secondary)] p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors',
              active
                ? 'bg-[var(--c3-style-basic-bg-primary)] text-[var(--c3-style-basic-fg-primary)] shadow-sm'
                : 'text-[var(--c3-style-basic-fg-secondary)] hover:text-[var(--c3-style-basic-fg-primary)]',
            )}
          >
            {o.label}
            {o.count != null ? <span className="tabular-nums text-xs text-[var(--c3-style-basic-fg-secondary)]">{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function ClearFilters({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" appearance="secondary" size="sm" leadingIcon={<FilterX />} onClick={onClick}>
      Clear filters
    </Button>
  );
}

/** Right-aligned "12 policies" count. */
export function ResultCount({ children }: { children: ReactNode }) {
  return <span className="ml-auto text-[13px] tabular-nums text-[var(--c3-style-basic-fg-secondary)]">{children}</span>;
}
