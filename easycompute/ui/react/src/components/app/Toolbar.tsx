/*
 * EasyCompute design system — toolbar pieces in the mockups' style: search input, segmented filter (".seg" with
 * count chips), select pill ("Cluster: All ▾"), clear filters, result count, and underline page tabs.
 * Pass them to `<PageFrame toolbar={...}>` / `<PageFrame tabs={...}>`. No filter cards.
 */

import React, { type ReactNode } from 'react';
import { ChevronDown, FilterX, Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';

export function SearchBox({ value, onChange, placeholder = 'Search', label, className }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string; className?: string }) {
  return (
    <label className={cn('flex h-[34px] w-full min-w-0 items-center gap-2 rounded-lg border border-[var(--ec-line-2)] px-2.5 text-[var(--ec-fg-3)] focus-within:border-[var(--ec-fg-3)] sm:w-80', className)}>
      <Search className="size-3.5 shrink-0" aria-hidden />
      <input
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ec-fg-hi)] outline-none placeholder:text-[var(--ec-fg-3)] focus-visible:outline-none"
      />
      {value ? (
        <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="rounded p-0.5 hover:text-[var(--ec-fg-hi)]">
          <X className="size-3.5" />
        </button>
      ) : (
        <span className="rounded bg-[var(--ec-card-2)] px-1.5 text-[11px] font-medium text-[#bababa]">/</span>
      )}
    </label>
  );
}

export interface SegmentOption {
  value: string;
  label: string;
  count?: number;
}

/** Segmented filter (mockup ".seg"): active = green-tinted, counts in small chips. */
export function Segmented({ value, onChange, options, label, className }: { value: string; onChange: (v: string) => void; options: SegmentOption[]; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex max-w-full flex-wrap items-center gap-1', className)}>
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
              'inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-sm font-medium whitespace-nowrap transition-colors',
              active ? 'bg-[var(--ec-accent-bg)] text-[var(--ec-fg-hi)]' : 'text-[var(--ec-fg)] hover:bg-[var(--ec-card)]',
            )}
          >
            {o.label}
            {o.count != null ? (
              <span className={cn('rounded-full px-[7px] text-xs leading-5 tabular-nums', active ? 'bg-[var(--ec-accent-line)] text-[var(--ec-accent-hi)]' : 'bg-[var(--ec-card-2)] text-[var(--ec-fg)]')}>
                {o.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Select pill (mockup ".pill"): "Cluster: All ▾" backed by a native select (keyboard + screen-reader friendly). */
export function SelectPill({ label, value, onChange, options, icon }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; icon?: ReactNode }) {
  return (
    <label className="relative inline-flex h-[34px] items-center gap-2 rounded-md border border-[var(--ec-line-2)] pr-7 pl-2.5 text-sm font-medium whitespace-nowrap hover:bg-[var(--ec-card)]">
      {icon ? <span className="text-[var(--ec-fg-2)] [&_svg]:size-3.5">{icon}</span> : null}
      <span className="text-[var(--ec-fg-2)]">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer appearance-none bg-transparent text-[var(--ec-fg-hi)] outline-none focus-visible:outline-none [&>option]:bg-[var(--ec-card)]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 size-3.5 text-[var(--ec-fg-2)]" aria-hidden />
    </label>
  );
}

export function ClearFilters({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-[var(--ec-fg-2)] hover:bg-[var(--ec-card)] hover:text-[var(--ec-fg-hi)]">
      <FilterX className="size-3.5" aria-hidden />
      Clear filters
    </button>
  );
}

/** Right-aligned "12 policies" count. */
export function ResultCount({ children }: { children: ReactNode }) {
  return <span className="ml-auto text-[13px] tabular-nums text-[var(--ec-fg-2)]">{children}</span>;
}

export interface PageTab {
  value: string;
  label: ReactNode;
}

/** Underline tabs (mockup ".tabs"): 28px gaps, active tab white with a 2px green underline. */
export function PageTabs({ tabs, value, onChange, label = 'Sections' }: { tabs: PageTab[]; value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-7 overflow-x-auto border-b border-[var(--ec-line)]">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={cn(
              '-mb-px border-b-2 pt-3 pb-[13px] text-sm font-medium whitespace-nowrap',
              active ? 'border-[var(--ec-accent-hi)] text-[var(--ec-fg-hi)]' : 'border-transparent text-[var(--ec-fg-2)] hover:text-[var(--ec-fg)]',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
