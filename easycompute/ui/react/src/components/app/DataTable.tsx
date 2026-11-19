/*
 * EasyCompute design system — DataTable: client-side sortable table on the vendored DataGrid.
 * For bounded lists already fetched (<= a few hundred rows). For large server-paged lists, follow
 * pages/GpuTypes/GpuTypeList.tsx (fetch with limit/offset + Pagination).
 */

import React, { useMemo, useState, type ReactNode } from 'react';

import { DataGrid, DataGridBody, DataGridCell, DataGridHead, DataGridHeader, DataGridRow } from '@/components/ui/data-grid';
import { Pagination } from '@/components/ui/pagination';
import { cn } from '@/lib/utils';

import { EmptyState, TableSkeleton } from './PageStates';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Cell content. Default: String(row[key]). */
  render?: (row: T) => ReactNode;
  /** Value used for sorting; omit to make the column unsortable. */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right';
  /** Extra classes for the cells (width, truncate). */
  className?: string;
  /** Hide below this breakpoint to avoid horizontal scroll on phones. */
  hideBelow?: 'sm' | 'md' | 'lg';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  /** Empty-state title and optional action (e.g. a "Clear filters" button). */
  emptyLabel?: string;
  emptyHint?: ReactNode;
  emptyAction?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  /** Client-side page size; omit for no pagination. */
  pageSize?: number;
  className?: string;
}

const HIDE: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

/** 40px rows, single-line cells, right-aligned tabular numbers, row click opens detail. Put it in `<SectionCard flush>`. */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, loading, emptyLabel = 'Nothing here yet.', emptyHint, emptyAction, initialSort, pageSize, className }: DataTableProps<T>) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort, columns]);

  const pageCount = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount);
  const visible = pageSize ? sorted.slice((safePage - 1) * pageSize, safePage * pageSize) : sorted;

  if (loading) return <TableSkeleton />;

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <div className="overflow-x-auto">
        <DataGrid className="w-full">
          <DataGridHeader>
            <DataGridRow>
              {columns.map((c) => (
                <DataGridHead
                  key={c.key}
                  align={c.align}
                  filterable={false}
                  sortable={Boolean(c.sortValue)}
                  sortDirection={sort?.key === c.key ? sort.dir : null}
                  onSort={() => {
                    setPage(1);
                    setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }));
                  }}
                  className={cn('whitespace-nowrap', c.hideBelow && HIDE[c.hideBelow])}
                >
                  {c.header}
                </DataGridHead>
              ))}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody>
            {visible.map((row) => (
              <DataGridRow
                key={rowKey(row)}
                data-clickable={onRowClick ? 'true' : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row) : undefined}
              >
                {columns.map((c) => (
                  <DataGridCell
                    key={c.key}
                    align={c.align}
                    className={cn('whitespace-nowrap', c.align === 'right' && 'tabular-nums', c.hideBelow && HIDE[c.hideBelow], c.className)}
                  >
                    {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '—')}
                  </DataGridCell>
                ))}
              </DataGridRow>
            ))}
          </DataGridBody>
        </DataGrid>
      </div>
      {rows.length === 0 ? <EmptyState title={emptyLabel} hint={emptyHint} action={emptyAction} /> : null}
      {pageSize && rows.length > pageSize ? (
        <div className="border-t border-[var(--c3-style-basic-border-border)] px-5 py-2.5">
          <Pagination type="full" page={safePage} pageCount={pageCount} totalItems={rows.length} pageSize={pageSize} onPageChange={setPage} />
        </div>
      ) : null}
    </div>
  );
}
