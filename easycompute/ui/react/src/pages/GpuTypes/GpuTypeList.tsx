/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FilterX } from 'lucide-react';

import { c3Call } from '@/c3Action';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import PageFrame, { EmptyRows, errorMessage, ErrorState } from '@/components/PageFrame/PageFrame';
import { Button } from '@/components/ui/button';
import { Container } from '@/components/ui/container';
import { DataGrid, DataGridBody, DataGridCell, DataGridHead, DataGridHeader, DataGridRow } from '@/components/ui/data-grid';
import { InputSearch } from '@/components/ui/input-search';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { type FetchResult, type GpuType } from '@/Interfaces';
import { filterLiteral, formatCurrency, formatNumber } from '@/lib/format';

const PAGE_SIZE_OPTIONS = [10, 20, 50];

const SORT_FIELDS = ['name', 'vendor', 'memoryGb', 'relativeThroughput', 'costPerGpuHourUsd'] as const;
type SortField = (typeof SORT_FIELDS)[number];

const LIST_INCLUDE = 'id, name, vendor, memoryGb, relativeThroughput, costPerGpuHourUsd';

const GpuTypeList: React.FC = () => {
  const { reportError } = useErrorBoundary();
  const [params, setParams] = useSearchParams();

  const query = params.get('q') ?? '';
  const sortParam = params.get('sort');
  // Only known columns: an unknown ?sort= would make the server reject the whole fetch.
  const sortField: SortField = SORT_FIELDS.find((f) => f === sortParam) ?? 'name';
  const sortDir: 'asc' | 'desc' = params.get('dir') === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(params.get('size'))) ? Number(params.get('size')) : 20;

  const [searchText, setSearchText] = useState(query);
  const [rows, setRows] = useState<GpuType[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const updateParams = useCallback(
    (changes: Record<string, string | null>, resetPage = true) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          Object.entries(changes).forEach(([k, v]) => {
            if (v == null || v === '') next.delete(k);
            else next.set(k, v);
          });
          if (resetPage) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Debounce the search box into the URL.
  useEffect(() => {
    if (searchText === query) return undefined;
    const handle = window.setTimeout(() => updateParams({ q: searchText.trim() || null }), 300);
    return () => window.clearTimeout(handle);
  }, [searchText, query, updateParams]);

  const filter = useMemo(() => {
    const clauses: string[] = [];
    if (query) {
      const q = filterLiteral(query.toLowerCase());
      clauses.push(`(contains(lowerCase(name), ${q}))`);
    }
    return clauses.join(' && ');
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const spec = {
      include: LIST_INCLUDE,
      order: `${sortDir === 'asc' ? 'ascending' : 'descending'}(${sortField}), id`,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      ...(filter ? { filter } : {}),
    };
    Promise.all([
      c3Call('GpuType', 'fetch', null, [spec]) as Promise<FetchResult<GpuType>>,
      c3Call('GpuType', 'fetchCount', null, [filter ? { filter } : {}]) as Promise<number>,
    ])
      .then(([res, count]) => {
        if (cancelled) return;
        setRows(res.objs ?? []);
        setTotal(count ?? 0);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err));
        reportError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, sortField, sortDir, page, pageSize, reloadKey, reportError]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const headProps = (field: SortField) => ({
    sortable: true,
    filterable: false,
    sortDirection: sortField === field ? sortDir : (null as 'asc' | 'desc' | null),
    onSort: () => updateParams({ sort: field, dir: sortField === field && sortDir === 'desc' ? 'asc' : 'desc' }, true),
  });

  const hasFilters = Boolean(query);

  const clearFilters = () => {
    setSearchText('');
    setParams(new URLSearchParams(), { replace: true });
  };

  return (
    <PageFrame
      title="GPU Types"
      description="Search, filter, and manage gpu types"
      breadcrumbs={[{ label: 'GPU Types' }]}
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full md:w-72">
            <InputSearch
              size="sm"
              aria-label="Search gpu types"
              placeholder="Search name"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onClear={() => {
                setSearchText('');
                updateParams({ q: null });
              }}
            />
          </div>
          {hasFilters && (
            <Button variant="ghost" appearance="secondary" size="sm" leadingIcon={<FilterX />} onClick={clearFilters}>
              Clear
            </Button>
          )}
          <span className="ml-auto flex items-center gap-2 text-c3-regular-body-p2 tabular-nums text-[var(--c3-style-basic-fg-secondary)]">
            {loading && <Spinner size="sm" />}
            {`${total.toLocaleString('en-US')} ${total === 1 ? 'gpu type' : 'gpu types'}`}
          </span>
        </div>
      </div>

      {error && <ErrorState message={`Could not load gpu types: ${error}`} onRetry={() => setReloadKey((k) => k + 1)} />}

      <Container
        contentWidth="full-width"
        footer={
          <Pagination
            type="full"
            page={Math.min(page, pageCount)}
            pageCount={pageCount}
            totalItems={total}
            pageSize={pageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageChange={(p) => updateParams({ page: String(p) }, false)}
            onPageSizeChange={(s) => updateParams({ size: String(s) })}
          />
        }
      >
        <div className="overflow-x-auto">
          <DataGrid className="app-table w-full">
            <DataGridHeader>
              <DataGridRow>
                <DataGridHead {...headProps('name')}>Name</DataGridHead>
                <DataGridHead {...headProps('vendor')}>Vendor</DataGridHead>
                <DataGridHead {...headProps('memoryGb')} align="right">Memory Gb</DataGridHead>
                <DataGridHead {...headProps('relativeThroughput')} align="right">Relative Throughput</DataGridHead>
                <DataGridHead {...headProps('costPerGpuHourUsd')} align="right">Cost Per Gpu Hour Usd</DataGridHead>
              </DataGridRow>
            </DataGridHeader>
            <DataGridBody>
              {!loading && !error && rows.length === 0 && (
                <EmptyRows
                  colSpan={5}
                  label={hasFilters ? "No gpu types match these filters." : "No gpu types yet."}
                  action={
                    hasFilters ? (
                      <Button variant="outline" appearance="secondary" size="sm" leadingIcon={<FilterX />} onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              )}
              {rows.map((r) => (
                <DataGridRow key={r.id}>
                  <DataGridCell className="whitespace-nowrap">{r.name ?? '—'}</DataGridCell>
                  <DataGridCell className="max-w-48 truncate">{r.vendor ?? '—'}</DataGridCell>
                  <DataGridCell className="whitespace-nowrap tabular-nums" align="right">{formatNumber(r.memoryGb)}</DataGridCell>
                  <DataGridCell className="whitespace-nowrap tabular-nums" align="right">{formatNumber(r.relativeThroughput)}</DataGridCell>
                  <DataGridCell className="whitespace-nowrap tabular-nums" align="right">{formatCurrency(r.costPerGpuHourUsd)}</DataGridCell>
                </DataGridRow>
              ))}
            </DataGridBody>
          </DataGrid>
        </div>
      </Container>
    </PageFrame>
  );
};

export default GpuTypeList;
